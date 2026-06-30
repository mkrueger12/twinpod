# Twinpod — Specification

> An agentic coding orchestration layer on top of **OpenCode** that turns **Linear** issues into autonomous coding runs that produce pull requests. Modeled on OpenAI's **Symphony** concept (issue tracker as control plane).

Status: design spec (2026-06-30). Companion ideation artifact: [`docs/ideation/2026-06-30-twinpod-ideation.html`](docs/ideation/2026-06-30-twinpod-ideation.html).

---

## 1. Thesis & positioning

Twinpod watches Linear for qualifying issues, runs a class-specific workflow against each one with OpenCode, and produces a reviewable PR.

The **concept is already commoditized** — OpenAI Symphony (an open spec + reference impl) and Tembo (which already orchestrates OpenCode from Linear) exist, and the Linear plumbing + headless OpenCode invocation are both solved problems. Twinpod's value therefore comes from **execution**, not the concept:

- **Quality gating** — PRs only open when they're green (§9).
- **Opinionated, deterministic workflows** — high-level phases stepped through in order (§5–§6).
- **Concurrency isolation** — one git worktree per issue (§10).
- **Compounding learning** — a later moat: learn from merged/rejected outcomes (§14).

Differentiation is execution quality, not feature novelty.

---

## 2. Topology

A single **long-lived process** running on this server.

Main loop:
1. **Poll** Linear for qualifying issues (§3).
2. **Classify** each qualifying issue (§4).
3. **Run** the selected workflow against the issue (§5–§6), in an isolated worktree (§10).
4. **Ship** a green PR (§9) and report back to Linear.

Polling (not webhooks) is a deliberate choice: twinpod runs as a persistent process, so there is no webhook ack-window or public-endpoint concern. (Symphony chose polling for the same reason.)

---

## 3. Issue qualification (intake gate 1 — config-driven)

Determines **which issues enter the system at all** — a pure Linear query, no model involved. Configured per repo in `twinpod.yaml` (§13).

```yaml
# twinpod.yaml  (at the root of each managed repo)
intake:
  poll_interval: 30s
  sources:
    - project: "Twinpod Backlog"             # Linear project
      statuses: ["Ready for Agent"]          # qualifying workflow state(s)
      # repo is implicit — it is the repo this twinpod.yaml lives in
      # optional further filters:
      # team: "ENG"
      # labels: ["agent"]
      # priority_min: 2
  claim:
    in_progress: "Agent: In Progress"        # set on pickup → dedup + visibility
    review:      "Agent: In Review"           # set when PR opens
    failed:      "Agent: Needs Attention"     # set on andon-stop / budget exhausted
```

Rules:
- An issue **qualifies** when it matches a `source` (project + status + any optional filters) **and** is not already claimed or done (**dedup by issue ID**).
- The **target repo is implicit** — it's the repo whose `twinpod.yaml` declared the source. The orchestrator process polls each managed repo's `twinpod.yaml` and works that repo's qualifying issues.
- On pickup, twinpod transitions the issue to the `in_progress` status. **That status move is the claim** — it prevents re-selection and shows humans the issue is being worked. Status is the lifecycle signal end to end (`in_progress` → `review` → done, or → `failed`).
- Multiple `sources` are supported (several projects / statuses for the same repo).

---

## 4. Classification (intake gate 2 — model-driven)

