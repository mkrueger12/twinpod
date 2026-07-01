import os from "node:os";
import path from "node:path";
import { TwinpodError } from "./errors.js";
import { OpenCodeConfig, OpenCodePipelineStage, ServiceConfig, WorkflowDefinition } from "./types.js";
import {
  asBoolean,
  asInteger,
  asPositiveInteger,
  asRecord,
  asStringArray,
  normalizeLabel,
  normalizeState,
  resolveEnvReference,
  resolvePathValue,
} from "./util.js";

const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_WATCHER_IGNORE = [".git/**", "node_modules/**", "dist/**", "build/**", ".next/**", "coverage/**", ".twinpod/**"];

export function buildServiceConfig(workflow: WorkflowDefinition, env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const root = workflow.config;
  const workflowDir = path.dirname(workflow.path);
  const tracker = asRecord(root.tracker);
  const polling = asRecord(root.polling);
  const workspace = asRecord(root.workspace);
  const hooks = asRecord(root.hooks);
  const agent = asRecord(root.agent);
  const opencode = asRecord(root.opencode);
  const serverExtension = asRecord(root.server);
  if (!("server" in opencode) || !opencode.server || typeof opencode.server !== "object" || Array.isArray(opencode.server)) {
    throw new TwinpodError("missing_opencode_server", "opencode.server is required");
  }

  const kind = tracker.kind;
  if (kind !== "linear") throw new TwinpodError("unsupported_tracker_kind", "tracker.kind must be linear");

  const apiKeyRaw = tracker.api_key ?? env.LINEAR_API_KEY ?? "";
  const apiKey = String(resolveEnvReference(apiKeyRaw, env)).trim();
  const projectSlug = typeof tracker.project_slug === "string" ? tracker.project_slug.trim() : "";

  const workspaceRoot = resolvePathValue(workspace.root ?? path.join(os.tmpdir(), "twinpod_workspaces"), workflowDir, env);
  if (!workspaceRoot) throw new TwinpodError("invalid_workspace_root", "workspace.root resolved to an empty path");

  const server = asRecord(opencode.server);

  const effective: ServiceConfig = {
    workflowPath: workflow.path,
    workflowDir,
    tracker: {
      kind: "linear",
      endpoint: typeof tracker.endpoint === "string" && tracker.endpoint ? tracker.endpoint : "https://api.linear.app/graphql",
      apiKey,
      projectSlug,
      requiredLabels: asStringArray(tracker.required_labels).map(normalizeLabel).filter(Boolean),
      activeStates: asStringArray(tracker.active_states, DEFAULT_ACTIVE_STATES),
      terminalStates: asStringArray(tracker.terminal_states, DEFAULT_TERMINAL_STATES),
    },
    polling: {
      intervalMs: asPositiveInteger(polling.interval_ms, 30_000),
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: {
      afterCreate: typeof hooks.after_create === "string" ? hooks.after_create : null,
      beforeRun: typeof hooks.before_run === "string" ? hooks.before_run : null,
      afterRun: typeof hooks.after_run === "string" ? hooks.after_run : null,
      beforeRemove: typeof hooks.before_remove === "string" ? hooks.before_remove : null,
      timeoutMs: asPositiveInteger(hooks.timeout_ms, 60_000),
    },
    agent: {
      maxConcurrentAgents: asPositiveInteger(agent.max_concurrent_agents, 10),
      maxTurns: asPositiveInteger(agent.max_turns, 20),
      maxRetryBackoffMs: asPositiveInteger(agent.max_retry_backoff_ms, 300_000),
      maxConcurrentAgentsByState: parseStateConcurrency(agent.max_concurrent_agents_by_state),
    },
    opencode: parseOpenCodeConfig(opencode, server, workflowDir, env),
    httpServer: {
      port: serverExtension.port === undefined ? null : Number.isInteger(serverExtension.port) ? (serverExtension.port as number) : null,
      hostname: typeof serverExtension.hostname === "string" && serverExtension.hostname ? serverExtension.hostname : "127.0.0.1",
    },
  };

  validateDispatchConfig(effective);
  return effective;
}

export function validateDispatchConfig(config: ServiceConfig): void {
  if (config.tracker.kind !== "linear") throw new TwinpodError("unsupported_tracker_kind", "Only Linear tracker is supported");
  if (!config.tracker.apiKey) throw new TwinpodError("missing_tracker_api_key", "tracker.api_key or LINEAR_API_KEY is required");
  if (!config.tracker.projectSlug) throw new TwinpodError("missing_tracker_project_slug", "tracker.project_slug is required");
  if (!config.opencode.command.trim()) throw new TwinpodError("missing_opencode_command", "opencode.command is required");
  if (!config.opencode.server) throw new TwinpodError("missing_opencode_server", "opencode.server is required");
  for (const stage of config.opencode.pipeline) {
    if (!config.opencode.permissionProfiles[stage.permissionProfile]) {
      throw new TwinpodError("missing_permission_profile", `Unknown permission profile: ${stage.permissionProfile}`);
    }
  }
}

function parseStateConcurrency(value: unknown): Map<string, number> {
  const map = new Map<string, number>();
  for (const [state, limit] of Object.entries(asRecord(value))) {
    if (Number.isInteger(limit) && (limit as number) > 0) map.set(normalizeState(state), limit as number);
  }
  return map;
}

function parseOpenCodeConfig(opencode: Record<string, unknown>, server: Record<string, unknown>, workflowDir: string, env: NodeJS.ProcessEnv): OpenCodeConfig {
  const plugin = asRecord(opencode.plugin);
  const quality = asRecord(opencode.quality);
  const lsp = asRecord(quality.lsp);
  const hygiene = asRecord(opencode.config_hygiene);

  const permissionProfile = typeof opencode.permission_profile === "string" ? opencode.permission_profile : "restricted";
  const permissionProfiles = {
    ...corePermissionProfiles(),
    ...asRecord(opencode.permission_profiles),
  };

  return {
    command: typeof opencode.command === "string" && opencode.command ? opencode.command : "opencode",
    server: {
      hostname: typeof server.hostname === "string" && server.hostname ? server.hostname : "127.0.0.1",
      port: server.port === null ? null : asInteger(server.port, 4096),
      url: typeof server.url === "string" && server.url ? server.url : null,
      passwordEnv: server.password_env === null ? null : typeof server.password_env === "string" ? server.password_env : "OPENCODE_SERVER_PASSWORD",
      usernameEnv: server.username_env === null ? null : typeof server.username_env === "string" ? server.username_env : "OPENCODE_SERVER_USERNAME",
      reuseExisting: asBoolean(server.reuse_existing, true),
      restartOnExit: asBoolean(server.restart_on_exit, true),
      restartBackoffMs: asPositiveInteger(server.restart_backoff_ms, 5_000),
      startupTimeoutMs: asPositiveInteger(server.startup_timeout_ms, 30_000),
      healthCheckIntervalMs: asPositiveInteger(server.health_check_interval_ms, 5_000),
    },
    configPath: resolvePathValue(opencode.config_path, workflowDir, env),
    configContent: opencode.config_content ?? null,
    configDir: resolvePathValue(opencode.config_dir, workflowDir, env),
    model: typeof opencode.model === "string" && opencode.model ? opencode.model : null,
    pipeline: parsePipeline(opencode.pipeline, permissionProfile),
    maxPipelineCycles: asPositiveInteger(opencode.max_pipeline_cycles, 1),
    permissionProfile,
    permissionProfiles,
    autoApprove: asBoolean(opencode.auto_approve, false),
    plugin: {
      enabled: asBoolean(plugin.enabled, true),
      required: asBoolean(plugin.required, false),
      auditLogPath: resolvePathValue(plugin.audit_log_path, workflowDir, env),
      redactSecrets: asBoolean(plugin.redact_secrets, true),
      protectEnvFiles: asBoolean(plugin.protect_env_files, true),
      emitToolEvents: asBoolean(plugin.emit_tool_events, true),
      emitPermissionEvents: asBoolean(plugin.emit_permission_events, true),
    },
    quality: {
      formatter: quality.formatter === undefined ? true : typeof quality.formatter === "boolean" ? quality.formatter : asRecord(quality.formatter),
      lsp: {
        enabled: asBoolean(lsp.enabled, false),
        required: asBoolean(lsp.required, false),
        permission: typeof lsp.permission === "string" ? lsp.permission : "ask",
      },
    },
    configHygiene: {
      writeGeneratedConfig: asBoolean(hygiene.write_generated_config, true),
      watcherIgnore: asStringArray(hygiene.watcher_ignore, DEFAULT_WATCHER_IGNORE),
      compaction: hygiene.compaction ?? null,
      disabledProviders: asStringArray(hygiene.disabled_providers),
      instructions: asStringArray(hygiene.instructions),
      mcp: asRecord(hygiene.mcp),
      plugins: asStringArray(hygiene.plugins),
      env: resolveEnvMap(asRecord(hygiene.env), env),
    },
    readTimeoutMs: asPositiveInteger(opencode.read_timeout_ms, 5_000),
    turnTimeoutMs: asPositiveInteger(opencode.turn_timeout_ms, 3_600_000),
    stallTimeoutMs: asInteger(opencode.stall_timeout_ms, 300_000),
  };
}

function parsePipeline(value: unknown, fallbackPermissionProfile: string): OpenCodePipelineStage[] {
  const rawStages = Array.isArray(value) && value.length > 0 ? value : [
    { name: "plan", agent: "plan", permission_profile: "review_only", max_turns: 1, required: true },
    { name: "execute", agent: "build", permission_profile: "restricted", max_turns: 10, required: true },
    { name: "review", agent: "plan", permission_profile: "review_only", max_turns: 1, required: true },
  ];

  return rawStages.map((stage, index) => {
    const record = asRecord(stage);
    return {
      name: typeof record.name === "string" && record.name ? record.name : `stage_${index + 1}`,
      agent: typeof record.agent === "string" && record.agent ? record.agent : "build",
      model: typeof record.model === "string" && record.model ? record.model : null,
      permissionProfile: typeof record.permission_profile === "string" && record.permission_profile ? record.permission_profile : fallbackPermissionProfile,
      prompt: typeof record.prompt === "string" ? record.prompt : null,
      maxTurns: asPositiveInteger(record.max_turns, 1),
      required: asBoolean(record.required, true),
      onFailure: typeof record.on_failure === "string" ? record.on_failure : "fail_attempt",
    };
  });
}

function resolveEnvMap(input: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) out[key] = String(resolveEnvReference(value, env));
  return out;
}

export function corePermissionProfiles(): Record<string, unknown> {
  return {
    high_trust: {
      edit: "allow",
      bash: "ask",
      webfetch: "allow",
      deny: [{ match: "rm -rf /" }, { match: ".env" }],
    },
    restricted: {
      edit: "ask",
      bash: "ask",
      webfetch: "allow",
      deny: [{ match: "rm -rf" }, { match: ".env" }],
    },
    review_only: {
      edit: "deny",
      bash: "deny",
      webfetch: "allow",
      deny: [{ match: ".env" }],
    },
  };
}

export function buildOpenCodeEnvironment(config: OpenCodeConfig, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, ...config.configHygiene.env };
  if (config.configPath) result.OPENCODE_CONFIG = config.configPath;
  if (config.configDir) result.OPENCODE_CONFIG_DIR = config.configDir;
  if (config.configContent !== null && config.configContent !== undefined) {
    result.OPENCODE_CONFIG_CONTENT = typeof config.configContent === "string" ? config.configContent : JSON.stringify(config.configContent);
  }
  return result;
}
