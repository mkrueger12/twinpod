export interface IssueBlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: IssueBlockerRef[];
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
  path: string;
}

export interface TrackerConfig {
  kind: "linear";
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  requiredLabels: string[];
  activeStates: string[];
  terminalStates: string[];
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Map<string, number>;
}

export interface OpenCodeServerConfig {
  hostname: string;
  port: number | null;
  url: string | null;
  passwordEnv: string | null;
  usernameEnv: string | null;
  reuseExisting: boolean;
  restartOnExit: boolean;
  restartBackoffMs: number;
  startupTimeoutMs: number;
  healthCheckIntervalMs: number;
}

export interface OpenCodePipelineStage {
  name: string;
  agent: string;
  model: string | null;
  permissionProfile: string;
  prompt: string | null;
  maxTurns: number;
  required: boolean;
  onFailure: "fail_attempt" | "continue" | "retry_execute" | "handoff" | string;
}

export interface OpenCodeConfig {
  command: string;
  server: OpenCodeServerConfig;
  configPath: string | null;
  configContent: unknown | null;
  configDir: string | null;
  model: string | null;
  pipeline: OpenCodePipelineStage[];
  maxPipelineCycles: number;
  permissionProfile: string;
  permissionProfiles: Record<string, unknown>;
  autoApprove: boolean;
  plugin: {
    enabled: boolean;
    required: boolean;
    auditLogPath: string | null;
    redactSecrets: boolean;
    protectEnvFiles: boolean;
    emitToolEvents: boolean;
    emitPermissionEvents: boolean;
  };
  quality: {
    formatter: boolean | Record<string, unknown>;
    lsp: { enabled: boolean; required: boolean; permission: string };
  };
  configHygiene: {
    writeGeneratedConfig: boolean;
    watcherIgnore: string[];
    compaction: unknown | null;
    disabledProviders: string[];
    instructions: string[];
    mcp: Record<string, unknown>;
    plugins: string[];
    env: Record<string, string>;
  };
  readTimeoutMs: number;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface ServiceConfig {
  workflowPath: string;
  workflowDir: string;
  tracker: TrackerConfig;
  polling: { intervalMs: number };
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  opencode: OpenCodeConfig;
  httpServer: { port: number | null; hostname: string };
}

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
}

export interface RuntimeEvent {
  event: string;
  timestamp: string;
  opencode_server_pid?: string | null;
  opencode_server_url?: string | null;
  opencode_session_id?: string | null;
  message_id?: string | null;
  stage?: string | null;
  agent?: string | null;
  permission_profile?: string | null;
  usage?: Record<string, unknown>;
  message?: string;
  payload?: unknown;
}

export interface AgentRunner {
  runAttempt(issue: Issue, attempt: number | null, signal: AbortSignal, onEvent: (event: RuntimeEvent) => void): Promise<void>;
  cancel?(issueId: string): Promise<void>;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
}
