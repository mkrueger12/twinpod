import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentPrUrl, runCi } from "./ci.js";
import { parseDurationMs, sleep } from "./duration.js";
import { LinearClient } from "./linear.js";
import { issueMarkdown, phaseGuardPrompt, renderPhasePrompt } from "./prompts.js";
import { errorOutput } from "./process.js";
import { ensureIssueWorktree, materializeStageLibrary } from "./worktree.js";
import type { LinearIssue, Logger, OpenCodeRunner, RepoRuntimeConfig, RuntimeEvent, RuntimeIssueStatus, StageLibrary, Workflow, WorkflowPhase } from "./types.js";

type ActiveIssue = { identifier: string; controller: AbortController };
type QueuedIssue = { repo: RepoRuntimeConfig; issue: LinearIssue; queuedAt: number };
type PolledIssue = QueuedIssue & { order: number };

const DEFAULT_MAX_PARALLEL_AGENTS = 1;
const DEFAULT_MIN_FREE_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

export class Orchestrator {
  private readonly activeIssues = new Map<string, ActiveIssue>();
  private readonly queuedIssues = new Map<string, QueuedIssue>();
  private readonly announcedQueuedIssueIds = new Set<string>();
  private lastQueuedOrderKey = "";
  private queueSequence = 0;
  private memoryBackpressureActive = false;

  constructor(
    private readonly options: {
      repos: RepoRuntimeConfig[];
      stageLibrary: StageLibrary;
      linear: LinearClient;
      openCode: OpenCodeRunner;
      logger: Logger;
      once?: boolean;
      concurrency?: number;
      minFreeMemoryBytes?: number;
      memorySnapshot?: () => { free: number; total: number };
      currentPrUrl?: (worktreePath: string) => Promise<string | undefined>;
      signal?: AbortSignal;
      onEvent?: (event: RuntimeEvent) => void;
    },
  ) {}

  async start(): Promise<void> {
    this.options.logger.info("Twinpod server started", { repos: this.options.repos.map((repo) => repo.repoRoot), once: this.options.once ?? false });
    this.emit({ type: "server.started", repos: this.options.repos.map((repo) => repo.repoRoot), once: this.options.once ?? false, at: new Date().toISOString() });
    do {
      await this.pollAllRepos();
      if (this.options.once || this.options.signal?.aborted) break;
      try {
        await sleep(this.pollIntervalMs(), this.options.signal);
      } catch (error) {
        if (this.options.signal?.aborted) break;
        throw error;
      }
    } while (!this.options.signal?.aborted);
  }

  private async pollAllRepos(): Promise<void> {
    const polledIssues = new Map<string, PolledIssue>();
    let order = 0;
    for (const repo of this.options.repos) {
      this.emit({ type: "poll.started", repoRoot: repo.repoRoot, at: new Date().toISOString() });
      for (const source of repo.twinpod.intake.sources) {
        let issues: LinearIssue[];
        try {
          issues = await this.options.linear.qualifyingIssues({
            ...source,
            statuses: unique([...source.statuses, repo.twinpod.intake.claim.in_progress]),
          });
        } catch (error) {
          if (this.options.once) throw error;
          this.options.logger.warn("Linear poll failed; will retry on the next interval", { repo: repo.repoRoot, error: errorOutput(error) });
          continue;
        }
        for (const issue of issues) {
          if (this.activeIssues.has(issue.id) || this.queuedIssues.has(issue.id) || polledIssues.has(issue.id)) continue;
          polledIssues.set(issue.id, { repo, issue, queuedAt: order, order: order++ });
        }
      }
    }
    for (const { repo, issue } of [...polledIssues.values()].sort(compareIssuePriority)) this.enqueueIssue(repo, issue);
    this.reorderIssueQueue();
    this.drainIssueQueue();
    this.emitQueuedIssues();
    await this.stopIssuesThatNoLongerQualify();
    while ((this.activeIssues.size > 0 || this.queuedIssues.size > 0) && this.options.once && !this.options.signal?.aborted) {
      try {
        await sleep(250, this.options.signal);
      } catch (error) {
        if (this.options.signal?.aborted) break;
        throw error;
      }
      await this.stopIssuesThatNoLongerQualify();
      this.drainIssueQueue();
      this.emitQueuedIssues();
    }
  }

