<!--
Generated from the uploaded service specification and converted to an
OpenCode-backed Twinpod design. The conversion keeps the tracker/orchestrator/workspace model and replaces
the previous agent-server assumptions with a long-lived OpenCode server runtime.
-->

# Twinpod Service Specification

Status: Draft v1 (OpenCode-backed, language-agnostic)

Purpose: Define a service that orchestrates OpenCode-backed coding agents to get project work done.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and
`OPTIONAL` in this document are to be interpreted as described in RFC 2119.

`Implementation-defined` means the behavior is part of the implementation contract, but this
specification does not prescribe one universal policy. Implementations MUST document the selected
behavior.

## 1. Problem Statement

Twinpod is a long-running automation service that continuously reads work from an issue tracker
(Linear in this specification version), creates an isolated workspace for each issue, and runs a
coding agent session for that issue inside the workspace.

The service solves four operational problems:

- It turns issue execution into a repeatable daemon workflow instead of manual scripts.
- It isolates agent execution in per-issue workspaces so agent commands run only inside per-issue
  workspace directories.
- It keeps the workflow policy in-repo (`WORKFLOW.md`) so teams version the agent prompt and runtime
  settings with their code.
- It provides enough observability to operate and debug multiple concurrent agent runs.

Implementations are expected to document their trust and safety posture explicitly. This
specification does not require a single approval, sandbox, or operator-confirmation policy; some
implementations target trusted environments with a high-trust configuration, while others require
stricter approvals or sandboxing.

Important boundary:

- Twinpod is a scheduler/runner and tracker reader.
- Ticket writes (state transitions, comments, PR links) are typically performed by the coding agent
  using tools available in the workflow/runtime environment.
- A successful run can end at a workflow-defined handoff state (for example `Human Review`), not
  necessarily `Done`.

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll the issue tracker on a fixed cadence and dispatch work with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Create deterministic per-issue workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
- Expose operator-visible observability (at minimum structured logs).
- Support tracker/filesystem-driven restart recovery without requiring a persistent database; exact
  in-memory scheduler state is not restored.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane.
- Prescribing a specific dashboard or terminal UI implementation.
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to edit tickets, PRs, or comments. (That logic lives in the
  workflow prompt and agent tooling.)
- Mandating strong sandbox controls beyond what the coding agent and host OS provide.
- Mandating a single default approval, sandbox, or operator-confirmation posture for all
  implementations.

## 3. System Overview

### 3.1 Main Components

1. `Workflow Loader`
   - Reads `WORKFLOW.md`.
   - Parses YAML front matter and prompt body.
   - Returns `{config, prompt_template}`.

2. `Config Layer`
   - Exposes typed getters for workflow config values.
   - Applies defaults and environment variable indirection.
   - Performs validation used by the orchestrator before dispatch.

3. `Issue Tracker Client`
   - Fetches candidate issues in active states.
   - Fetches current states for specific issue IDs (reconciliation).
   - Fetches terminal-state issues during startup cleanup.
   - Normalizes tracker payloads into a stable issue model.

4. `Orchestrator`
   - Owns the poll tick.
   - Owns the in-memory runtime state.
   - Decides which issues to dispatch, retry, stop, or release.
   - Tracks session metrics and retry queue state.

5. `Workspace Manager`
   - Maps issue identifiers to workspace paths.
   - Ensures per-issue workspace directories exist.
   - Runs workspace lifecycle hooks.
   - Cleans workspaces for terminal issues.

6. `Agent Runner`
   - Creates workspace.
   - Builds prompt from issue + workflow template.
   - Uses the long-lived OpenCode server client.
   - Streams agent updates back to the orchestrator.

7. `Status Surface` (OPTIONAL)
   - Presents human-readable runtime status (for example terminal output, dashboard, or other
     operator-facing view).

8. `Logging`
   - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

Twinpod is easiest to port when kept in these layers:

1. `Policy Layer` (repo-defined)
   - `WORKFLOW.md` prompt body.
   - Team-specific rules for ticket handling, validation, and handoff.

2. `Configuration Layer` (typed getters)
   - Parses front matter into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. `Coordination Layer` (orchestrator)
   - Polling loop, issue eligibility, concurrency, retries, reconciliation.

4. `Execution Layer` (workspace + OpenCode server session)
   - Filesystem lifecycle, workspace preparation, and OpenCode server session control.

5. `Integration Layer` (Linear adapter)
   - API calls and normalization for tracker data.

6. `Observability Layer` (logs + OPTIONAL status surface)
   - Operator visibility into orchestrator and agent behavior.

### 3.3 External Dependencies

- Issue tracker API (Linear for `tracker.kind: linear` in this specification version).
- Local filesystem for workspaces, logs, and generated OpenCode config bundles.
- OPTIONAL workspace population tooling (for example Git CLI, if used).
- OpenCode executable (`opencode`) installed on each worker host.
- A long-lived OpenCode headless server started with `opencode serve` and controlled through the
  OpenCode server HTTP API and event stream exposed by that OpenCode version.
- Host environment authentication for the issue tracker and OpenCode model providers.
- OPTIONAL OpenCode project files such as `opencode.json`, `opencode.jsonc`, `.opencode/agents/*`,
  `.opencode/plugins/*`, `.opencode/tools/*`, MCP configuration, formatter/LSP configuration, and
  `AGENTS.md`.

Notes:

- `WORKFLOW.md` remains Twinpod's scheduler/orchestration contract.
- OpenCode config SHOULD be used for model/provider selection, permission rules, agent definitions,
  plugin hooks, custom tools, MCP servers, LSP/formatter settings, watcher ignores, compaction, and
  other OpenCode-native behavior.
- Twinpod MUST NOT start a fresh OpenCode runtime for every issue attempt. The OpenCode server is a
  long-lived worker-host resource that is reused across issue sessions until it exits, becomes
  unhealthy, or the operator restarts it.

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Issue

Normalized issue record used by orchestration, prompt rendering, and observability output.

Fields:

- `id` (string)
  - Stable tracker-internal ID.
- `identifier` (string)
  - Human-readable ticket key (example: `ABC-123`).
- `title` (string)
- `description` (string or null)
- `priority` (integer or null)
  - Lower numbers are higher priority in dispatch sorting.
- `state` (string)
  - Current tracker state name.
- `branch_name` (string or null)
  - Tracker-provided branch metadata if available.
- `url` (string or null)
- `labels` (list of strings)
  - Normalized to lowercase.
- `blocked_by` (list of blocker refs)
  - Each blocker ref contains:
    - `id` (string or null)
    - `identifier` (string or null)
    - `state` (string or null)
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 4.1.2 Workflow Definition

Parsed `WORKFLOW.md` payload:

- `config` (map)
  - YAML front matter root object.
- `prompt_template` (string)
  - Markdown body after front matter, trimmed.

#### 4.1.3 Service Config (Typed View)

Typed runtime values derived from `WorkflowDefinition.config` plus environment resolution.

Examples:

- poll interval
- workspace root
- active and terminal issue states
- concurrency limits
- OpenCode server, pipeline, permission, and timeout settings
- workspace hooks

#### 4.1.4 Workspace

Filesystem workspace assigned to one issue identifier.

Fields (logical):

- `path` (absolute workspace path)
- `workspace_key` (sanitized issue identifier)
- `created_now` (boolean, used to gate `after_create` hook)

#### 4.1.5 Run Attempt

One execution attempt for one issue.

Fields (logical):

- `issue_id`
- `issue_identifier`
- `attempt` (integer or null, `null` for first run, `>=1` for retries/continuation)
- `workspace_path`
- `started_at`
- `status`
- `error` (OPTIONAL)

#### 4.1.6 Live Session (OpenCode Server Session Metadata)

State tracked while a Twinpod worker is using the long-lived OpenCode server.

Fields:

- `session_id` (string)
  - Stable observability ID.
  - Prefer the OpenCode session ID when available.
  - If OpenCode exposes both a session ID and a message/turn ID, implementations MAY expose a
    composite observability ID such as `<opencode_session_id>-<message_id>`.
- `opencode_session_id` (string or null)
- `message_id` (string or null)
  - Current or most recent OpenCode message/turn ID when exposed by the server API.
- `opencode_server_url` (string)
  - Base URL of the long-lived OpenCode server used by this run.
- `opencode_server_pid` (string or null)
  - Process ID when Twinpod owns the server process locally; null when attached to an existing
    managed server.
- `current_stage` (string or null)
  - Current pipeline stage name, for example `plan`, `execute`, `review`, or `continue`.
- `current_agent` (string or null)
  - OpenCode agent used for the current stage, for example `plan`, `build`, or a custom reviewer
    agent.
- `permission_profile` (string or null)
  - Effective Twinpod/OpenCode permission profile for the current stage.
- `last_opencode_event` (string/enum or null)
- `last_opencode_timestamp` (timestamp or null)
- `last_opencode_message` (summarized payload)
- `opencode_input_tokens` (integer)
- `opencode_output_tokens` (integer)
- `opencode_total_tokens` (integer)
- `last_reported_input_tokens` (integer)
- `last_reported_output_tokens` (integer)
- `last_reported_total_tokens` (integer)
- `turn_count` (integer)
  - Number of OpenCode messages/turns started within the current worker lifetime.
- `stage_results` (map `stage_name -> summary`, OPTIONAL)
  - Planner output, executor result, reviewer findings, or other workflow-defined stage summaries.

#### 4.1.7 Retry Entry

Scheduled retry state for an issue.

Fields:

- `issue_id`
- `identifier` (best-effort human ID for status surfaces/logs)
- `attempt` (integer, 1-based for retry queue)
- `due_at_ms` (monotonic clock timestamp)
- `timer_handle` (runtime-specific timer reference)
- `error` (string or null)

#### 4.1.8 Orchestrator Runtime State

Single authoritative in-memory state owned by the orchestrator.

Fields:

- `poll_interval_ms` (current effective poll interval)
- `max_concurrent_agents` (current effective global concurrency limit)
- `running` (map `issue_id -> running entry`)
- `claimed` (set of issue IDs reserved/running/retrying)
- `retry_attempts` (map `issue_id -> RetryEntry`)
- `completed` (set of issue IDs; bookkeeping only, not dispatch gating)
- `opencode_totals` (aggregate tokens + runtime seconds)
- `opencode_rate_limits` (latest rate-limit snapshot from OpenCode/model-provider events, if exposed)
- `opencode_server` (current long-lived server health, URL, PID, and auth status)

### 4.2 Stable Identifiers and Normalization Rules

- `Issue ID`
  - Use for tracker lookups and internal map keys.
- `Issue Identifier`
  - Use for human-readable logs and workspace naming.
- `Workspace Key`
  - Derive from `issue.identifier` by replacing any character not in `[A-Za-z0-9._-]` with `_`.
  - Use the sanitized value for the workspace directory name.
- `Normalized Issue State`
  - Compare states after `lowercase`.
- `Session ID`
  - Prefer the OpenCode session ID when exposed by the OpenCode server.
  - If OpenCode exposes both a session ID and a message/turn ID, compose a turn-scoped
    observability ID as `<session_id>-<message_id>`.

## 5. Workflow Specification (Repository Contract)

### 5.1 File Discovery and Path Resolution

Workflow file path precedence:

1. Explicit application/runtime setting (set by CLI startup path).
2. Default: `WORKFLOW.md` in the current process working directory.

Loader behavior:

- If the file cannot be read, return `missing_workflow_file` error.
- The workflow file is expected to be repository-owned and version-controlled.

### 5.2 File Format

`WORKFLOW.md` is a Markdown file with OPTIONAL YAML front matter.

Design note:

- `WORKFLOW.md` SHOULD be self-contained enough to describe and run different workflows (prompt,
  runtime settings, hooks, and tracker selection/config) without requiring out-of-band
  service-specific configuration.

Parsing rules:

- If file starts with `---`, parse lines until the next `---` as YAML front matter.
- Remaining lines become the prompt body.
- If front matter is absent, treat the entire file as prompt body and use an empty config map.
- YAML front matter MUST decode to a map/object; non-map YAML is an error.
- Prompt body is trimmed before use.

Returned workflow object:

