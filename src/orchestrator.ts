import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentPrUrl, runCi } from "./ci.js";
import { parseDurationMs, sleep } from "./duration.js";
import { LinearClient } from "./linear.js";
import { issueMarkdown, phaseGuardPrompt, renderPhasePrompt } from "./prompts.js";
import { errorOutput } from "./process.js";
import { ensureIssueWorktree, materializeStageLibrary } from "./worktree.js";
import type { LinearIssue, Logger, OpenCodeRunner, RepoRuntimeConfig, RuntimeEvent, RuntimeIssueStatus, StageLibrary, Workflow, WorkflowPhase } from "./types.js";

export class Orchestrator {
  private readonly activeIssueIds = new Set<string>();

  constructor(
    private readonly options: {
      repos: RepoRuntimeConfig[];
      stageLibrary: StageLibrary;
      linear: LinearClient;
      openCode: OpenCodeRunner;
      logger: Logger;
      once?: boolean;
      concurrency?: number;
      signal?: AbortSignal;
      onEvent?: (event: RuntimeEvent) => void;
    },
  ) {}

  async start(): Promise<void> {
    this.options.logger.info("Twinpod server started", { repos: this.options.repos.map((repo) => repo.repoRoot), once: this.options.once ?? false });
    this.emit({ type: "server.started", repos: this.options.repos.map((repo) => repo.repoRoot), once: this.options.once ?? false, at: new Date().toISOString() });
    do {
      await this.pollAllRepos();
      if (this.options.once) break;
      await sleep(this.pollIntervalMs(), this.options.signal);
    } while (!this.options.signal?.aborted);
  }

  private async pollAllRepos(): Promise<void> {
    for (const repo of this.options.repos) {
      this.emit({ type: "poll.started", repoRoot: repo.repoRoot, at: new Date().toISOString() });
      for (const source of repo.twinpod.intake.sources) {
        const issues = await this.options.linear.qualifyingIssues({
          ...source,
          statuses: unique([...source.statuses, repo.twinpod.intake.claim.in_progress]),
        });
        for (const issue of issues) {
          if (this.activeIssueIds.has(issue.id)) continue;
          this.activeIssueIds.add(issue.id);
          void this.processIssue(repo, issue).finally(() => this.activeIssueIds.delete(issue.id));
        }
      }
    }
    while (this.activeIssueIds.size > 0 && this.options.once) await sleep(250, this.options.signal);
  }

  private async processIssue(repo: RepoRuntimeConfig, issue: LinearIssue): Promise<void> {
    this.options.logger.info("Claiming Linear issue", { issue: issue.identifier, repo: repo.repoRoot });
    this.emitIssue(repo, issue, { stage: "claiming" });
    try {
      if (issue.state.name !== repo.twinpod.intake.claim.in_progress) await this.options.linear.transitionIssue(issue, repo.twinpod.intake.claim.in_progress);
      const worktree = await ensureIssueWorktree(repo.repoRoot, issue);
      await materializeStageLibrary(worktree.path, this.options.stageLibrary);
      await writeFile(path.join(worktree.runDir, "issue.md"), issueMarkdown(issue), "utf8");

      await this.runWorkflow(repo, issue, repo.workflow, worktree.path, worktree.runDir);
    } catch (error) {
      if (this.options.signal?.aborted) {
        this.options.logger.info("Issue run interrupted by shutdown; leaving Linear status untouched so it resumes next run", { issue: issue.identifier });
        this.emitIssue(repo, issue, { stage: "interrupted" });
        return;
      }
      this.emitIssue(repo, issue, { stage: "failed" });
      this.options.logger.error("Issue run failed", { issue: issue.identifier, error: errorOutput(error) });
      await this.fail(repo, issue, `Twinpod stopped on an error:\n\n\`\`\`\n${errorOutput(error).slice(-10_000)}\n\`\`\``).catch((failure) => {
        this.options.logger.error("Failed to update Linear after run error", { issue: issue.identifier, error: errorOutput(failure) });
      });
    }
  }

  private async runWorkflow(repo: RepoRuntimeConfig, issue: LinearIssue, workflow: Workflow, worktreePath: string, runDir: string): Promise<void> {
    for (const phase of workflow.phases) {
      if (this.options.signal?.aborted) throw new Error("Shutdown requested before workflow completed");
      await this.runPhaseWithGate(repo, issue, phase, worktreePath, runDir);
    }
    const prUrl = await currentPrUrl(worktreePath);
    if (!prUrl) {
      await this.fail(repo, issue, "Workflow completed, but no GitHub PR was found for the worktree branch. The ship phase must push/open a PR before Twinpod can move the issue to review.");
      return;
    }
    await this.options.linear.commentIssue(issue.id, `Twinpod opened a green PR: ${prUrl}`);
    await this.options.linear.transitionIssue(issue, repo.twinpod.intake.claim.review);
    this.options.logger.info("Issue moved to review", { issue: issue.identifier, prUrl });
    this.emit({ type: "issue.completed", issueId: issue.id, identifier: issue.identifier, stage: "review", prUrl, at: new Date().toISOString() });
  }