  private enqueueIssue(repo: RepoRuntimeConfig, issue: LinearIssue): void {
    this.queuedIssues.set(issue.id, { repo, issue, queuedAt: this.queueSequence++ });
  }

  private reorderIssueQueue(): void {
    const queued = [...this.queuedIssues.entries()].sort(([, left], [, right]) => compareQueuedIssuePriority(left, right));
    this.queuedIssues.clear();
    for (const [issueId, issue] of queued) this.queuedIssues.set(issueId, issue);
  }

  private drainIssueQueue(): void {
    while (!this.options.signal?.aborted && this.activeIssues.size < this.maxParallelAgents() && this.queuedIssues.size > 0) {
      if (!this.hasCapacityForAnotherAgent()) return;
      const next = this.queuedIssues.entries().next().value;
      if (!next) return;
      const [issueId, queued] = next;
      this.queuedIssues.delete(issueId);
      this.announcedQueuedIssueIds.delete(issueId);
      this.startIssue(queued.repo, queued.issue);
    }
  }

  private emitQueuedIssues(): void {
    const queuedOrderKey = [...this.queuedIssues.keys()].join("\0");
    if (queuedOrderKey === this.lastQueuedOrderKey) return;
    this.lastQueuedOrderKey = queuedOrderKey;
    for (const [issueId, queued] of this.queuedIssues) {
      if (!this.announcedQueuedIssueIds.has(issueId)) {
        this.announcedQueuedIssueIds.add(issueId);
        this.options.logger.info("Queueing Linear issue until an agent slot is available", { issue: queued.issue.identifier, repo: queued.repo.repoRoot, active: this.activeIssues.size, max: this.maxParallelAgents() });
      }
      this.emitIssue(queued.repo, queued.issue, { stage: "queued" });
    }
  }

  private startIssue(repo: RepoRuntimeConfig, issue: LinearIssue): void {
    const controller = new AbortController();
    this.options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    this.activeIssues.set(issue.id, { identifier: issue.identifier, controller });
    void this.processIssue(repo, issue, controller.signal).finally(() => {
      this.activeIssues.delete(issue.id);
      this.drainIssueQueue();
    });
  }

  private async stopIssuesThatNoLongerQualify(): Promise<void> {
    for (const [issueId, active] of this.activeIssues) {
      if (active.controller.signal.aborted) continue;
      const status = await this.options.linear.getIssueStatus(issueId).catch(() => null);
      if (!status) continue;
      if (!status.assigneeId || status.stateType === "backlog") {
        this.options.logger.info("Issue no longer assigned or moved to backlog; stopping work", {
          issue: active.identifier,
          assigned: Boolean(status.assigneeId),
          state: status.stateName,
        });
        active.controller.abort();
      }
    }
  }

  private async processIssue(repo: RepoRuntimeConfig, issue: LinearIssue, signal: AbortSignal): Promise<void> {
    this.options.logger.info("Claiming Linear issue", { issue: issue.identifier, repo: repo.repoRoot });
    this.emitIssue(repo, issue, { stage: "claiming" });
    try {
      if (issue.state.name !== repo.twinpod.intake.claim.in_progress) await this.options.linear.transitionIssue(issue, repo.twinpod.intake.claim.in_progress);
      const worktree = await ensureIssueWorktree(repo.repoRoot, issue);
      await materializeStageLibrary(worktree.path, this.options.stageLibrary);
      await writeFile(path.join(worktree.runDir, "issue.md"), issueMarkdown(issue), "utf8");

      await this.runWorkflow(repo, issue, repo.workflow, worktree.path, worktree.runDir, signal);
    } catch (error) {
      if (signal.aborted) {
        this.options.logger.info("Issue run stopped (shutdown, unassigned, or moved to backlog); leaving Linear status untouched so it resumes if still eligible next run", { issue: issue.identifier });
        this.emit({ type: "issue.completed", issueId: issue.id, identifier: issue.identifier, stage: "interrupted", at: new Date().toISOString() });
        return;
      }
      this.emitIssue(repo, issue, { stage: "failed" });
      this.options.logger.error("Issue run failed", { issue: issue.identifier, error: errorOutput(error) });
      await this.fail(repo, issue, `Twinpod stopped on an error:\n\n\`\`\`\n${errorOutput(error).slice(-10_000)}\n\`\`\``).catch((failure) => {
        this.options.logger.error("Failed to update Linear after run error", { issue: issue.identifier, error: errorOutput(failure) });
      });
    }
  }

