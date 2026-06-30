export type IssueClass = "feature" | "bug" | "refactor" | "docs" | "chore" | "unclear" | "risky" | string;

export type RiskLevel = "low" | "medium" | "high" | string;

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

export type Budget = {
  usd?: number;
  cycles?: number;
};

export type WorkflowPhase = {
  id: string;
  agent: string;
  prompt: string;
  reads?: string[];
  writes?: string[];
  gate?: string;
  loop_until?: string;
  budget?: Budget;
};

export type Workflow = {
  filePath: string;
  class: IssueClass;
  phases: WorkflowPhase[];
};

export type RepoRuntimeConfig = {
  repoRoot: string;
  twinpod: TwinpodConfig;
  workflows: Map<string, Workflow>;
  agents: Set<string>;
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

export type Classification = {
  runnable: boolean;
  class: IssueClass;
  risk: RiskLevel;
  model_tier?: string;
  confidence: number;
  reasons: string[];
};

export type PhaseRunInput = {
  repoRoot: string;
  worktreePath: string;
  issue: LinearIssue;
  workflow: Workflow;
  phase: WorkflowPhase;
  prompt: string;
};

export type PhaseRunResult = {
  text: string;
  costUsd?: number;
};

export interface OpenCodeRunner {
  listAgents(repoRoot: string): Promise<Set<string>>;
  classify(input: { issue: LinearIssue; repoRoot: string; worktreePath: string; prompt: string }): Promise<Classification>;
  runPhase(input: PhaseRunInput): Promise<PhaseRunResult>;
  close(): Promise<void>;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
