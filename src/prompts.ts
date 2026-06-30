import path from "node:path";
import type { Classification, LinearIssue, WorkflowPhase } from "./types.js";

export function renderPhasePrompt(input: {
  template: string;
  worktreePath: string;
  runDir: string;
  issue: LinearIssue;
  phase: WorkflowPhase;
}): string {
  const reads = (input.phase.reads ?? []).map((file) => path.join(input.runDir, file)).join(", ");
  const writes = (input.phase.writes ?? []).map((file) => path.join(input.runDir, file)).join(", ");
  return interpolate(input.template, {
    issue_id: input.issue.identifier,
    issue_uuid: input.issue.id,
    issue_title: input.issue.title,
    issue_url: input.issue.url ?? "",
    worktree_path: input.worktreePath,
    run_dir: input.runDir,
    reads,
    writes,
  });
}

export function classificationPrompt(issue: LinearIssue): string {
  return `Classify this Linear issue for Twinpod.

Return JSON with exactly these fields:
- runnable: boolean
- class: one of feature, bug, refactor, docs, chore, unclear, risky
- risk: one of low, medium, high
- model_tier: optional string
- confidence: number from 0 to 1
- reasons: string[]

Mark runnable false for unclear or risky work that should not be attempted autonomously.

Issue ID: ${issue.identifier}
Title: ${issue.title}
URL: ${issue.url ?? ""}
Priority: ${issue.priority ?? ""}
Description:
${issue.description ?? ""}`;
}

export function issueMarkdown(issue: LinearIssue, classification?: Classification): string {
  const labels = issue.labels?.nodes.map((label) => label.name).join(", ") ?? "";
  return `# ${issue.identifier}: ${issue.title}

- Linear ID: ${issue.id}
- URL: ${issue.url ?? ""}
- State: ${issue.state.name}
- Project: ${issue.project?.name ?? ""}
- Team: ${issue.team.key ?? issue.team.name ?? issue.team.id}
- Priority: ${issue.priority ?? ""}
- Labels: ${labels}
${classification ? `- Classification: ${classification.class} / ${classification.risk} / confidence ${classification.confidence}` : ""}

## Description

${issue.description ?? ""}
`;
}

export function phaseGuardPrompt(input: { phaseId: string; failedCommand?: string; output: string }): string {
  return `The phase ${input.phaseId} did not satisfy its CI gate.

Command: ${input.failedCommand ?? "auto-detect failed"}

Output:
\`\`\`
${input.output.slice(-12_000)}
\`\`\`

Fix the issue and leave the worktree ready for the same command to pass.`;
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, key: string) => values[key] ?? match);
}