- `config`: front matter root object (not nested under a `config` key).
- `prompt_template`: trimmed Markdown body.

### 5.3 Front Matter Schema

Top-level keys:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `opencode`

Unknown keys SHOULD be ignored for forward compatibility.

Note:

- The workflow front matter is extensible. Extensions MAY define additional top-level keys without
  changing the core schema above.
- Extensions SHOULD document their field schema, defaults, validation rules, and whether changes
  apply dynamically or require restart.

#### 5.3.1 `tracker` (object)

Fields:

- `kind` (string)
  - REQUIRED for dispatch.
  - Current supported value: `linear`
- `endpoint` (string)
  - Default for `tracker.kind == "linear"`: `https://api.linear.app/graphql`
- `api_key` (string)
  - MAY be a literal token or `$VAR_NAME`.
  - Canonical environment variable for `tracker.kind == "linear"`: `LINEAR_API_KEY`.
  - If `$VAR_NAME` resolves to an empty string, treat the key as missing.
- `project_slug` (string)
  - REQUIRED for dispatch when `tracker.kind == "linear"`.
- `required_labels` (list of strings)
  - Default: `[]`.
  - An issue MUST contain every configured label to dispatch or continue.
  - Matching ignores case and surrounding whitespace.
  - A blank configured label matches no issue.
- `active_states` (list of strings)
  - Default: `Todo`, `In Progress`
- `terminal_states` (list of strings)
  - Default: `Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done`

#### 5.3.2 `polling` (object)

Fields:

- `interval_ms` (integer)
  - Default: `30000`
  - Changes SHOULD be re-applied at runtime and affect future tick scheduling without restart.

#### 5.3.3 `workspace` (object)

Fields:

- `root` (path string or `$VAR`)
  - Default: `<system-temp>/twinpod_workspaces`
  - `~` is expanded.
  - Relative paths are resolved relative to the directory containing `WORKFLOW.md`.
  - The effective workspace root is normalized to an absolute path before use.

#### 5.3.4 `hooks` (object)

Fields:

- `after_create` (multiline shell script string, OPTIONAL)
  - Runs only when a workspace directory is newly created.
  - Failure aborts workspace creation.
- `before_run` (multiline shell script string, OPTIONAL)
  - Runs before each agent attempt after workspace preparation and before launching the coding
    agent.
  - Failure aborts the current attempt.
- `after_run` (multiline shell script string, OPTIONAL)
  - Runs after each agent attempt (success, failure, timeout, or cancellation) once the workspace
    exists.
  - Failure is logged but ignored.
- `before_remove` (multiline shell script string, OPTIONAL)
  - Runs before workspace deletion if the directory exists.
  - Failure is logged but ignored; cleanup still proceeds.
- `timeout_ms` (integer, OPTIONAL)
  - Default: `60000`
  - Applies to all workspace hooks.
  - Invalid values fail configuration validation.
  - Changes SHOULD be re-applied at runtime for future hook executions.

#### 5.3.5 `agent` (object)

Fields:

- `max_concurrent_agents` (integer)
  - Default: `10`
  - Changes SHOULD be re-applied at runtime and affect subsequent dispatch decisions.
- `max_turns` (positive integer)
  - Default: `20`
  - Limits the number of OpenCode turns within one worker session.
  - Invalid values fail configuration validation.
- `max_retry_backoff_ms` (integer)
  - Default: `300000` (5 minutes)
  - Changes SHOULD be re-applied at runtime and affect future retry scheduling.
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - Default: empty map.
  - State keys are normalized (`lowercase`) for lookup.
  - Invalid entries (non-positive or non-numeric) are ignored.

#### 5.3.6 `opencode` (object)