A **cheap model** reads each qualifying issue and emits structured JSON (via OpenCode's `format: json_schema`):

```json
{ "runnable": true, "class": "bug", "risk": "low",
  "model_tier": "standard", "confidence": 0.82, "reasons": ["clear repro", "single module"] }
```

- `runnable: false` → post a "needs scoping" comment, set status back / to a needs-info state, **no run**.
- `class` selects the workflow (§5).
- `risk` can force a stronger agent and/or a plan-gate (§9).

Classification is the model-driven judgment layer; qualification (§3) is the config-driven filter that precedes it.

---

## 5. Workflows

A **workflow** is selected by the classifier's `class` output and defined in YAML as an ordered list of **phases**, stepped through **deterministically**.

```yaml
# workflows/feature.yaml
class: feature
phases:
  - id: design
    agent: design-agent
    prompt: prompts/design.md
    reads:  [issue.md]
    writes: [design.md]
  - id: planning
    agent: plan-agent
    prompt: prompts/planning.md
    reads:  [issue.md, design.md]
    writes: [plan.md]
  - id: implementation
    agent: build-agent
    prompt: prompts/implement.md
    reads:  [issue.md, design.md, plan.md]
    loop_until: ci_green
    budget: { usd: 2, cycles: 6 }
  - id: ship
    agent: ship-agent
    prompt: prompts/ship.md
    reads:  [issue.md, plan.md]
    gate: ci_green
```

Starting workflow set (one per `class`):

| Class | Workflow | What's different |
|---|---|---|
| `feature` | tdd-feature | RED → GREEN spine (failing test first) |
| `bug` | bug-fix | Same spine; phase 1 reproduces as a failing test |
| `refactor` | refactor | No new behavior; existing suite must stay green + a simplify pass |
| `docs` | docs | Lighter gate (build/lint/linkcheck), no test requirement |
| `chore` | chore | Deps/config; CI-green is the whole safety net |
| `unclear` / `risky` | — | No run (handled by classifier `runnable: false`) |

---

## 6. Phases

**Determinism between phases, agentic within a phase.** Twinpod steps the phases in fixed order; what happens *inside* each phase is up to the model.

Each phase runs as a **fresh OpenCode session** driven by twinpod via the SDK. A phase is:

- **`agent`** — an OpenCode agent (carries model + system prompt + permissions); see §13.
- **`prompt`** — the base-prompt template that launches the phase (§7).
- **`reads` / `writes`** — markdown handoff files (§8).
- optional **`gate` / `loop_until` / `budget`** — control (§9).

There is no per-phase `model` (it rides on the agent) and no per-phase `skills` config (skills are globally available and model-pulled; §8).

---

## 7. Prompting model (three layers per phase)

| Layer | What it is | Stable/per-run | OpenCode home |
|---|---|---|---|
| **System prompt** | Phase-agent persona + permissions | Stable | Agent def frontmatter |
| **Base prompt** | Task seed that launches the phase | Per-run (template) | Text sent to `session.prompt()` |
| **Skills** | Capability bundles pulled on demand | On-demand | `SKILL.md` via the `skill` tool |

Base prompts are **versioned template files** that interpolate run context (handoff files, issue ID, worktree path). Twinpod resolves `{{...}}` and sends the text as the phase's initial prompt.

```markdown
# prompts/design.md
Read {{reads}} for Linear issue {{issue_id}}.
Produce a technical design and write it to design.md.
Use the repo-map skill to understand structure before designing.
```

---

## 8. Skills

A skill is an **OpenCode-native `SKILL.md`** (name + description frontmatter + markdown body) in a skills dir (`.opencode/skills/<name>/` project, or `~/.config/opencode/skills/` global). Progressive disclosure: the agent sees skill names + descriptions and loads a body via the built-in `skill` tool only when relevant.

- Skills are **globally available** and **model-pulled** — not curated per phase.
- Governed coarsely by the agent's `permission.skill` (on/off) and nudged via the base prompt.
- Tradeoff accepted: no per-phase skill scoping.

---

## 9. Gates & control

- **CI-green terminal gate (mandatory).** The `ship` phase opens a PR only when the full suite passes in the worktree. The implementation phase loops toward green within a `budget` cap; on exhaustion → post the failure to Linear, set `failed` status, **no PR**. Humans only ever see green PRs.
- **CI command — auto-detected.** No required per-repo CI command. The implementation/ship agent (which has repo access and a base prompt instructing it to ensure CI is green) discovers and runs the suite itself. Optional deterministic auto-detection (inspect `package.json` scripts, `Makefile`, CI config) can assist; an explicit override in `twinpod.yaml` is allowed but not required.
- **Andon stop.** A phase that hits a non-fixable condition (broken env, broken test infra, ambiguity discovered mid-run) halts and escalates to Linear rather than shipping optimistic broken work.
- **Plan-gate — off for v1.** Deferred until the shape is clearer; the design keeps room to add a human plan-approval point after design/planning later.

---

## 10. Worktree isolation & lifecycle

**One issue = one dedicated git worktree.**

- Branch `twinpod/<issue-id>-<slug>`, cut from the issue's bound `repo` (§3).
- Created **idempotently**, keyed by issue ID — a crashed/resumed run re-attaches to the existing worktree instead of recreating (exactly-once; §12).
- The per-issue **run dir** (markdown handoff files) lives inside the worktree, gitignored.
- OpenCode sessions run with `cwd` = the worktree (agent/skill discovery traverses to the worktree root).
- N issues = N worktrees in parallel — this is the concurrency-isolation primitive.
- **Cleanup is a command, not automatic.** A `twinpod cleanup` command prunes worktrees whose branches have been merged (run on demand or scheduled). Worktrees are kept after a run so merged/abandoned work stays inspectable until cleanup runs.
- Note: a worktree gives **workspace** isolation, not **security** isolation. Fine for running own repos on own server; revisit ephemeral containers/microVMs only if running untrusted code.

---

## 11. Markdown handoff & run state

- Stages communicate via **markdown files** (`issue.md` → `design.md` → `plan.md` → …) in the per-issue run dir.
- The durable state every fresh phase inherits = **worktree (code) + Linear issue + handoff markdown**.
- Properties: auditable (inspect each phase's output after the fact), resumable (re-read existing markdown on restart), and a natural data source for the future outcome-learning flywheel (§14).
- Optionally mirror phase outputs to Linear as comments for live progress.

---

## 12. Concurrency & exactly-once

- Each run is keyed to the **Linear issue ID** (durable workflow ID).
- **Dedup:** a duplicate poll hit / already-claimed issue is a no-op.
- **Resume:** a crash mid-run re-attaches via the existing worktree + handoff markdown + issue status.
- **Durable substrate: Linear status + filesystem + git.** No external durable-execution engine (Temporal/Inngest). The durable log is the combination of the Linear issue status (claim/lifecycle), the on-disk handoff markdown, and the git worktree/branch state — twinpod reconstructs run state from these on restart.

---

## 13. OpenCode integration & binding

**Execution.** `opencode serve` runs once (long-lived); twinpod attaches via `@opencode-ai/sdk` (`opencode run --attach`) to avoid per-run cold start. Per phase: `session.create()` (fresh context) → `session.prompt({ agent, parts: [resolved base prompt + handoff refs], format: json_schema where structured })`, with `cwd` = the issue's worktree.

**Binding (Option A — reference + validate).** OpenCode config (`opencode.json` / `.opencode/agents/*.md`) is the source of truth for what an agent *is* (model, system prompt, permissions, skill perms). Workflow YAML only **references** agents by name.

**Hard requirement — referential integrity.** Every agent referenced in any workflow YAML must exist in the OpenCode config. At config load / startup, twinpod:
1. Collects the distinct `agent` values across all phases in all workflows.
2. Resolves the OpenCode agent registry (SDK `app.agents()`, or reads `opencode.json` + `.opencode/agents/`).
3. On any missing agent → **hard fail, refuse to start**, with an error naming the missing agent and the referencing workflow/phase.

No workflow can ever dispatch a phase to an agent OpenCode doesn't have. (Later extension: also assert each `prompt` template exists; optionally warn on defined-but-unreferenced agents.)

**Per-repo, co-located config.** Config lives **in each managed repo** (not central to twinpod). One repo carries both its OpenCode config and its twinpod config, and twinpod runs OpenCode against that repo:

```
<managed-repo>/
  twinpod.yaml             # intake/qualification (§3) + workflow config
  workflows/*.yaml         # phase sequences (or inline under twinpod.yaml) referencing agents by name
  prompts/*.md             # base-prompt templates
  .opencode/agents/*.md    # agents: model, system prompt, permissions, skill perms
  .opencode/skills/*/      # skills (SKILL.md)
```

The long-lived orchestrator process is pointed at one or more managed repos; each repo's `twinpod.yaml` declares which Linear issues it owns and which workflows apply. (v1 may manage just this repo.)

(To confirm at build time: exact SDK surface for selecting an agent on `session.prompt` vs. the `opencode run --agent` flag.)

### OpenCode primitive reference

| Primitive | What it is | Defined as |
|---|---|---|
| Skill | Reusable instruction bundle (no model/permissions) | `SKILL.md` + frontmatter in skills dirs |
| Agent | System prompt + model + permissions | Markdown frontmatter in `agents/`, or `opencode.json` |
| Plugin | Event-hook extension | JS/TS in `plugins/` or npm |
| Command | Templated slash-command prompt | `.md` in `commands/` or `opencode.json` |
| Custom Tool | TS function the LLM can call | TS/JS in `tools/` |
| MCP Server | External tool provider | Referenced in `opencode.json` |

---

## 14. Deferred / future (the moat)

These are intentionally *not* v1 — they need the core loop producing data first, but the system should be architected toward them.

- **Outcome-learning flywheel** *(the differentiation moat)* — every merged/rejected/abandoned PR is a labeled datapoint. Feed it back to (a) inject "why-rejected" lessons into future runs on similar files/labels, (b) route issues to the cheapest capable model by historical confidence, (c) accrue per-surface trust scores so well-performing areas graduate to unattended. Closed competitors structurally cannot expose this to self-hosters. The markdown handoff (§11) + Linear outcomes are the data source.
- **Cost budgets + phase-aware model routing** — transparent per-issue cost, per-stage budget gates; feeds the routing oracle above.
- **Review-ready "plating"** — normalize PRs into review-ready form (what/why, RED→GREEN evidence, risk notes) to cut review cost further.

---

## 15. Resolved decisions (were open questions)

1. **Config root** → **per repo**, in a `twinpod.yaml` at each managed repo's root (target repo is implicit). See §3, §13.
2. **Plan-gate** → **off for v1**; deferred. See §9.
3. **CI-green command** → **auto-detected** (the green-CI agent discovers and runs it; optional deterministic detection; optional `twinpod.yaml` override). See §9.
4. **Worktree cleanup** → a **`twinpod cleanup` command** that prunes merged worktrees; not automatic on merge. See §10.
5. **Status lifecycle / claim** → settled: status move on pickup is the claim (`in_progress` → `review` → done/`failed`). See §3.
6. **Durable substrate** → **Linear status + filesystem + git**; no Temporal. See §12.

---

## 16. Prior art (reference)

- **OpenAI Symphony** — open spec + Elixir reference impl; polling, namespace-per-issue dedup, supervisor/worker, lifecycle hooks, model-agnostic. Validates the pattern; also the competitive baseline.
- **OpenCode + Linear gist (ppries)** — closest prototype on this exact stack: worktree-per-issue, per-agent tool permissions + post-step file gate, RED/GREEN TDD, failure classification.
- **Tembo** — agent-agnostic orchestration that already runs OpenCode from Linear (self-host option).
- **Charlie Labs** — Linear-native autonomous engineer + always-on "Daemons".
- **OpenCode** — `opencode serve` HTTP/OpenAPI + `@opencode-ai/sdk`; agents/skills/plugins/commands/tools/MCP.
- **Linear** — Agents API / AgentSession; projects, workflow states, labels, GraphQL filtering.

See the ideation artifact for the full ranked analysis and the rejected directions.