  private async runWorkflow(repo: RepoRuntimeConfig, issue: LinearIssue, workflow: Workflow, worktreePath: string, runDir: string, signal: AbortSignal): Promise<void> {
    for (const phase of workflow.phases) {
      if (signal.aborted) throw new Error("Stopped before workflow completed");
      await this.runPhaseWithGate(repo, issue, phase, worktreePath, runDir, signal);
    }
    const prUrl = await (this.options.currentPrUrl ?? currentPrUrl)(worktreePath);
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
    signal: AbortSignal,
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
      if (signal.aborted) throw new Error(`Stopped mid-phase ${phase.id}`);
      this.options.logger.info("Running phase", { issue: issue.identifier, phase: phase.id, cycle, maxCycles });
      this.emitIssue(repo, issue, { stage: "running phase", phase: phase.id, cycle, maxCycles });
      await assertDeclaredReads(runDir, phase);
      const result = await this.options.openCode.runPhase({ repoRoot: repo.repoRoot, worktreePath, issue, phase, agent: promptDef.agent, prompt, signal });
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

  private maxParallelAgents(): number {
    return Math.max(1, Math.floor(this.options.concurrency ?? DEFAULT_MAX_PARALLEL_AGENTS));
  }

  private hasCapacityForAnotherAgent(): boolean {
    if (this.activeIssues.size === 0 || this.maxParallelAgents() <= 1) return true;
    const minFree = this.options.minFreeMemoryBytes ?? DEFAULT_MIN_FREE_MEMORY_BYTES;
    if (minFree <= 0) return true;
    const memory = this.options.memorySnapshot?.() ?? { free: os.freemem(), total: os.totalmem() };
    if (memory.free >= minFree) {
      this.memoryBackpressureActive = false;
      return true;
    }
    if (!this.memoryBackpressureActive) {
      this.memoryBackpressureActive = true;
      this.options.logger.warn("Pausing queued issue starts until more RAM is available", {
        active: this.activeIssues.size,
        max: this.maxParallelAgents(),
        freeGiB: (memory.free / 1024 / 1024 / 1024).toFixed(1),
        requiredFreeGiB: (minFree / 1024 / 1024 / 1024).toFixed(1),
      });
    }
    return false;
  }

  private emit(event: RuntimeEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch (error) {
      try {
        this.options.logger.warn("Runtime event handler failed; continuing", { event: event.type, error: errorOutput(error) });
      } catch {
        // Event handlers are observational; a broken dashboard must not stop the worker loop.
      }
    }
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

function compareIssuePriority(left: PolledIssue, right: PolledIssue): number {
  const leftInProgress = isInProgress(left);
  const rightInProgress = isInProgress(right);
  if (leftInProgress !== rightInProgress) return leftInProgress ? -1 : 1;
  return left.order - right.order;
}

function isInProgress(polled: QueuedIssue): boolean {
  return polled.issue.state.name === polled.repo.twinpod.intake.claim.in_progress;
}

function compareQueuedIssuePriority(left: QueuedIssue, right: QueuedIssue): number {
  const leftInProgress = isInProgress(left);
  const rightInProgress = isInProgress(right);
  if (leftInProgress !== rightInProgress) return leftInProgress ? -1 : 1;
  return left.queuedAt - right.queuedAt;
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