OpenCode-owned config values such as model providers, agents, permissions, custom tools, MCP
servers, instructions, formatters, LSP servers, watcher ignores, compaction, and plugins SHOULD be
handled through OpenCode's native `opencode.json`/`opencode.jsonc` config, `OPENCODE_CONFIG`,
`OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, `.opencode/*` files, and/or `AGENTS.md`.

This specification defines Twinpod's launch, supervision, and policy-bundle contract around a
long-lived OpenCode server. Twinpod does not define a second agent protocol.

Fields:

- `command` (string shell command or executable)
  - Default: `opencode`
  - Used as the OpenCode executable prefix.
  - The runtime MAY invoke this via `bash -lc` or an argv-safe equivalent.
  - Implementations SHOULD avoid interpolating untrusted issue fields into this command.

- `server` (object)
  - REQUIRED as the only OpenCode runtime profile.
  - Twinpod starts or attaches to a long-lived `opencode serve` process and reuses it across issue
    sessions.
  - Fields:
    - `hostname` (string)
      - Default: `127.0.0.1`
      - Bind host for Twinpod-managed servers.
      - SHOULD stay loopback unless the deployment explicitly secures remote access.
    - `port` (integer or null)
      - Default: `4096`
      - `0` requests an implementation-selected free port.
      - The effective bound port MUST be captured in runtime state.
    - `url` (string, OPTIONAL)
      - If provided, Twinpod attaches to this existing OpenCode server instead of starting one.
      - When `url` is used, Twinpod MUST still verify health and workspace isolation before dispatch.
    - `password_env` (string or null)
      - Default: `OPENCODE_SERVER_PASSWORD`
      - If the named env var is set, the Twinpod OpenCode client MUST authenticate with OpenCode's
        basic-auth scheme.
    - `username_env` (string or null)
      - Default: `OPENCODE_SERVER_USERNAME`
      - If unset, Twinpod uses OpenCode's documented default username.
    - `reuse_existing` (boolean)
      - Default: `true`
      - If true, Twinpod MAY attach to a healthy server at the configured URL/port instead of
        starting another process.
    - `restart_on_exit` (boolean)
      - Default: `true`
      - If true, Twinpod restarts a managed OpenCode server that exits unexpectedly.
    - `restart_backoff_ms` (integer)
      - Default: `5000`
      - Backoff before restarting an unhealthy or exited managed server.
    - `startup_timeout_ms` (integer)
      - Default: `30000`
      - Maximum time to wait for OpenCode server readiness.
    - `health_check_interval_ms` (integer)
      - Default: `5000`
      - Periodic health-check cadence for the long-lived server.

- `config_path` (path string or `$VAR`, OPTIONAL)
  - If present, sets `OPENCODE_CONFIG` for the OpenCode server process.
  - `~` is expanded.
  - Relative paths are resolved relative to the directory containing `WORKFLOW.md`.

- `config_content` (object or string, OPTIONAL)
  - If present, serialized or passed through as `OPENCODE_CONFIG_CONTENT` for the OpenCode server.
  - Intended for generated/ephemeral runtime overrides.
  - MUST NOT be logged when it contains secrets.

- `config_dir` (path string or `$VAR`, OPTIONAL)
  - If present, sets `OPENCODE_CONFIG_DIR` for the OpenCode server.
  - Use this for generated or repository-owned `.opencode`-style agents, commands, plugins, tools,
    and shared runtime assets.

- `model` (string, OPTIONAL)
  - OpenCode model identifier, for example `provider/model`.
  - Passed to OpenCode using the server API fields supported by the targeted OpenCode version.

- `pipeline` (list of stage objects)
  - Default:

    ```yaml
    pipeline:
      - name: plan
        agent: plan
        permission_profile: review_only
        max_turns: 1
        required: true
      - name: execute
        agent: build
        permission_profile: restricted
        max_turns: 10
        required: true
      - name: review
        agent: plan
        permission_profile: review_only
        max_turns: 1
        required: true
    ```

  - Defines the OpenCode agent pipeline for each issue attempt.
  - Stage fields:
    - `name` (string)
      - Stable stage identifier used in logs and runtime snapshots.
    - `agent` (string)
      - OpenCode agent name. MAY reference built-in agents such as `plan` and `build`, or a custom
        agent from `.opencode/agents/*` / configured OpenCode agent directories.
    - `model` (string, OPTIONAL)
      - Stage-specific model override.
    - `permission_profile` (string)
      - One of the Twinpod permission profiles defined by `opencode.permission_profiles`.
    - `prompt` (string, OPTIONAL)
      - Stage-specific guidance appended to the rendered issue prompt.
    - `max_turns` (positive integer)
      - Per-stage turn limit.
    - `required` (boolean)
      - If true, stage failure fails the run attempt.
    - `on_failure` (string)
      - Default: `fail_attempt`
      - Suggested values: `fail_attempt`, `continue`, `retry_execute`, `handoff`.
  - The planner stage SHOULD be read-only and produce an explicit implementation plan.
  - The executor stage SHOULD be the only default stage with file-edit permissions.
  - The reviewer stage SHOULD be read-only and SHOULD validate the diff, tests, and handoff state
    without modifying files.

- `max_pipeline_cycles` (positive integer)
  - Default: `1`
  - Allows reviewer findings to send work back to the executor when the workflow explicitly enables
    iterative execute/review loops.

- `permission_profile` (string)
  - Default: `restricted`
  - Fallback profile used when a pipeline stage does not specify one.
  - Valid core profiles: `high_trust`, `restricted`, `review_only`.

- `permission_profiles` (map `profile_name -> OpenCode permission config fragment`, OPTIONAL)
  - Compiles to OpenCode-native `permission` config.
  - Each rule MUST resolve to OpenCode's native permission actions: `allow`, `ask`, or `deny`.
  - Implementations MAY add deployment-specific profiles, but the three core profiles below MUST be
    documented if they are exposed:
    - `high_trust`
      - Intended for trusted repositories and isolated hosts.
      - MAY allow read/search/edit/todo/skill/LSP operations.
      - MAY auto-approve safe bash commands, but SHOULD deny known destructive patterns through
        explicit rules and/or the Twinpod plugin.
    - `restricted`
      - Default autonomous execution profile.
      - SHOULD allow read/search/todo/formatter operations.
      - SHOULD set edits and bash to `ask` or narrowly scoped `allow` rules.
      - SHOULD deny secret reads and destructive commands through explicit rules and/or plugins.
    - `review_only`
      - Planning/review profile.
      - MUST deny file edits and mutating shell commands.
      - SHOULD allow read/search/LSP diagnostics.
  - Explicit OpenCode `deny` rules MUST win over Twinpod auto-approval and over any stage-level
    request.

- `auto_approve` (boolean)
  - Default: `false`
  - If true, Twinpod MAY start or message OpenCode with auto-approval behavior supported by the
    targeted OpenCode server/CLI, but only for permissions that are not explicitly denied.

- `plugin` (object)
  - Default: enabled with implementation-defined plugin asset location.
  - Fields:
    - `enabled` (boolean), default `true`
    - `required` (boolean), default `false`
    - `audit_log_path` (path string, OPTIONAL)
    - `redact_secrets` (boolean), default `true`
    - `protect_env_files` (boolean), default `true`
    - `emit_tool_events` (boolean), default `true`
    - `emit_permission_events` (boolean), default `true`
  - When enabled, Twinpod SHOULD provide an OpenCode plugin that emits structured lifecycle/tool /
    permission events, protects secret-bearing files such as `.env`, redacts sensitive payloads,
    and adds issue/session metadata to OpenCode logs.

- `quality` (object)
  - OpenCode quality-of-change settings.
  - Fields:
    - `formatter` (boolean or object)
      - Default: `true`
      - If true, Twinpod SHOULD enable OpenCode's formatter configuration for built-in formatters.
    - `lsp` (object)
      - Fields:
        - `enabled` (boolean), default `false`
        - `required` (boolean), default `false`
        - `permission` (string), default `ask`
      - LSP is OPTIONAL because support depends on project language tooling and host setup.
      - If enabled, planner/reviewer agents SHOULD be allowed to use LSP diagnostics; executor LSP
        permissions are implementation-defined.

- `config_hygiene` (object)
  - Defines the generated OpenCode runtime bundle Twinpod SHOULD create or enforce.
  - Fields:
    - `write_generated_config` (boolean), default `true`
    - `watcher_ignore` (list of strings)
      - Default SHOULD include `.git/**`, `node_modules/**`, `dist/**`, `build/**`, `.next/**`,
        `coverage/**`, `.twinpod/**`, and generated log/session artifacts.
    - `compaction` (object, OPTIONAL)
      - Pass-through OpenCode compaction config or plugin-backed compaction policy.
      - SHOULD preserve issue identifier, current pipeline stage, modified files, validation status,
        and remaining handoff steps across compaction.
    - `disabled_providers` (list of strings), default `[]`
      - Providers the generated OpenCode config SHOULD disable to avoid accidental provider/model
        drift.
    - `instructions` (list of strings), default `[]`
      - Additional OpenCode instruction files or URLs to include in the generated config.
    - `mcp` (map, default `{}`)
      - OpenCode MCP configuration fragment.
    - `plugins` (list of strings), default `[]`
      - Additional OpenCode plugin packages or paths.
    - `env` (map `name -> value`, OPTIONAL)
      - Additional environment variables for the OpenCode server process.
      - Values MAY use `$VAR_NAME` indirection.
      - Secrets MUST NOT be logged.

- `read_timeout_ms` (integer)
  - Default: `5000`
  - Request/response timeout for synchronous server operations.

- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
  - Maximum time for a single OpenCode message/turn.

- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - If `<= 0`, stall detection is disabled.
  - Activity SHOULD be updated from OpenCode server events, message responses, session status, and
    plugin-emitted telemetry.

### 5.4 Prompt Template Contract

The Markdown body of `WORKFLOW.md` is the per-issue prompt template.

Rendering requirements:

- Use a strict template engine (Liquid-compatible semantics are sufficient).
- Unknown variables MUST fail rendering.
- Unknown filters MUST fail rendering.

Template input variables:

- `issue` (object)
  - Includes all normalized issue fields, including labels and blockers.
- `attempt` (integer or null)
  - `null`/absent on first attempt.
  - Integer on retry or continuation run.

Fallback prompt behavior:

- If the workflow prompt body is empty, the runtime MAY use a minimal default prompt
  (`You are working on an issue from Linear.`).
- Workflow file read/parse failures are configuration/validation errors and SHOULD NOT silently fall
  back to a prompt.

### 5.5 Workflow Validation and Error Surface

Error classes:

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error` (during prompt rendering)
- `template_render_error` (unknown variable/filter, invalid interpolation)

Dispatch gating behavior:

- Workflow file read/YAML errors block new dispatches until fixed.
- Template errors fail only the affected run attempt.

## 6. Configuration Specification

### 6.1 Configuration Resolution Pipeline

Configuration is resolved in this order:

1. Select the workflow file path (explicit runtime setting, otherwise cwd default).
2. Parse YAML front matter into a raw config map.
3. Apply built-in defaults for missing OPTIONAL fields.
4. Resolve `$VAR_NAME` indirection only for config values that explicitly contain `$VAR_NAME`.
5. Coerce and validate typed values.

Environment variables do not globally override YAML values. They are used only when a config value
explicitly references them.

Value coercion semantics:

- Path/command fields support:
  - `~` home expansion
  - `$VAR` expansion for env-backed path values
  - Apply expansion only to values intended to be local filesystem paths; do not rewrite URIs or
    arbitrary shell command strings.
- Relative `workspace.root` values resolve relative to the directory containing the selected
  `WORKFLOW.md`.

### 6.2 Dynamic Reload Semantics

Dynamic reload is REQUIRED:

- The software MUST detect `WORKFLOW.md` changes.
- On change, it MUST re-read and re-apply workflow config and prompt template without restart.
- The software MUST attempt to adjust live behavior to the new config (for example polling
  cadence, concurrency limits, active/terminal states, OpenCode server, pipeline, permission, generated-config, workspace paths/hooks, and
  prompt content for future runs).
- Reloaded config applies to future dispatch, retry scheduling, reconciliation decisions, hook
  execution, and OpenCode session launches.
- Implementations are not REQUIRED to restart in-flight agent sessions automatically when config
  changes.
- Extensions that manage their own listeners/resources (for example an HTTP server port change) MAY
  require restart unless the implementation explicitly supports live rebind.
- Implementations SHOULD also re-validate/reload defensively during runtime operations (for example
  before dispatch) in case filesystem watch events are missed.
- Invalid reloads MUST NOT crash the service; keep operating with the last known good effective
  configuration and emit an operator-visible error.

### 6.3 Dispatch Preflight Validation

This validation is a scheduler preflight run before attempting to dispatch new work. It validates
the workflow/config needed to poll and launch workers, not a full audit of all possible workflow
behavior.

Startup validation:

- Validate configuration before starting the scheduling loop.
- If startup validation fails, fail startup and emit an operator-visible error.

Per-tick dispatch validation:

- Re-validate before each dispatch cycle.
- If validation fails, skip dispatch for that tick, keep reconciliation active, and emit an
  operator-visible error.

Validation checks:

- Workflow file can be loaded and parsed.
- The long-lived OpenCode server configuration is valid.
- `tracker.kind` is present and supported.
- `tracker.api_key` is present after `$` resolution.
- `tracker.project_slug` is present when REQUIRED by the selected tracker kind.
- `opencode.command` is present and non-empty.
- `opencode.server` configuration is present and valid.
- OpenCode permission profile and pipeline configuration can be resolved.

### 6.4 Core Config Fields Summary (Cheat Sheet)

This section is intentionally redundant so a coding agent can implement the config layer quickly.
Extension fields are documented in the extension section that defines them. Core conformance does
not require recognizing or validating extension fields unless that extension is implemented.

- `tracker.kind`: string, REQUIRED, currently `linear`
- `tracker.endpoint`: string, default `https://api.linear.app/graphql` when `tracker.kind=linear`
- `tracker.api_key`: string or `$VAR`, canonical env `LINEAR_API_KEY` when `tracker.kind=linear`
- `tracker.project_slug`: string, REQUIRED when `tracker.kind=linear`
- `tracker.required_labels`: list of strings, default `[]`
- `tracker.active_states`: list of strings, default `["Todo", "In Progress"]`
- `tracker.terminal_states`: list of strings, default `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path resolved to absolute, default `<system-temp>/twinpod_workspaces`
- `hooks.after_create`: shell script or null
- `hooks.before_run`: shell script or null
- `hooks.after_run`: shell script or null
- `hooks.before_remove`: shell script or null
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_turns`: integer, default `20`
- `agent.max_retry_backoff_ms`: integer, default `300000` (5m)
- `agent.max_concurrent_agents_by_state`: map of positive integers, default `{}`
- `opencode.command`: string command/executable, default `opencode`
- `opencode.server`: object, REQUIRED long-lived server config
- `opencode.server.hostname`: string, default `127.0.0.1`
- `opencode.server.port`: integer or null, default `4096`
- `opencode.server.url`: string, optional existing server URL
- `opencode.server.password_env`: string or null, default `OPENCODE_SERVER_PASSWORD`
- `opencode.server.username_env`: string or null, default `OPENCODE_SERVER_USERNAME`
- `opencode.server.reuse_existing`: boolean, default `true`
- `opencode.server.restart_on_exit`: boolean, default `true`
- `opencode.server.restart_backoff_ms`: integer, default `5000`
- `opencode.server.startup_timeout_ms`: integer, default `30000`
- `opencode.server.health_check_interval_ms`: integer, default `5000`
- `opencode.config_path`: path string or `$VAR`, optional; sets `OPENCODE_CONFIG`
- `opencode.config_content`: object/string, optional; sets `OPENCODE_CONFIG_CONTENT`
- `opencode.config_dir`: path string or `$VAR`, optional; sets `OPENCODE_CONFIG_DIR`
- `opencode.model`: string, optional
- `opencode.pipeline`: list of stage objects, default plan/build/review
- `opencode.max_pipeline_cycles`: positive integer, default `1`
- `opencode.permission_profile`: string, default `restricted`
- `opencode.permission_profiles`: map of OpenCode permission config fragments, optional
- `opencode.auto_approve`: boolean, default `false`
- `opencode.plugin.enabled`: boolean, default `true`
- `opencode.plugin.required`: boolean, default `false`
- `opencode.plugin.audit_log_path`: path string, optional
- `opencode.plugin.redact_secrets`: boolean, default `true`
- `opencode.plugin.protect_env_files`: boolean, default `true`
- `opencode.quality.formatter`: boolean or object, default `true`
- `opencode.quality.lsp.enabled`: boolean, default `false`
- `opencode.quality.lsp.required`: boolean, default `false`
- `opencode.quality.lsp.permission`: string, default `ask`
- `opencode.config_hygiene.write_generated_config`: boolean, default `true`
- `opencode.config_hygiene.watcher_ignore`: list of strings, default implementation-defined safe ignores
- `opencode.config_hygiene.compaction`: object, optional OpenCode/plugin compaction policy
- `opencode.config_hygiene.disabled_providers`: list of strings, default `[]`
- `opencode.config_hygiene.instructions`: list of strings, default `[]`
- `opencode.config_hygiene.mcp`: map, default `{}`
- `opencode.config_hygiene.plugins`: list of strings, default `[]`
- `opencode.config_hygiene.env`: map of environment variables, optional
- `opencode.turn_timeout_ms`: integer, default `3600000`
- `opencode.read_timeout_ms`: integer, default `5000`
- `opencode.stall_timeout_ms`: integer, default `300000`

## 7. Orchestration State Machine

The orchestrator is the only component that mutates scheduling state. All worker outcomes are
reported back to it and converted into explicit state transitions.

### 7.1 Issue Orchestration States

This is not the same as tracker states (`Todo`, `In Progress`, etc.). This is the service's internal
claim state.

1. `Unclaimed`
   - Issue is not running and has no retry scheduled.

2. `Claimed`
   - Orchestrator has reserved the issue to prevent duplicate dispatch.
   - In practice, claimed issues are either `Running` or `RetryQueued`.

3. `Running`
   - Worker task exists and the issue is tracked in `running` map.

4. `RetryQueued`
   - Worker is not running, but a retry timer exists in `retry_attempts`.

5. `Released`
   - Claim removed because issue is terminal, non-active, missing, or retry path completed without
     re-dispatch.

Important nuance:

- A successful worker exit does not mean the issue is done forever.
- The worker MAY continue through multiple back-to-back OpenCode stages/turns before it exits.
- After each normal turn completion, the worker re-checks the tracker issue state.
- If the issue is still in an active state, the worker SHOULD start another turn on the same live
  OpenCode session in the same workspace, up to the relevant `agent.max_turns`,
  `opencode.pipeline[*].max_turns`, and `opencode.max_pipeline_cycles` limits.
- The first turn SHOULD use the full rendered task prompt.
- Continuation turns SHOULD send only continuation guidance to the existing OpenCode session, not resend the
  original task prompt that is already present in session history.
- Once the worker exits normally, the orchestrator still schedules a short continuation retry
  (about 1 second) so it can re-check whether the issue remains active and needs another worker
  session.

### 7.2 Run Attempt Lifecycle

A run attempt transitions through these phases:

1. `PreparingWorkspace`
2. `BuildingPrompt`
3. `EnsuringOpenCodeServer`
4. `InitializingSession`
5. `RunningPipelineStage`
6. `Finishing`
7. `Succeeded`
8. `Failed`
9. `TimedOut`
10. `Stalled`
11. `CanceledByReconciliation`

Distinct terminal reasons are important because retry logic and logs differ.

### 7.3 Transition Triggers

- `Poll Tick`
  - Reconcile active runs.
  - Validate config.
  - Fetch candidate issues.
  - Dispatch until slots are exhausted.

- `Worker Exit (normal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule continuation retry (attempt `1`) after the worker exhausts or finishes its in-process
    pipeline loop.

- `Worker Exit (abnormal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule exponential-backoff retry.

- `OpenCode Update Event`
  - Update live session fields, token counters, and rate limits.

- `Retry Timer Fired`
  - Re-fetch active candidates and attempt re-dispatch, or release claim if no longer eligible.

- `Reconciliation State Refresh`
  - Stop runs whose issue states are terminal or no longer active.

- `Stall Timeout`
  - Cancel the active OpenCode message/session when possible and schedule retry.

### 7.4 Idempotency and Recovery Rules

- The orchestrator serializes state mutations through one authority to avoid duplicate dispatch.
- `claimed` and `running` checks are REQUIRED before launching any worker.
- Reconciliation runs before dispatch on every tick.
- Restart recovery is tracker-driven and filesystem-driven (without a durable orchestrator DB).
- Startup terminal cleanup removes stale workspaces for issues already in terminal states.

## 8. Polling, Scheduling, and Reconciliation

### 8.1 Poll Loop

At startup, the service validates config, performs startup cleanup, schedules an immediate tick, and
then repeats every `polling.interval_ms`.

The effective poll interval SHOULD be updated when workflow config changes are re-applied.

Tick sequence:

1. Reconcile running issues.
2. Run dispatch preflight validation.
3. Fetch candidate issues from tracker using active states.
4. Sort issues by dispatch priority.
5. Dispatch eligible issues while slots remain.
6. Notify observability/status consumers of state changes.

If per-tick validation fails, dispatch is skipped for that tick, but reconciliation still happens
first.

### 8.2 Candidate Selection Rules

An issue is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`.
- It is routed to this worker by the configured assignee and contains every
  label in `tracker.required_labels`.
- It is not already in `running`.
- It is not already in `claimed`.
- Global concurrency slots are available.
- Per-state concurrency slots are available.
- Blocker rule for `Todo` state passes:
  - If the issue state is `Todo`, do not dispatch when any blocker is non-terminal.

Sorting order (stable intent):

1. `priority` ascending (1..4 are preferred; null/unknown sorts last)
2. `created_at` oldest first
3. `identifier` lexicographic tie-breaker

### 8.3 Concurrency Control

Global limit:

- `available_slots = max(max_concurrent_agents - running_count, 0)`

Per-state limit:

- `max_concurrent_agents_by_state[state]` if present (state key normalized)
- otherwise fallback to global limit

The runtime counts issues by their current tracked state in the `running` map.

### 8.4 Retry and Backoff

Retry entry creation:

- Cancel any existing retry timer for the same issue.
- Store `attempt`, `identifier`, `error`, `due_at_ms`, and new timer handle.

Backoff formula:

- Normal continuation retries after a clean worker exit use a short fixed delay of `1000` ms.
- Failure-driven retries use `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Power is capped by the configured max retry backoff (default `300000` / 5m).

Retry handling behavior:

1. Fetch active candidate issues (not all issues).
2. Find the specific issue by `issue_id`.
3. If not found, release claim.
4. If found and still candidate-eligible:
   - Dispatch if slots are available.
   - Otherwise requeue with error `no available orchestrator slots`.
5. If found but no longer active, release claim.

Note:

- Terminal-state workspace cleanup is handled by startup cleanup and active-run reconciliation
  (including terminal transitions for currently running issues).
- Retry handling mainly operates on active candidates and releases claims when the issue is absent,
  rather than performing terminal cleanup itself.

### 8.5 Active Run Reconciliation

Reconciliation runs every tick and has two parts.

Part A: Stall detection

- For each running issue, compute `elapsed_ms` since:
  - `last_opencode_timestamp` if any event has been seen, else
  - `started_at`
- If `elapsed_ms > opencode.stall_timeout_ms`, terminate the worker and queue a retry.
- If `stall_timeout_ms <= 0`, skip stall detection entirely.

Part B: Tracker state refresh

- Fetch current issue states for all running issue IDs.
- For each running issue:
  - If tracker state is terminal: terminate worker and clean workspace.
  - If tracker state is still active: update the in-memory issue snapshot.
  - If tracker state is neither active nor terminal: terminate worker without workspace cleanup.
- If state refresh fails, keep workers running and try again on the next tick.

### 8.6 Startup Terminal Workspace Cleanup

When the service starts:

1. Query tracker for issues in terminal states.
2. For each returned issue identifier, remove the corresponding workspace directory.
3. If the terminal-issues fetch fails, log a warning and continue startup.

This prevents stale terminal workspaces from accumulating after restarts.

## 9. Workspace Management and Safety

### 9.1 Workspace Layout

Workspace root:

- `workspace.root` (normalized absolute path)

Per-issue workspace path:

- `<workspace.root>/<sanitized_issue_identifier>`

Workspace persistence:

- Workspaces are reused across runs for the same issue.
- Successful runs do not auto-delete workspaces.

### 9.2 Workspace Creation and Reuse

Input: `issue.identifier`

Algorithm summary:

1. Sanitize identifier to `workspace_key`.
2. Compute workspace path under workspace root.
3. Ensure the workspace path exists as a directory.
4. Mark `created_now=true` only if the directory was created during this call; otherwise
   `created_now=false`.
5. If `created_now=true`, run `after_create` hook if configured.

Notes:

- This section does not assume any specific repository/VCS workflow.
- Workspace preparation beyond directory creation (for example dependency bootstrap, checkout/sync,
  code generation) is implementation-defined and is typically handled via hooks.

### 9.3 OPTIONAL Workspace Population (Implementation-Defined)

The spec does not require any built-in VCS or repository bootstrap behavior.

Implementations MAY populate or synchronize the workspace using implementation-defined logic and/or
hooks (for example `after_create` and/or `before_run`).

Failure handling:

- Workspace population/synchronization failures return an error for the current attempt.
- If failure happens while creating a brand-new workspace, implementations MAY remove the partially
  prepared directory.
- Reused workspaces SHOULD NOT be destructively reset on population failure unless that policy is
  explicitly chosen and documented.

### 9.4 Workspace Hooks

Supported hooks:

- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `hooks.before_remove`

Execution contract:

- Execute in a local shell context appropriate to the host OS, with the workspace directory as
  `cwd`.
- On POSIX systems, `sh -lc <script>` (or a stricter equivalent such as `bash -lc <script>`) is a
  conforming default.
- Hook timeout uses `hooks.timeout_ms`; default: `60000 ms`.
- Log hook start, failures, and timeouts.

Failure semantics:

- `after_create` failure or timeout is fatal to workspace creation.
- `before_run` failure or timeout is fatal to the current run attempt.
- `after_run` failure or timeout is logged and ignored.
- `before_remove` failure or timeout is logged and ignored.

### 9.5 Safety Invariants

This is the most important portability constraint.

Invariant 1: Scope every OpenCode session/message to the per-issue workspace path.

- Before creating or continuing an OpenCode session, validate:
  - effective OpenCode working directory or session directory equals `workspace_path`

Invariant 2: Workspace path MUST stay inside workspace root.

- Normalize both paths to absolute.
- Require `workspace_path` to have `workspace_root` as a prefix directory.
- Reject any path outside the workspace root.

Invariant 3: Workspace key is sanitized.

- Only `[A-Za-z0-9._-]` allowed in workspace directory names.
- Replace all other characters with `_`.

## 10. Agent Runner Protocol (OpenCode Server Integration)

Twinpod integrates with OpenCode through one runtime profile: a long-lived `opencode serve`
process controlled through the OpenCode server API and event stream supported by the installed
OpenCode version.

Protocol/source-of-truth rules:

- Implementations MUST use HTTP requests, authentication, event handling, session/message fields,
  and config files valid for the targeted OpenCode version.
- Implementations MUST consult the installed OpenCode help output, OpenCode docs, and the server
  OpenAPI schema exposed by the running server instead of treating this document as a protocol
  schema.
- If this specification appears to conflict with the targeted OpenCode version, OpenCode's protocol
  controls protocol shape and transport behavior.
- Twinpod-specific requirements in this section still control orchestration behavior, workspace
  selection, prompt construction, pipeline sequencing, permission-profile selection, and
  observability extraction.

### 10.1 Long-Lived OpenCode Server Runtime

Twinpod MUST use a long-lived OpenCode server for automated worker execution.

Server lifecycle contract:

- Start command for a managed local server: `<opencode.command> serve --hostname <hostname> --port <port>`.
- The server SHOULD be started during Twinpod startup or worker-host initialization, before issue
  dispatch begins.
- The server MUST be reused across issue attempts and continuation turns.
- Twinpod MUST NOT start a fresh OpenCode runtime for every issue attempt or every turn.
- Bind host SHOULD default to loopback (`127.0.0.1`) unless the deployment explicitly secures remote
  access.
- Twinpod MUST wait for a server health/readiness signal before dispatching work to that server.
- If Twinpod owns the server process, it SHOULD restart the server after unexpected exit using the
  configured restart backoff.
- If Twinpod attaches to an existing server URL, it MUST verify server health and authentication at
  startup and during reconciliation.
- The OpenCode server OpenAPI schema published by the running server is the source of truth for
  request/response bodies.

Workspace isolation with a shared server:

- Every OpenCode session/message MUST be scoped to the per-issue workspace path using the server API
  fields supported by the targeted OpenCode version.
- If the installed OpenCode server cannot safely scope different sessions to different workspace
  directories, a conforming implementation MUST isolate by running a separate long-lived server per
  worker host/workspace root or another documented boundary. It MUST NOT silently run an issue from
  the wrong directory.
- Manual operator use of an attached OpenCode CLI is allowed for diagnostics, but automated Twinpod
  execution MUST flow through the long-lived server runtime.

### 10.2 Environment and OpenCode Config Bundle Responsibilities

Before starting or attaching to the OpenCode server, Twinpod MUST construct the effective runtime
environment:

- Preserve required host authentication for model providers.
- Resolve and set `OPENCODE_CONFIG` when `opencode.config_path` is configured.
- Resolve and set `OPENCODE_CONFIG_DIR` when `opencode.config_dir` is configured.
- Serialize/set `OPENCODE_CONFIG_CONTENT` when `opencode.config_content` is configured.
- Set additional `opencode.config_hygiene.env` variables after `$VAR` resolution.
- Avoid logging secret env values.

Generated config bundle:

- Twinpod SHOULD generate a deterministic OpenCode config bundle when `opencode.config_hygiene.write_generated_config == true`.
- Generated config MUST NOT overwrite repository-owned OpenCode config unless explicitly configured.
- Generated config SHOULD be written inside a Twinpod-owned runtime directory under the workspace or
  a documented temp directory.
- Generated config SHOULD compose, not replace, repository-owned `opencode.json`, `.opencode/*`, and
  `AGENTS.md` assets whenever OpenCode's config precedence allows.
- Generated config SHOULD include the selected permission profile, pipeline agent definitions,
  formatter/LSP settings, Twinpod plugin configuration, watcher ignores, compaction policy,
  disabled providers, instruction files, MCP config, and custom tool/plugin references.
- Generated config SHOULD be deleted after the run when it contains secrets.
- Generated config SHOULD prefer environment variables over embedding secrets in files.

### 10.3 Permission Profiles

Twinpod MUST express permissions through OpenCode-native permission config wherever possible.

Core profiles:

1. `high_trust`
   - Intended for trusted repositories, isolated hosts, and high-autonomy runs.
   - MAY allow read/search/edit/todo/skill/LSP operations.
   - MAY auto-approve safe bash commands when `opencode.auto_approve == true`.
   - SHOULD still deny known destructive shell patterns, secret-bearing file reads, and out-of-scope
     paths through explicit rules and/or the Twinpod OpenCode plugin.

2. `restricted`
   - Default autonomous execution profile.
   - SHOULD allow read/search/todo and formatter operations.
   - SHOULD set edits and bash to `ask` or narrowly scoped `allow` rules.
   - SHOULD deny secret reads, destructive commands, and out-of-workspace paths through explicit
     rules and/or the Twinpod OpenCode plugin.

3. `review_only`
   - Planning and review profile.
   - MUST deny file edits and mutating shell commands.
   - SHOULD allow read/search/LSP diagnostics.
   - SHOULD be the default for planner and reviewer pipeline stages.

Rules:

- Each pipeline stage MUST resolve to exactly one permission profile.
- Each permission profile MUST compile to OpenCode's native `permission` config using `allow`,
  `ask`, and `deny` actions.
- Explicit OpenCode `deny` rules MUST win over Twinpod auto-approval and stage-level requests.
- Permission requests that remain unresolved MUST NOT leave a run stalled indefinitely. Twinpod MAY
  fail the run, hand off to an operator, or wait for a bounded timeout according to documented
  deployment policy.

### 10.4 Agent Pipeline

A Twinpod worker attempt is modeled as an OpenCode agent pipeline.

Default lifecycle:

1. `plan`
   - Agent: `plan`
   - Permission profile: `review_only`
   - Purpose: analyze the issue and repository, produce an implementation plan, identify likely
     files/tests, and call out blockers.
   - MUST NOT modify files.

2. `execute`
   - Agent: `build`
   - Permission profile: `restricted` unless overridden.
   - Purpose: implement the change, run focused validation, and prepare handoff artifacts.
   - SHOULD be the only default stage with file-edit permissions.

3. `review`
   - Agent: `plan` or a custom reviewer agent.
   - Permission profile: `review_only`
   - Purpose: inspect the diff, check validation evidence, identify regressions, and determine
     whether the issue should be handed off, retried, or looped back to execution.
   - MUST NOT modify files.

Pipeline rules:

- Stage order is defined by `opencode.pipeline`.
- The rendered issue prompt is sent to the first stage.
- Later stages receive the original issue context plus stage outputs from earlier stages.
- Planner output SHOULD be summarized into a structured stage result before execution begins.
- Reviewer findings SHOULD be summarized into a structured stage result before worker exit.
- If `opencode.max_pipeline_cycles > 1`, reviewer findings MAY loop back to executor; this loop MUST
  be bounded.
- Continuation turns after a clean worker exit SHOULD resume with the stage and context most
  relevant to the issue's current state, not blindly restart the full task.
- Agent names are OpenCode-native. They MAY refer to built-in agents or custom agents defined in
  `.opencode/agents/*` or the configured OpenCode config directory.

### 10.5 OpenCode Plugin Extension

Twinpod SHOULD provide an OpenCode plugin for audit, telemetry, and safety defense-in-depth.

Plugin responsibilities when enabled:

- Add issue/session/stage metadata to OpenCode logs and events.
- Emit structured events for session creation, session status, session errors, tool execution,
  permission prompts/replies, file edits, LSP diagnostics, todo updates, and compaction.
- Redact secrets and prevent logging raw token values.
- Block or fail reads of secret-bearing files such as `.env` when `protect_env_files == true`.
- Record tool-call start/end/error events in a Twinpod-readable audit sink when configured.
- Surface permission prompts and unresolved input requests to the Twinpod runner.
- Inject safe runtime environment variables needed by Twinpod-owned tools, without exposing secrets
  to the model unnecessarily.
- Add compaction context that preserves issue identifier, current pipeline stage, modified files,
  validation status, and remaining handoff steps.

Failure semantics:

- If `opencode.plugin.required == true`, plugin load failure is a startup/configuration failure.
- If `opencode.plugin.required == false`, plugin load failure is logged as an operator-visible
  warning and worker execution MAY continue.
- Plugin failures MUST NOT corrupt orchestrator state. They are observability/safety failures unless
  explicitly configured as fatal.

### 10.6 Formatter and LSP Integration

Formatters:

- Twinpod SHOULD enable OpenCode formatters by default through `opencode.quality.formatter`.
- Formatter failures SHOULD be surfaced in stage output and logs.
- Formatter failures MAY fail the executor stage when the implementation documents that formatting
  is required for handoff.

LSP:

- LSP support is OPTIONAL and configured with `opencode.quality.lsp`.
- If enabled, planner and reviewer stages SHOULD be allowed to use LSP diagnostics and symbols.
- Executor-stage LSP access is implementation-defined.
- If `opencode.quality.lsp.required == true`, LSP setup failure fails startup or dispatch preflight.
- If `required == false`, LSP setup failure is an operator-visible warning and the run continues.

### 10.7 Watcher, Compaction, and Config Hygiene

Twinpod SHOULD keep generated OpenCode config deterministic and auditable.

Watcher hygiene:

- Generated config SHOULD ignore noisy paths such as `.git/**`, `node_modules/**`, `dist/**`,
  `build/**`, `.next/**`, `coverage/**`, `.twinpod/**`, and generated log/session artifacts.
- Watcher ignores MUST NOT hide files that the workflow requires OpenCode to inspect or edit.

Compaction hygiene:

- If OpenCode compaction is enabled or exposed through plugin hooks, Twinpod SHOULD inject
  workflow-relevant context into compaction summaries.
- Compaction context SHOULD include issue identifier, stage, decisions made, modified files,
  validation results, blockers, and next handoff steps.
- Compaction settings MUST NOT include secrets.

Provider/config hygiene:

- Generated config SHOULD disable providers that are not approved for the deployment when
  `disabled_providers` is configured.
- Generated config SHOULD include only the MCP servers and plugins required for the workflow.
- Generated config SHOULD avoid depending on user-global OpenCode settings for correctness.
- Twinpod SHOULD record the effective config source paths and config hash in observability output.

### 10.8 Session Startup Responsibilities

The OpenCode runner MUST:

- Ensure the long-lived OpenCode server is healthy before creating or continuing a session.
- Create or select the per-issue workspace before session creation.
- Validate workspace root containment before sending the workspace path to OpenCode.
- Scope the OpenCode session/message to the per-issue workspace path.
- Include issue-identifying metadata, such as `<issue.identifier>: <issue.title>`, when OpenCode
  supports session/message titles.
- Select the configured OpenCode agent and model for each pipeline stage when OpenCode supports
  those fields.
- Start the first stage with the fully rendered issue prompt.
- Start later stages and continuation turns in the same OpenCode session when supported.
- Apply the resolved permission profile for each stage.
- Expose OpenCode-native tools through `.opencode/tools`, plugins, and/or MCP rather than inventing a
  separate tool protocol when possible.

Session identifiers:

- Extract the OpenCode session ID from server API responses or event payloads when available.
- Extract message/turn IDs when available.
- Emit a stable observability `session_id`; prefer `<opencode_session_id>-<message_id>` for a
  turn-scoped ID and `<opencode_session_id>` for a session-scoped ID.
- Reuse the same OpenCode session for all pipeline stages and continuation turns inside one worker
  run when supported.

### 10.9 Event Processing

The client processes OpenCode server updates by consuming server events/SSE where available, polling
session status when needed, and processing message API responses.

Completion conditions:

- OpenCode reports message/turn completion -> stage success
- OpenCode reports message/turn failure -> stage failure
- OpenCode reports cancellation/abort -> stage failure
- stage timeout (`opencode.turn_timeout_ms`) -> stage failure
- server exits or becomes unhealthy before completion -> worker failure
- permission request unresolved by configured policy -> failure or operator-wait state with a
  bounded timeout
- user/input request unresolved by configured policy -> failure or operator-wait state with a
  bounded timeout

Server/event handling requirements:

- Follow the HTTP, authentication, event stream, and response rules of the targeted OpenCode version.
- Handle request timeouts, non-2xx responses, server readiness, and server restart explicitly.
- For event streams, reconnect behavior is implementation-defined but MUST NOT create duplicate
  OpenCode messages/turns.
- Stale or missing event streams SHOULD be supplemented with session-status polling.

### 10.10 Emitted Runtime Events (Upstream to Orchestrator)

The OpenCode runner emits structured events to the orchestrator callback. Each event SHOULD include:

- `event` (enum/string)
- `timestamp` (UTC timestamp)
- `opencode_server_pid` (if available)
- `opencode_server_url`
- `opencode_session_id` (if available)
- `message_id` (if available)
- `stage` (if available)
- `agent` (if available)
- `permission_profile` (if available)
- OPTIONAL `usage` map (token counts, cost, model/provider metadata when exposed)
- payload fields as needed

Important emitted events include, for example:

- `server_started`
- `server_ready`
- `server_unhealthy`
- `server_restarted`
- `session_started`
- `startup_failed`
- `stage_started`
- `stage_completed`
- `stage_failed`
- `message_started`
- `message_completed`
- `message_failed`
- `message_cancelled`
- `permission_requested`
- `permission_auto_approved`
- `permission_denied`
- `user_input_required`
- `tool_call_started`
- `tool_call_completed`
- `tool_call_failed`
- `formatter_started`
- `formatter_completed`
- `lsp_diagnostics`
- `compaction_started`
- `compaction_completed`
- `notification`
- `other_message`
- `malformed`

### 10.11 Timeouts and Error Mapping

Timeouts:

- `opencode.server.startup_timeout_ms`: OpenCode server readiness timeout
- `opencode.read_timeout_ms`: request/response timeout during sync server operations
- `opencode.turn_timeout_ms`: total OpenCode stage/message timeout
- `opencode.stall_timeout_ms`: enforced by orchestrator based on event inactivity

Error mapping (RECOMMENDED normalized categories):

- `opencode_not_found`
- `invalid_workspace_cwd`
- `response_timeout`
- `startup_timeout`
- `turn_timeout`
- `server_unavailable`
- `server_health_failed`
- `server_auth_failed`
- `response_error`
- `message_failed`
- `message_cancelled`
- `stage_failed`
- `permission_required`
- `permission_denied`
- `user_input_required`
- `plugin_unavailable`
- `formatter_failed`
- `lsp_unavailable`
- `malformed_event`

### 10.12 OpenCode Runner Contract

The `Agent Runner` wraps workspace + prompt + long-lived OpenCode server session.

Behavior:

1. Ensure the OpenCode server is healthy.
2. Create/reuse workspace for issue.
3. Build prompt from workflow template.
4. Create or continue an OpenCode session scoped to the workspace.
5. Execute the configured agent pipeline in order.
6. Forward OpenCode/plugin events to orchestrator.
7. Continue within the same OpenCode session while issue state remains active and turn/cycle limits
   allow.
8. On any error, fail the worker attempt (the orchestrator will retry).
9. Abort the active OpenCode message/session on cancellation, timeout, terminal tracker transition,
   or worker shutdown when the server API supports it.

Note:

- Workspaces are intentionally preserved after successful runs.
- OpenCode session storage, snapshots, and server internals are OpenCode-owned. Twinpod MUST NOT
  treat them as its authoritative scheduler state.

## 11. Issue Tracker Integration Contract (Linear-Compatible)

### 11.1 REQUIRED Operations

An implementation MUST support these tracker adapter operations:

1. `fetch_candidate_issues()`
   - Return issues in configured active states for a configured project.

2. `fetch_issues_by_states(state_names)`
   - Used for startup terminal cleanup.

3. `fetch_issue_states_by_ids(issue_ids)`
   - Used for active-run reconciliation.

### 11.2 Query Semantics (Linear)

Linear-specific requirements for `tracker.kind == "linear"`:

- `tracker.kind == "linear"`
- GraphQL endpoint (default `https://api.linear.app/graphql`)
- Auth token sent in `Authorization` header
- `tracker.project_slug` maps to Linear project `slugId`
- Candidate issue query filters project using `project: { slugId: { eq: $projectSlug } }`
- Candidate and issue-state refresh queries include issue labels. Required
  label filtering happens after normalization so refresh can observe label
  removal and stop or release existing work.
- Issue-state refresh query uses GraphQL issue IDs with variable type `[ID!]`
- Pagination REQUIRED for candidate issues
- Page size default: `50`
- Network timeout: `30000 ms`

Important:

- Linear GraphQL schema details can drift. Keep query construction isolated and test the exact query
  fields/types REQUIRED by this specification.

A non-Linear implementation MAY change transport details, but the normalized outputs MUST match the
domain model in Section 4.

### 11.3 Normalization Rules

Candidate issue normalization SHOULD produce fields listed in Section 4.1.1.

Additional normalization details:

- Label names are trimmed and lowercased.

- `labels` -> lowercase strings
- `blocked_by` -> derived from inverse relations where relation type is `blocks`
- `priority` -> integer only (non-integers become null)
- `created_at` and `updated_at` -> parse ISO-8601 timestamps

### 11.4 Error Handling Contract

RECOMMENDED error categories:

- `unsupported_tracker_kind`
- `missing_tracker_api_key`
- `missing_tracker_project_slug`
- `linear_api_request` (transport failures)
- `linear_api_status` (non-200 HTTP)
- `linear_graphql_errors`
- `linear_unknown_payload`
- `linear_missing_end_cursor` (pagination integrity error)

Orchestrator behavior on tracker errors:

- Candidate fetch failure: log and skip dispatch for this tick.
- Running-state refresh failure: log and keep active workers running.
- Startup terminal cleanup failure: log warning and continue startup.

### 11.5 Tracker Writes (Important Boundary)

Twinpod does not require first-class tracker write APIs in the orchestrator.

- Ticket mutations (state transitions, comments, PR metadata) are typically handled by the coding
  agent using tools defined by the workflow prompt.
- The service remains a scheduler/runner and tracker reader.
- Workflow-specific success often means "reached the next handoff state" (for example
  `Human Review`) rather than tracker terminal state `Done`.
- If the `linear_graphql` client-side tool extension is implemented, it is still part of the agent
  toolchain rather than orchestrator business logic.

## 12. Prompt Construction and Context Assembly

### 12.1 Inputs

Inputs to prompt rendering:

- `workflow.prompt_template`
- normalized `issue` object
- OPTIONAL `attempt` integer (retry/continuation metadata)

### 12.2 Rendering Rules

- Render with strict variable checking.
- Render with strict filter checking.
- Convert issue object keys to strings for template compatibility.
- Preserve nested arrays/maps (labels, blockers) so templates can iterate.

### 12.3 Retry/Continuation Semantics

`attempt` SHOULD be passed to the template because the workflow prompt can provide different
instructions for:

- first run (`attempt` null or absent)
- continuation run after a successful prior session
- retry after error/timeout/stall

### 12.4 Failure Semantics

If prompt rendering fails:

- Fail the run attempt immediately.
- Let the orchestrator treat it like any other worker failure and decide retry behavior.

## 13. Logging, Status, and Observability

### 13.1 Logging Conventions

REQUIRED context fields for issue-related logs:

- `issue_id`
- `issue_identifier`

REQUIRED context for OpenCode session lifecycle logs:

- `session_id`

Message formatting requirements:

- Use stable `key=value` phrasing.
- Include action outcome (`completed`, `failed`, `retrying`, etc.).
- Include concise failure reason when present.
- Avoid logging large raw payloads unless necessary.

### 13.2 Logging Outputs and Sinks

The spec does not prescribe where logs are written (stderr, file, remote sink, etc.).

Requirements:

- Operators MUST be able to see startup/validation/dispatch failures without attaching a debugger.
- Implementations MAY write to one or more sinks.
- If a configured log sink fails, the service SHOULD continue running when possible and emit an
  operator-visible warning through any remaining sink.

### 13.3 Runtime Snapshot / Monitoring Interface (OPTIONAL but RECOMMENDED)

If the implementation exposes a synchronous runtime snapshot (for dashboards or monitoring), it
SHOULD return:

- `running` (list of running session rows)
- each running row SHOULD include `turn_count`
- `retrying` (list of retry queue rows)
- session and retry rows SHOULD include the tracker-provided issue URL when available
- `opencode_totals`
  - `input_tokens`
  - `output_tokens`
  - `total_tokens`
  - `seconds_running` (aggregate runtime seconds as of snapshot time, including active sessions)
- `rate_limits` (latest OpenCode/model-provider rate-limit payload, if available)

RECOMMENDED snapshot error modes:

- `timeout`
- `unavailable`

### 13.4 OPTIONAL Human-Readable Status Surface

A human-readable status surface (terminal output, dashboard, etc.) is OPTIONAL and
implementation-defined.

If present, it SHOULD draw from orchestrator state/metrics only and MUST NOT be REQUIRED for
correctness.

### 13.5 OpenCode Session Metrics and Token Accounting

Token accounting rules:

- OpenCode events, message responses, exported sessions, or provider metadata can include token
  counts in multiple payload shapes.
- Prefer absolute session/message totals when available.
- Ignore delta-style payloads for dashboard/API totals unless the event type clearly defines them as
  deltas.
- Extract input/output/total token counts leniently from common field names within the selected
  payload.
- For absolute totals, track deltas relative to last reported totals to avoid double-counting.
- Do not treat generic `usage` maps as cumulative totals unless the event type defines them that
  way.
- Accumulate aggregate totals in orchestrator state.

Runtime accounting:

- Runtime SHOULD be reported as a live aggregate at snapshot/render time.
- Implementations MAY maintain a cumulative counter for ended sessions and add active-session
  elapsed time derived from `running` entries (for example `started_at`) when producing a
  snapshot/status view.
- Add run duration seconds to the cumulative ended-session runtime when a session ends (normal exit
  or cancellation/termination).
- Continuous background ticking of runtime totals is not REQUIRED.

Rate-limit tracking:

- Track the latest rate-limit payload seen in any OpenCode/provider update, if available.
- Any human-readable presentation of rate-limit data is implementation-defined.

### 13.6 Humanized Agent Event Summaries (OPTIONAL)

Humanized summaries of raw agent protocol events are OPTIONAL.

If implemented:

- Treat them as observability-only output.
- Do not make orchestrator logic depend on humanized strings.

### 13.7 OPTIONAL HTTP Server Extension

This section defines an OPTIONAL HTTP interface for observability and operational control.

If implemented:

- The HTTP server is an extension and is not REQUIRED for conformance.
- The implementation MAY serve server-rendered HTML or a client-side application for the dashboard.
- The dashboard/API MUST be observability/control surfaces only and MUST NOT become REQUIRED for
  orchestrator correctness.

Extension config:

- `server.port` (integer, OPTIONAL)
  - Enables the HTTP server extension.
  - `0` requests an ephemeral port for local development and tests.
  - CLI `--port` overrides `server.port` when both are present.

Enablement (extension):

- Start the HTTP server when a CLI `--port` argument is provided.
- Start the HTTP server when `server.port` is present in `WORKFLOW.md` front matter.
- The `server` top-level key is owned by this extension.
- Positive `server.port` values bind that port.
- Implementations SHOULD bind loopback by default (`127.0.0.1` or host equivalent) unless explicitly
  configured otherwise.
- Changes to HTTP listener settings (for example `server.port`) do not need to hot-rebind;
  restart-required behavior is conformant.

#### 13.7.1 Human-Readable Dashboard (`/`)

- Host a human-readable dashboard at `/`.
- The returned document SHOULD depict the current state of the system (for example active sessions,
  retry delays, token consumption, runtime totals, recent events, and health/error indicators).
- It is up to the implementation whether this is server-generated HTML or a client-side app that
  consumes the JSON API below.

#### 13.7.2 JSON REST API (`/api/v1/*`)

Provide a JSON REST API under `/api/v1/*` for current runtime state and operational debugging.

Minimum endpoints:

- `GET /api/v1/state`
  - Returns a summary view of the current system state (running sessions, retry queue/delays,
    aggregate token/runtime totals, latest rate limits, and any additional tracked summary fields).
  - Suggested response shape:

    ```json
    {
      "generated_at": "2026-02-24T20:15:30Z",
      "counts": {
        "running": 2,
        "retrying": 1
      },
      "running": [
        {
          "issue_id": "abc123",
          "issue_identifier": "MT-649",
          "issue_url": "https://tracker.example/issues/MT-649",
          "state": "In Progress",
          "session_id": "session-1-message-1",
          "turn_count": 7,
          "last_event": "message_completed",
          "last_message": "",
          "started_at": "2026-02-24T20:10:12Z",
          "last_event_at": "2026-02-24T20:14:59Z",
          "tokens": {
            "input_tokens": 1200,
            "output_tokens": 800,
            "total_tokens": 2000
          }
        }
      ],
      "retrying": [
        {
          "issue_id": "def456",
          "issue_identifier": "MT-650",
          "issue_url": "https://tracker.example/issues/MT-650",
          "attempt": 3,
          "due_at": "2026-02-24T20:16:00Z",
          "error": "no available orchestrator slots"
        }
      ],
      "opencode_totals": {
        "input_tokens": 5000,
        "output_tokens": 2400,
        "total_tokens": 7400,
        "seconds_running": 1834.2
      },
      "rate_limits": null
    }
    ```

- `GET /api/v1/<issue_identifier>`
  - Returns issue-specific runtime/debug details for the identified issue, including any information
    the implementation tracks that is useful for debugging.
  - Suggested response shape:

    ```json
    {
      "issue_identifier": "MT-649",
      "issue_id": "abc123",
      "status": "running",
      "workspace": {
        "path": "/tmp/twinpod_workspaces/MT-649"
      },
      "attempts": {
        "restart_count": 1,
        "current_retry_attempt": 2
      },
      "running": {
        "session_id": "session-1-message-1",
        "turn_count": 7,
        "state": "In Progress",
        "started_at": "2026-02-24T20:10:12Z",
        "last_event": "notification",
        "last_message": "Working on tests",
        "last_event_at": "2026-02-24T20:14:59Z",
        "tokens": {
          "input_tokens": 1200,
          "output_tokens": 800,
          "total_tokens": 2000
        }
      },
      "retry": null,
      "logs": {
        "opencode_session_logs": [
          {
            "label": "latest",
            "path": "/var/log/twinpod/opencode/MT-649/latest.log",
            "url": null
          }
        ]
      },
      "recent_events": [
        {
          "at": "2026-02-24T20:14:59Z",
          "event": "notification",
          "message": "Working on tests"
        }
      ],
      "last_error": null,
      "tracked": {}
    }
    ```

  - If the issue is unknown to the current in-memory state, return `404` with an error response (for
    example `{\"error\":{\"code\":\"issue_not_found\",\"message\":\"...\"}}`).

- `POST /api/v1/refresh`
  - Queues an immediate tracker poll + reconciliation cycle (best-effort trigger; implementations
    MAY coalesce repeated requests).
  - Suggested request body: empty body or `{}`.
  - Suggested response (`202 Accepted`) shape:

    ```json
    {
      "queued": true,
      "coalesced": false,
      "requested_at": "2026-02-24T20:15:30Z",
      "operations": ["poll", "reconcile"]
    }
    ```

API design notes:

- The JSON shapes above are the RECOMMENDED baseline for interoperability and debugging ergonomics.
- Implementations MAY add fields, but SHOULD avoid breaking existing fields within a version.
- Endpoints SHOULD be read-only except for operational triggers like `/refresh`.
- Unsupported methods on defined routes SHOULD return `405 Method Not Allowed`.
- API errors SHOULD use a JSON envelope such as `{"error":{"code":"...","message":"..."}}`.
- If the dashboard is a client-side app, it SHOULD consume this API rather than duplicating state
  logic.

## 14. Failure Model and Recovery Strategy

### 14.1 Failure Classes

1. `Workflow/Config Failures`
   - Missing `WORKFLOW.md`
   - Invalid YAML front matter
   - Unsupported tracker kind or missing tracker credentials/project slug
   - Missing OpenCode executable or unavailable OpenCode server

2. `Workspace Failures`
   - Workspace directory creation failure
   - Workspace population/synchronization failure (implementation-defined; can come from hooks)
   - Invalid workspace path configuration
   - Hook timeout/failure

3. `Agent Session Failures`
   - Startup handshake failure
   - Turn failed/cancelled
   - Turn timeout
   - User input requested and handled as failure by the implementation's documented policy
   - OpenCode server exit or unhealthy server
   - Stalled session (no activity)

4. `Tracker Failures`
   - API transport errors
   - Non-200 status
   - GraphQL errors
   - malformed payloads

5. `Observability Failures`
   - Snapshot timeout
   - Dashboard render errors
   - Log sink configuration failure

### 14.2 Recovery Behavior

- Dispatch validation failures:
  - Skip new dispatches.
  - Keep service alive.
  - Continue reconciliation where possible.

- Worker failures:
  - Convert to retries with exponential backoff.

- Tracker candidate-fetch failures:
  - Skip this tick.
  - Try again on next tick.

- Reconciliation state-refresh failures:
  - Keep current workers.
  - Retry on next tick.

- Dashboard/log failures:
  - Do not crash the orchestrator.

### 14.3 Partial State Recovery (Restart)

Current design is intentionally in-memory for scheduler state.
Restart recovery means the service can resume useful operation by polling tracker state and reusing
preserved workspaces. It does not mean retry timers, running sessions, or live worker state survive
process restart.

After restart:

- No retry timers are restored from prior process memory.
- No running sessions are assumed recoverable.
- Service recovers by:
  - startup terminal workspace cleanup
  - fresh polling of active issues
  - re-dispatching eligible work

### 14.4 Operator Intervention Points

Operators can control behavior by:

- Editing `WORKFLOW.md` (prompt and most runtime settings).
- `WORKFLOW.md` changes are detected and re-applied automatically without restart according to
  Section 6.2.
- Changing issue states in the tracker:
  - terminal state -> running session is stopped and workspace cleaned when reconciled
  - non-active state -> running session is stopped without cleanup
- Restarting the service for process recovery or deployment (not as the normal path for applying
  workflow config changes).

## 15. Security and Operational Safety

### 15.1 Trust Boundary Assumption

Each implementation defines its own trust boundary.

Operational safety requirements:

- Implementations SHOULD state clearly whether they are intended for trusted environments, more
  restrictive environments, or both.
- Implementations SHOULD state clearly whether they rely on auto-approved actions, operator
  approvals, stricter sandboxing, or some combination of those controls.
- Workspace isolation and path validation are important baseline controls, but they are not a
  substitute for whatever approval and sandbox policy an implementation chooses.

### 15.2 Filesystem Safety Requirements

Mandatory:

- Workspace path MUST remain under configured workspace root.
- The effective OpenCode session/message directory MUST be the per-issue workspace path for the current run.
- Workspace directory names MUST use sanitized identifiers.

RECOMMENDED additional hardening for hosts:

- Run under a dedicated OS user.
- Restrict workspace root permissions.
- Mount workspace root on a dedicated volume if possible.

### 15.3 Secret Handling

- Support `$VAR` indirection in workflow config.
- Do not log API tokens or secret env values.
- Validate presence of secrets without printing them.

### 15.4 Hook Script Safety

Workspace hooks are arbitrary shell scripts from `WORKFLOW.md`.

Implications:

- Hooks are fully trusted configuration.
- Hooks run inside the workspace directory.
- Hook output SHOULD be truncated in logs.
- Hook timeouts are REQUIRED to avoid hanging the orchestrator.

### 15.5 Harness Hardening Guidance

Running OpenCode agents against repositories, issue trackers, and other inputs that can contain
sensitive data or externally-controlled content can be dangerous. A permissive deployment can lead
to data leaks, destructive mutations, or full machine compromise if the agent is induced to execute
harmful commands or use overly-powerful integrations.

Implementations SHOULD explicitly evaluate their own risk profile and harden the execution harness
where appropriate. This specification intentionally does not mandate a single hardening posture, but
implementations SHOULD NOT assume that tracker data, repository contents, prompt inputs, tool
arguments, OpenCode config, or MCP/custom-tool inputs are fully trustworthy just because they
originate inside a normal workflow.

Possible hardening measures include:

- Tightening OpenCode permissions instead of relying on `--auto` for broad auto-approval.
- Using a custom OpenCode agent with only the tools required for the workflow.
- Denying dangerous shell patterns in OpenCode permission config.
- Using OpenCode `plan` or a read-only custom agent for analysis/review workflows.
- Disabling or limiting OpenCode custom tools, plugins, and MCP servers to the minimum set needed.
- Adding external isolation layers such as OS/container/VM sandboxing, network restrictions, or
  separate credentials beyond OpenCode's permission controls.
- Binding `opencode serve` only to loopback unless remote access is intentionally configured and
  authenticated.
- Filtering which Linear issues, projects, teams, labels, or other tracker sources are eligible for
  dispatch so untrusted or out-of-scope tasks do not automatically reach the agent.
- Narrowing the `linear_graphql` OpenCode tool/MCP server so it can only read or mutate data inside
  the intended project scope.
- Reducing the set of credentials, filesystem paths, network destinations, and provider accounts
  available to OpenCode to the minimum needed for the workflow.

The correct controls are deployment-specific, but implementations SHOULD document them clearly and
treat harness hardening as part of the core safety model rather than an optional afterthought.

## 16. Reference Algorithms (Language-Agnostic)

### 16.1 Service Startup

```text
function start_service():
  configure_logging()
  start_observability_outputs()
  start_workflow_watch(on_change=reload_and_reapply_workflow)

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    max_concurrent_agents: get_config_max_concurrent_agents(),
    running: {},
    claimed: set(),
    retry_attempts: {},
    completed: set(),
    opencode_totals: {input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
    opencode_rate_limits: null,
    opencode_server: null
  }

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  state.opencode_server = opencode_server.ensure_started_and_healthy()
  if state.opencode_server failed:
    log_opencode_server_error(state.opencode_server)
    fail_startup(state.opencode_server)

  startup_terminal_workspace_cleanup()
  schedule_tick(delay_ms=0)

  event_loop(state)
```

### 16.2 Poll-and-Dispatch Tick

```text
on_tick(state):
  state = reconcile_running_issues(state)

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  issues = tracker.fetch_candidate_issues()
  if issues failed:
    log_tracker_error()
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  for issue in sort_for_dispatch(issues):
    if no_available_slots(state):
      break

    if should_dispatch(issue, state):
      state = dispatch_issue(issue, state, attempt=null)

  notify_observers()
  schedule_tick(state.poll_interval_ms)
  return state
```

### 16.3 Reconcile Active Runs

```text
function reconcile_running_issues(state):
  state = reconcile_stalled_runs(state)

  running_ids = keys(state.running)
  if running_ids is empty:
    return state

  refreshed = tracker.fetch_issue_states_by_ids(running_ids)
  if refreshed failed:
    log_debug("keep workers running")
    return state

  for issue in refreshed:
    if issue.state in terminal_states:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=true)
    else if issue.state in active_states:
      state.running[issue.id].issue = issue
    else:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=false)

  return state
```

### 16.4 Dispatch One Issue

```text
function dispatch_issue(issue, state, attempt):
  worker = spawn_worker(
    fn -> run_agent_attempt(issue, attempt, parent_orchestrator_pid) end
  )

  if worker spawn failed:
    return schedule_retry(state, issue.id, next_attempt(attempt), {
      identifier: issue.identifier,
      error: "failed to spawn worker"
    })

  state.running[issue.id] = {
    worker_handle,
    monitor_handle,
    identifier: issue.identifier,
    issue,
    session_id: null,
    opencode_session_id: null,
    message_id: null,
    opencode_server_pid: null,
    opencode_server_url: state.opencode_server.url,
    current_stage: null,
    current_agent: null,
    permission_profile: null,
    last_opencode_message: null,
    last_opencode_event: null,
    last_opencode_timestamp: null,
    opencode_input_tokens: 0,
    opencode_output_tokens: 0,
    opencode_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    retry_attempt: normalize_attempt(attempt),
    started_at: now_utc()
  }

  state.claimed.add(issue.id)
  state.retry_attempts.remove(issue.id)
  return state
```

### 16.5 Worker Attempt (Workspace + Prompt + OpenCode Server Pipeline)

```text
function run_agent_attempt(issue, attempt, orchestrator_channel):
  server = opencode_server.ensure_healthy()
  if server failed:
    fail_worker("opencode server unavailable")

  workspace = workspace_manager.create_for_issue(issue.identifier)
  if workspace failed:
    fail_worker("workspace error")

  if workspace.path is not inside workspace.root:
    fail_worker("invalid workspace path")

  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

  prompt = render_workflow_prompt(workflow_template, issue, attempt)
  if prompt failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("prompt error")

  session = opencode_server.create_or_continue_session(
    server=server,
    workspace=workspace.path,
    title=format("%s: %s", issue.identifier, issue.title)
  )
  if session failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("opencode session startup error")

  pipeline = config.opencode.pipeline
  cycle = 1
  stage_results = {}

  while cycle <= config.opencode.max_pipeline_cycles:
    for stage in pipeline:
      resolved_profile = resolve_permission_profile(stage.permission_profile)
      stage_prompt = build_stage_prompt(
        base_prompt=prompt,
        issue=issue,
        attempt=attempt,
        stage=stage,
        stage_results=stage_results,
        cycle=cycle
      )

      send(orchestrator_channel, {
        opencode_update,
        issue.id,
        {event: "stage_started", stage: stage.name, agent: stage.agent}
      })

      result = opencode_server.run_message(
        server=server,
        session=session,
        workspace=workspace.path,
        agent=stage.agent,
        model=stage.model or config.opencode.model,
        permission_profile=resolved_profile,
        prompt=stage_prompt,
        on_event=(msg) -> send(orchestrator_channel, {opencode_update, issue.id, msg})
      )

      if result failed:
        run_hook_best_effort("after_run", workspace.path)
        if stage.required:
          fail_worker(format("stage failed: %s", stage.name))
        else:
          stage_results[stage.name] = summarize_optional_failure(result)
          continue

      stage_results[stage.name] = summarize_stage_result(result)

      if stage.name == "review" and result.requires_executor_retry:
        if cycle < config.opencode.max_pipeline_cycles:
          cycle = cycle + 1
          continue while_loop
        else:
          run_hook_best_effort("after_run", workspace.path)
          fail_worker("review requested changes but pipeline cycle limit reached")

    break

  refreshed_issue = tracker.fetch_issue_states_by_ids([issue.id])
  if refreshed_issue failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("issue state refresh error")

  issue = refreshed_issue[0] or issue

  run_hook_best_effort("after_run", workspace.path)

  if issue.state is active:
    exit_normal()  # orchestrator schedules short continuation retry
  else:
    exit_normal()
```

### 16.6 Worker Exit and Retry Handling

```text
on_worker_exit(issue_id, reason, state):
  running_entry = state.running.remove(issue_id)
  state = add_runtime_seconds_to_totals(state, running_entry)

  if reason == normal:
    state.completed.add(issue_id)  # bookkeeping only
    state = schedule_retry(state, issue_id, 1, {
      identifier: running_entry.identifier,
      delay_type: continuation
    })
  else:
    state = schedule_retry(state, issue_id, next_attempt_from(running_entry), {
      identifier: running_entry.identifier,
      error: format("worker exited: %reason")
    })

  notify_observers()
  return state
```

```text
on_retry_timer(issue_id, state):
  retry_entry = state.retry_attempts.pop(issue_id)
  if missing:
    return state

  candidates = tracker.fetch_candidate_issues()
  if fetch failed:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: retry_entry.identifier,
      error: "retry poll failed"
    })

  issue = find_by_id(candidates, issue_id)
  if issue is null:
    state.claimed.remove(issue_id)
    return state

  if available_slots(state) == 0:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: issue.identifier,
      error: "no available orchestrator slots"
    })

  return dispatch_issue(issue, state, attempt=retry_entry.attempt)
```

## 17. Test and Validation Matrix

A conforming implementation SHOULD include tests that cover the behaviors defined in this
specification.

Validation profiles:

- `Core Conformance`: deterministic tests REQUIRED for all conforming implementations.
- `Extension Conformance`: REQUIRED only for OPTIONAL features that an implementation chooses to
  ship.
- `Real Integration Profile`: environment-dependent smoke/integration checks RECOMMENDED before
  production use.

Unless otherwise noted, Sections 17.1 through 17.7 are `Core Conformance`. Bullets that begin with
`If ... is implemented` are `Extension Conformance`.

### 17.1 Workflow and Config Parsing

- Workflow file path precedence:
  - explicit runtime path is used when provided
  - cwd default is `WORKFLOW.md` when no explicit runtime path is provided
- Workflow file changes are detected and trigger re-read/re-apply without restart
- Invalid workflow reload keeps last known good effective configuration and emits an
  operator-visible error
- Missing `WORKFLOW.md` returns typed error
- Invalid YAML front matter returns typed error
- Front matter non-map returns typed error
- Config defaults apply when OPTIONAL values are missing
- `tracker.kind` validation enforces currently supported kind (`linear`)
- `tracker.api_key` works (including `$VAR` indirection)
- `$VAR` resolution works for tracker API key and path values
- `~` path expansion works
- `opencode.command` is preserved as a shell command string
- Per-state concurrency override map normalizes state names and ignores invalid values
- Prompt template renders `issue` and `attempt`
- Prompt rendering fails on unknown variables (strict mode)

### 17.2 Workspace Manager and Safety

- Deterministic workspace path per issue identifier
- Missing workspace directory is created
- Existing workspace directory is reused
- Existing non-directory path at workspace location is handled safely (replace or fail per
  implementation policy)
- OPTIONAL workspace population/synchronization errors are surfaced
- `after_create` hook runs only on new workspace creation
- `before_run` hook runs before each attempt and failure/timeouts abort the current attempt
- `after_run` hook runs after each attempt and failure/timeouts are logged and ignored
- `before_remove` hook runs on cleanup and failures/timeouts are ignored
- Workspace path sanitization and root containment invariants are enforced before OpenCode session/message creation
- OpenCode session/message creation uses the per-issue workspace path and rejects out-of-root paths

### 17.3 Issue Tracker Client

- Candidate issue fetch uses active states and project slug
- Linear query uses the specified project filter field (`slugId`)
- Empty `fetch_issues_by_states([])` returns empty without API call
- Pagination preserves order across multiple pages
- Blockers are normalized from inverse relations of type `blocks`
- Labels are normalized to lowercase
- Issue state refresh by ID returns minimal normalized issues
- Issue state refresh query uses GraphQL ID typing (`[ID!]`) as specified in Section 11.2
- Error mapping for request errors, non-200, GraphQL errors, malformed payloads

### 17.4 Orchestrator Dispatch, Reconciliation, and Retry

- Dispatch sort order is priority then oldest creation time
- `Todo` issue with non-terminal blockers is not eligible
- `Todo` issue with terminal blockers is eligible
- Active-state issue refresh updates running entry state
- Non-active state stops the running OpenCode session without workspace cleanup
- Terminal state stops the running OpenCode session and cleans workspace
- Reconciliation with no running issues is a no-op
- Normal worker exit schedules a short continuation retry (attempt 1)
- Abnormal worker exit increments retries with 10s-based exponential backoff
- Retry backoff cap uses configured `agent.max_retry_backoff_ms`
- Retry queue entries include attempt, due time, identifier, and error
- Stall detection cancels stalled OpenCode sessions/messages and schedules retry
- Slot exhaustion requeues retries with explicit error reason
- If a snapshot API is implemented, it returns running rows, retry rows, token totals, and rate
  limits
- If a snapshot API is implemented, timeout/unavailable cases are surfaced

### 17.5 OpenCode Server, Pipeline, and Policy Bundle

- Twinpod starts or attaches to a long-lived OpenCode server before dispatch.
- OpenCode server health/readiness is checked before issue sessions are created.
- Twinpod reuses the same long-lived server across multiple issue attempts.
- Twinpod does not start a fresh OpenCode runtime per issue attempt or per turn.
- Server authentication via configured username/password env vars works when enabled.
- Workspace path is passed to OpenCode for each issue session/message using the targeted server API.
- Workspace path containment is enforced before sending the path to OpenCode.
- If per-session workspace scoping is unavailable, implementation fails safely or uses a documented
  long-lived isolated server boundary.
- Session and message IDs exposed by the OpenCode server are extracted and used in runtime events.
- Request/response read timeout is enforced.
- Turn/stage timeout is enforced.
- Event stream handling updates last-event timestamps and does not duplicate turns on reconnect.
- Permission profiles compile to OpenCode-native `permission` config.
- `high_trust`, `restricted`, and `review_only` profiles exist or are explicitly documented.
- Explicit deny rules override auto-approval.
- Planner stage uses a read-only permission profile.
- Executor stage can use the configured build/execution permissions.
- Reviewer stage uses a read-only permission profile.
- Pipeline stage order, per-stage agent selection, and per-stage model override work.
- Reviewer-to-executor loop is bounded by `opencode.max_pipeline_cycles`.
- User input requests and permission prompts do not stall indefinitely.
- Twinpod OpenCode plugin loads when enabled.
- Required plugin load failure fails startup or dispatch preflight.
- Non-required plugin load failure is operator-visible but non-fatal.
- Plugin emits session/tool/permission events when enabled.
- Secret protection blocks or fails `.env` reads when configured.
- Formatter config is generated/enabled when `opencode.quality.formatter` is true.
- Formatter failures are surfaced in logs and stage results.
- LSP config is optional and, when enabled, diagnostics are surfaced when available.
- Required LSP setup failure fails startup or dispatch preflight.
- Generated OpenCode config includes watcher ignores, compaction policy, disabled providers,
  instructions, MCP config, plugins, and environment fragments as configured.
- Generated OpenCode config does not log secrets or overwrite repository-owned config unless
  explicitly configured.
- Usage and rate-limit telemetry exposed by the OpenCode server/plugin is extracted.
- If the `linear_graphql` client-side tool extension is implemented:
  - the tool is available through OpenCode-native custom tool, plugin, or MCP configuration
  - valid `query` / `variables` inputs execute against configured Linear auth
  - top-level GraphQL `errors` produce `success=false` while preserving the GraphQL body
  - invalid arguments, missing auth, and transport failures return structured failure payloads
  - unsupported tool names still fail without stalling the session

### 17.6 Observability

- Validation failures are operator-visible
- Structured logging includes issue/session context fields
- Logging sink failures do not crash orchestration
- Token/rate-limit aggregation remains correct across repeated agent updates
- If a human-readable status surface is implemented, it is driven from orchestrator state and does
  not affect correctness
- If humanized event summaries are implemented, they cover key wrapper/agent event classes without
  changing orchestrator behavior

### 17.7 CLI and Host Lifecycle

- CLI accepts a positional workflow path argument (`path-to-WORKFLOW.md`)
- CLI uses `./WORKFLOW.md` when no workflow path argument is provided
- CLI errors on nonexistent explicit workflow path or missing default `./WORKFLOW.md`
- CLI surfaces startup failure cleanly
- CLI exits with success when application starts and shuts down normally
- CLI exits nonzero when startup fails or the host process exits abnormally

### 17.8 Real Integration Profile (RECOMMENDED)

These checks are RECOMMENDED for production readiness and MAY be skipped in CI when credentials,
network access, or external service permissions are unavailable.

- A real tracker smoke test can be run with valid credentials supplied by `LINEAR_API_KEY` or a
  documented local bootstrap mechanism (for example `~/.linear_api_key`).
- Real integration tests SHOULD use isolated test identifiers/workspaces and clean up tracker
  artifacts when practical.
- A skipped real-integration test SHOULD be reported as skipped, not silently treated as passed.
- If a real-integration profile is explicitly enabled in CI or release validation, failures SHOULD
  fail that job.

## 18. Implementation Checklist (Definition of Done)

Use the same validation profiles as Section 17:

- Section 18.1 = `Core Conformance`
- Section 18.2 = `Extension Conformance`
- Section 18.3 = `Real Integration Profile`

### 18.1 REQUIRED for Conformance

- Workflow path selection supports explicit runtime path and cwd default
- `WORKFLOW.md` loader with YAML front matter + prompt body split
- Typed config layer with defaults and `$` resolution
- Dynamic `WORKFLOW.md` watch/reload/re-apply for config and prompt
- Polling orchestrator with single-authority mutable state
- Issue tracker client with candidate fetch + state refresh + terminal fetch
- Workspace manager with sanitized per-issue workspaces
- Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
- Hook timeout config (`hooks.timeout_ms`, default `60000`)
- Long-lived OpenCode server lifecycle manager (`opencode serve`)
- OpenCode server health checks, authentication, restart/backoff, and runtime state tracking
- OpenCode server client for session/message creation, continuation, cancellation, and events
- Generated OpenCode config bundle or equivalent config composition path
- OpenCode permission profiles: `high_trust`, `restricted`, `review_only`
- Default agent pipeline: planner, executor, reviewer
- OpenCode plugin extension hook points or documented no-plugin fallback
- Formatter config support
- Optional LSP config support with safe failure semantics
- Watcher-ignore and compaction/config-hygiene support
- Strict prompt rendering with `issue` and `attempt` variables
- Exponential retry queue with continuation retries after normal exit
- Configurable retry backoff cap (`agent.max_retry_backoff_ms`, default 5m)
- Reconciliation that stops runs on terminal/non-active tracker states
- Workspace cleanup for terminal issues (startup sweep + active transition)
- Structured logs with `issue_id`, `issue_identifier`, and `session_id`
- Operator-visible observability (structured logs; OPTIONAL snapshot/status surface)

### 18.2 RECOMMENDED Extensions (Not REQUIRED for Conformance)

- HTTP server extension honors CLI `--port` over `server.port`, uses a safe default bind host, and
  exposes the baseline endpoints/error semantics in Section 13.7 if shipped.
- `linear_graphql` client-side tool extension exposes raw Linear GraphQL access through the
  OpenCode session using configured Twinpod auth.
- TODO: Persist retry queue and session metadata across process restarts.
- TODO: Make observability settings configurable in workflow front matter without prescribing UI
  implementation details.
- TODO: Add first-class tracker write APIs (comments/state transitions) in the orchestrator instead
  of only via agent tools.
- TODO: Add pluggable issue tracker adapters beyond Linear.

### 18.3 Operational Validation Before Production (RECOMMENDED)

- Run the `Real Integration Profile` from Section 17.8 with valid credentials and network access.
- Verify hook execution and workflow path resolution on the target host OS/shell environment.
- If the OPTIONAL HTTP server is shipped, verify the configured port behavior and loopback/default
  bind expectations on the target environment.

## Appendix A. SSH Worker Extension (OPTIONAL)

This appendix describes a common extension profile in which Twinpod keeps one central
orchestrator but executes worker runs on one or more remote hosts over SSH.

Extension config:

- `worker.ssh_hosts` (list of SSH host strings, OPTIONAL)
  - When omitted, work runs locally.
- `worker.max_concurrent_agents_per_host` (positive integer, OPTIONAL)
  - Shared per-host cap applied across configured SSH hosts.

### A.1 Execution Model

- The orchestrator remains the single source of truth for polling, claims, retries, and
  reconciliation.
- `worker.ssh_hosts` provides the candidate SSH destinations for remote execution.
- Each worker run is assigned to one host at a time, and that host becomes part of the run's
  effective execution identity along with the issue workspace.
- `workspace.root` is interpreted on the remote host, not on the orchestrator host.
- A long-lived OpenCode server is started or attached on the remote host. The orchestrator owns
  session lifecycle and dispatches issue sessions to that host-scoped server.
- Continuation turns inside one worker lifetime SHOULD stay on the same host and workspace.
- A remote host SHOULD satisfy the same basic contract as a local worker environment: reachable
  shell, writable workspace root, OpenCode executable/server, and any required auth or repository
  prerequisites.

### A.2 Scheduling Notes

- SSH hosts MAY be treated as a pool for dispatch.
- Implementations MAY prefer the previously used host on retries when that host is still
  available.
- `worker.max_concurrent_agents_per_host` is an OPTIONAL shared per-host cap across configured SSH
  hosts.
- When all SSH hosts are at capacity, dispatch SHOULD wait rather than silently falling back to a
  different execution mode.
- Implementations MAY fail over to another host when the original host is unavailable before work
  has meaningfully started.
- Once a run has already produced side effects, a transparent rerun on another host SHOULD be
  treated as a new attempt, not as invisible failover.

### A.3 Problems to Consider

- Remote environment drift:
  - Each host needs the expected shell environment, OpenCode executable/server, auth, and repository
    prerequisites.
- Workspace locality:
  - Workspaces are usually host-local, so moving an issue to a different host is typically a cold
    restart unless shared storage exists.
- Path and command safety:
  - Remote path resolution, shell quoting, and workspace-boundary checks matter more once execution
    crosses a machine boundary.
- Startup and failover semantics:
  - Implementations SHOULD distinguish host-connectivity/startup failures from in-workspace agent
    failures so the same ticket is not accidentally re-executed on multiple hosts.
- Host health and saturation:
  - A dead or overloaded host SHOULD reduce available capacity, not cause duplicate execution or an
    accidental fallback to local work.
- Cleanup and observability:
  - Operators need to know which host owns a run, where its workspace lives, and whether cleanup
    happened on the right machine.
