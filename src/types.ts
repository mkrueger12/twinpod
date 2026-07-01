export type IntakeSource = {
  project?: string;
  project_slug?: string;
  statuses: string[];
  team?: string;
  assignee?: string;
  labels?: string[];
  priority_min?: number;
};

export type ClaimConfig = {
  in_progress: string;
  review: string;
  failed: string;
  needs_info?: string;
};

export type TwinpodConfig = {
  repoRoot: string;
  max_parallel_agents?: number;
  intake: {
    poll_interval: string;
    sources: IntakeSource[];
    claim: ClaimConfig;
  };
  linear?: {
    api_key?: string;
    api_key_env?: string;
    endpoint?: string;
    page_size?: number;
  };
  ci?: {
    command?: string;
  };
};

export type WorkflowPhase = {
  id: string;
  prompt: string;
  reads?: string[];
  writes?: string[];
  gate?: string;
  loop_until?: string;
  cycles?: number;
};

export type Workflow = {
  phases: WorkflowPhase[];
};

export type RepoRuntimeConfig = {
  repoRoot: string;
  twinpod: TwinpodConfig;
  workflow: Workflow;
};

export type PromptDefinition = {
  name: string;
  agent: string;
  template: string;
};

export type StageLibrary = {
  root: string;
  prompts: Map<string, PromptDefinition>;
  agents: Set<string>;
  agentFiles: Map<string, string>;
};

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  priority?: number | null;
  branchName?: string | null;
  state: { name: string };
  project?: { name: string } | null;
  team: {
    id: string;
    key?: string | null;
    name?: string | null;
    states?: { nodes: Array<{ id: string; name: string }> };
  };
  labels?: { nodes: Array<{ name: string }> };
};

export type PhaseRunInput = {
  repoRoot: string;
  worktreePath: string;
  issue: LinearIssue;
  phase: WorkflowPhase;
  agent: string;
  prompt: string;
  signal?: AbortSignal;
};

export type PhaseRunResult = {
  text: string;
  costUsd?: number;
};

export type RuntimeIssueStatus = {
  issueId: string;
  identifier: string;
  title: string;
  url?: string | null;
  repoRoot: string;
  stage: string;
  phase?: string;
  cycle?: number;
  maxCycles?: number;
  costUsd?: number;
  updatedAt: string;
};

export type RuntimeEvent =
  | { type: "server.started"; repos: string[]; once: boolean; at: string }
  | { type: "poll.started"; repoRoot: string; at: string }
  | { type: "issue.updated"; status: RuntimeIssueStatus }
  | { type: "issue.completed"; issueId: string; identifier: string; stage: string; prUrl?: string; at: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; meta?: Record<string, unknown>; at: string };

export interface OpenCodeRunner {
  runPhase(input: PhaseRunInput): Promise<PhaseRunResult>;
  close(): Promise<void>;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