  private async runPhaseWithGate(
    repo: RepoRuntimeConfig,
    issue: LinearIssue,
    phase: WorkflowPhase,
    worktreePath: string,
    runDir: string,
  ): Promise<void> {
    const markerPath = path.join(runDir, `${phase.id}.done.json`);
    if (existsSync(markerPath)) {
      this.options.logger.info("Skipping completed phase", { issue: issue.identifier, phase: phase.id });
      return;
    }
    const promptDef = this.options.stageLibrary.prompts.get(phase.prompt);
    if (!promptDef) throw new Error(`Phase ${phase.id} references prompt ${phase.prompt}, which is not defined in twinpod's prompts/`);
    const maxCycles = phase.loop_until === "ci_green" ? phase.cycles ?? 1 : 1;
    let prompt = renderPhasePrompt({ template: promptDef.template, worktreePath, runDir, issue, phase });
    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      this.options.logger.info("Running phase", { issue: issue.identifier, phase: phase.id, cycle, maxCycles });
      this.emitIssue(repo, issue, { stage: "running phase", phase: phase.id, cycle, maxCycles });
      await assertDeclaredReads(runDir, phase);
      const result = await this.options.openCode.runPhase({ repoRoot: repo.repoRoot, worktreePath, issue, phase, agent: promptDef.agent, prompt });
      this.emitIssue(repo, issue, { stage: "phase response received", phase: phase.id, cycle, maxCycles, costUsd: result.costUsd });
      await writeFile(path.join(runDir, `${phase.id}.response.md`), result.text || "(no text response)\n", "utf8");
      await ensureDeclaredWrites(runDir, phase, result.text);

      if (phase.loop_until === "ci_green" || phase.gate === "ci_green") {
        this.emitIssue(repo, issue, { stage: "running ci", phase: phase.id, cycle, maxCycles, costUsd: result.costUsd });
        const ci = await runCi(worktreePath, repo.twinpod.ci?.command);
        await writeFile(path.join(runDir, `${phase.id}.ci.${cycle}.log`), `Command: ${ci.command ?? "none"}\nOK: ${ci.ok}\n\n${ci.output}`, "utf8");
        if (ci.ok) {
          this.emitIssue(repo, issue, { stage: "ci green", phase: phase.id, cycle, maxCycles, costUsd: result.costUsd });
          await writePhaseMarker(markerPath, phase, cycle);
          return;
        }
        if (cycle === maxCycles || phase.gate === "ci_green") throw new Error(`CI gate failed in phase ${phase.id}: ${ci.output.slice(-4000)}`);
        prompt = phaseGuardPrompt({ phaseId: phase.id, failedCommand: ci.command, output: ci.output });
        continue;
      }
      await writePhaseMarker(markerPath, phase, cycle);
      return;
    }
  }

  private async fail(repo: RepoRuntimeConfig, issue: LinearIssue, body: string): Promise<void> {
    await this.options.linear.commentIssue(issue.id, body);
    await this.options.linear.transitionIssue(issue, repo.twinpod.intake.claim.failed);
    this.emit({ type: "issue.completed", issueId: issue.id, identifier: issue.identifier, stage: "failed", at: new Date().toISOString() });
  }

  private pollIntervalMs(): number {
    return Math.min(...this.options.repos.map((repo) => parseDurationMs(repo.twinpod.intake.poll_interval)));
  }

  private emit(event: RuntimeEvent): void {
    this.options.onEvent?.(event);
  }

  private emitIssue(repo: RepoRuntimeConfig, issue: LinearIssue, status: Partial<Omit<RuntimeIssueStatus, "issueId" | "identifier" | "title" | "url" | "repoRoot" | "updatedAt">> & { stage: string }): void {
    this.emit({
      type: "issue.updated",
      status: {
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        repoRoot: repo.repoRoot,
        updatedAt: new Date().toISOString(),
        ...status,
      },
    });
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

async function writePhaseMarker(markerPath: string, phase: WorkflowPhase, cycle: number): Promise<void> {
  await writeFile(markerPath, `${JSON.stringify({ phase: phase.id, completed_at: new Date().toISOString(), cycle }, null, 2)}\n`, "utf8");
}

async function ensureDeclaredWrites(runDir: string, phase: WorkflowPhase, fallbackText: string): Promise<void> {
  await mkdir(runDir, { recursive: true });
  for (const file of phase.writes ?? []) {
    const filePath = path.join(runDir, file);
    if (existsSync(filePath)) continue;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, fallbackText || `# ${phase.id}\n\nOpenCode did not provide a text response.\n`, "utf8");
  }
  for (const file of phase.reads ?? []) {
    const filePath = path.join(runDir, file);
    if (!existsSync(filePath)) throw new Error(`Phase ${phase.id} declared missing read handoff ${file}`);
    await readFile(filePath, "utf8");
  }
}

async function assertDeclaredReads(runDir: string, phase: WorkflowPhase): Promise<void> {
  for (const file of phase.reads ?? []) {
    const filePath = path.join(runDir, file);
    if (!existsSync(filePath)) throw new Error(`Phase ${phase.id} declared missing read handoff ${file}`);
    await readFile(filePath, "utf8");
  }
}
