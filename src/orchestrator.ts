import { TwinpodError, errorMessage } from "./errors.js";
import { AgentRunner, Issue, Logger, RuntimeEvent, ServiceConfig, TrackerClient } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { monotonicMs, normalizeState, nowIso } from "./util.js";

interface RunningEntry {
  issue: Issue;
  controller: AbortController;
  startedAtMs: number;
  startedAtIso: string;
  retryAttempt: number;
  sessionId: string | null;
  opencodeSessionId: string | null;
  messageId: string | null;
  currentStage: string | null;
  currentAgent: string | null;
  permissionProfile: string | null;
  lastEvent: string | null;
  lastEventAtMs: number | null;
  lastEventAtIso: string | null;
  lastMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
  recentEvents: RuntimeEvent[];
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  issueUrl: string | null;
  attempt: number;
  dueAtMs: number;
  timerHandle: NodeJS.Timeout;
  error: string | null;
}

export class Orchestrator {
  private running = new Map<string, RunningEntry>();
  private claimed = new Set<string>();
  private retryAttempts = new Map<string, RetryEntry>();
  private completed = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private stopped = false;
  private totals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 };
  private rateLimits: unknown = null;
  private knownIssues = new Map<string, Issue>();

  constructor(
    private config: ServiceConfig,
    private tracker: TrackerClient,
    private runner: AgentRunner,
    private workspaceManager: WorkspaceManager,
    private readonly logger: Logger,
  ) {}

  updateDependencies(input: { config: ServiceConfig; tracker: TrackerClient; runner: AgentRunner; workspaceManager: WorkspaceManager }): void {
    this.config = input.config;
    this.tracker = input.tracker;
    this.runner = input.runner;
    this.workspaceManager = input.workspaceManager;
    this.logger.info("workflow config reloaded", { poll_interval_ms: this.config.polling.intervalMs, max_concurrent_agents: this.config.agent.maxConcurrentAgents });
    this.rescheduleNextTick(this.config.polling.intervalMs);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.startupTerminalWorkspaceCleanup();
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const retry of this.retryAttempts.values()) clearTimeout(retry.timerHandle);
    for (const [issueId, entry] of this.running) {
      entry.controller.abort(new TwinpodError("message_cancelled", "Service shutting down"));
      await this.runner.cancel?.(issueId).catch(() => undefined);
    }
  }

  requestRefresh(): { queued: boolean; coalesced: boolean; requested_at: string; operations: string[] } {
    const coalesced = this.tickInFlight;
    this.scheduleTick(0);
    return { queued: true, coalesced, requested_at: nowIso(), operations: ["poll", "reconcile"] };
  }

  async tick(): Promise<void> {
    if (this.tickInFlight || this.stopped) return;
    this.tickInFlight = true;
    try {
      await this.reconcileRunningIssues();
      let issues: Issue[];
      try {
        issues = await this.tracker.fetchCandidateIssues();
      } catch (error) {
        this.logger.warn("candidate fetch failed", { error: errorMessage(error) });
        return;
      }

      for (const issue of sortForDispatch(issues)) {
        this.knownIssues.set(issue.id, issue);
        if (this.availableSlots() <= 0) break;
        if (this.shouldDispatch(issue)) this.dispatchIssue(issue, null);
      }
    } finally {
      this.tickInFlight = false;
      this.scheduleTick(this.config.polling.intervalMs);
    }
  }

  snapshot(): Record<string, unknown> {
    const now = monotonicMs();
    const running = [...this.running.values()].map((entry) => ({
      issue_id: entry.issue.id,
      issue_identifier: entry.issue.identifier,
      issue_url: entry.issue.url,
      state: entry.issue.state,
      session_id: entry.sessionId,
      turn_count: entry.turnCount,
      last_event: entry.lastEvent,
      last_message: entry.lastMessage,
      started_at: entry.startedAtIso,
      last_event_at: entry.lastEventAtIso,
      tokens: { input_tokens: entry.inputTokens, output_tokens: entry.outputTokens, total_tokens: entry.totalTokens },
    }));
    const retrying = [...this.retryAttempts.values()].map((entry) => ({
      issue_id: entry.issueId,
      issue_identifier: entry.identifier,
      issue_url: entry.issueUrl,
      attempt: entry.attempt,
      due_at: new Date(Date.now() + Math.max(entry.dueAtMs - now, 0)).toISOString(),
      error: entry.error,
    }));
    const activeSeconds = [...this.running.values()].reduce((sum, entry) => sum + (now - entry.startedAtMs) / 1000, 0);
    return {
      generated_at: nowIso(),
      counts: { running: running.length, retrying: retrying.length },
      running,
      retrying,
      opencode_totals: { ...this.totals, seconds_running: this.totals.seconds_running + activeSeconds },
      rate_limits: this.rateLimits,
    };
  }

  issueSnapshot(identifier: string): Record<string, unknown> | null {
    const running = [...this.running.values()].find((entry) => entry.issue.identifier === identifier);
    const retry = [...this.retryAttempts.values()].find((entry) => entry.identifier === identifier);
    const issue = running?.issue ?? [...this.knownIssues.values()].find((candidate) => candidate.identifier === identifier) ?? null;
    if (!running && !retry && !issue) return null;
    return {
      issue_identifier: identifier,
      issue_id: issue?.id ?? retry?.issueId ?? null,
      status: running ? "running" : retry ? "retrying" : this.completed.has(issue?.id ?? "") ? "completed" : "known",
      workspace: { path: issue ? `${this.config.workspace.root}/${issue.identifier.replace(/[^A-Za-z0-9._-]/g, "_")}` : null },
      attempts: { current_retry_attempt: retry?.attempt ?? running?.retryAttempt ?? null },
      running: running
        ? {
            session_id: running.sessionId,
            turn_count: running.turnCount,
            state: running.issue.state,
            started_at: running.startedAtIso,
            last_event: running.lastEvent,
            last_message: running.lastMessage,
            last_event_at: running.lastEventAtIso,
            tokens: { input_tokens: running.inputTokens, output_tokens: running.outputTokens, total_tokens: running.totalTokens },
          }
        : null,
      retry: retry ? { attempt: retry.attempt, error: retry.error } : null,
      recent_events: running?.recentEvents.map((event) => ({ at: event.timestamp, event: event.event, message: event.message ?? null })) ?? [],
      last_error: retry?.error ?? null,
      tracked: {},
    };
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.tick(), delayMs);
  }

  private rescheduleNextTick(delayMs: number): void {
    this.scheduleTick(delayMs);
  }

  private shouldDispatch(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    const state = normalizeState(issue.state);
    if (!this.normalizedActiveStates().has(state)) return false;
    if (this.normalizedTerminalStates().has(state)) return false;
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) return false;
    if (this.availableSlots() <= 0) return false;
    if (!this.hasPerStateSlot(state)) return false;
    if (!this.hasRequiredLabels(issue)) return false;
    if (state === "todo" && issue.blocked_by.some((blocker) => !blocker.state || !this.normalizedTerminalStates().has(normalizeState(blocker.state)))) return false;
    return true;
  }

  private dispatchIssue(issue: Issue, attempt: number | null): void {
    const controller = new AbortController();
    const startedAtMs = monotonicMs();
    const retryAttempt = attempt ?? 0;
    const entry: RunningEntry = {
      issue,
      controller,
      startedAtMs,
      startedAtIso: nowIso(),
      retryAttempt,
      sessionId: null,
      opencodeSessionId: null,
      messageId: null,
      currentStage: null,
      currentAgent: null,
      permissionProfile: null,
      lastEvent: null,
      lastEventAtMs: null,
      lastEventAtIso: null,
      lastMessage: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      turnCount: 0,
      recentEvents: [],
    };
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    const retry = this.retryAttempts.get(issue.id);
    if (retry) clearTimeout(retry.timerHandle);
    this.retryAttempts.delete(issue.id);
    this.logger.info("issue dispatched", { issue_id: issue.id, issue_identifier: issue.identifier, attempt: retryAttempt || null });

    this.runner
      .runAttempt(issue, attempt, controller.signal, (event) => this.handleRuntimeEvent(issue.id, event))
      .then(() => this.handleWorkerExit(issue.id, "normal"))
      .catch((error) => this.handleWorkerExit(issue.id, "abnormal", error));
  }

  private handleRuntimeEvent(issueId: string, event: RuntimeEvent): void {
    const entry = this.running.get(issueId);
    if (!entry) return;
    entry.lastEvent = event.event;
    entry.lastEventAtMs = monotonicMs();
    entry.lastEventAtIso = event.timestamp;
    entry.lastMessage = event.message ?? entry.lastMessage;
    entry.currentStage = event.stage ?? entry.currentStage;
    entry.currentAgent = event.agent ?? entry.currentAgent;
    entry.permissionProfile = event.permission_profile ?? entry.permissionProfile;
    entry.opencodeSessionId = event.opencode_session_id ?? entry.opencodeSessionId;
    entry.messageId = event.message_id ?? entry.messageId;
    entry.sessionId = entry.opencodeSessionId && entry.messageId ? `${entry.opencodeSessionId}-${entry.messageId}` : entry.opencodeSessionId ?? entry.sessionId;
    if (event.event === "message_started") entry.turnCount += 1;
    this.applyUsage(entry, event.usage);
    if (event.payload && typeof event.payload === "object" && "rate_limits" in event.payload) this.rateLimits = (event.payload as any).rate_limits;
    entry.recentEvents.push(event);
    entry.recentEvents = entry.recentEvents.slice(-50);
  }

  private applyUsage(entry: RunningEntry, usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    const input = pickNumber(usage, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
    const output = pickNumber(usage, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
    const total = pickNumber(usage, ["total_tokens", "totalTokens"]);
    if (input !== null) {
      this.totals.input_tokens += Math.max(input - entry.lastReportedInputTokens, 0);
      entry.inputTokens = input;
      entry.lastReportedInputTokens = input;
    }
    if (output !== null) {
      this.totals.output_tokens += Math.max(output - entry.lastReportedOutputTokens, 0);
      entry.outputTokens = output;
      entry.lastReportedOutputTokens = output;
    }
    if (total !== null) {
      this.totals.total_tokens += Math.max(total - entry.lastReportedTotalTokens, 0);
      entry.totalTokens = total;
      entry.lastReportedTotalTokens = total;
    } else if (input !== null || output !== null) {
      entry.totalTokens = entry.inputTokens + entry.outputTokens;
      this.totals.total_tokens = this.totals.input_tokens + this.totals.output_tokens;
    }
  }

  private handleWorkerExit(issueId: string, reason: "normal" | "abnormal", error?: unknown): void {
    const entry = this.running.get(issueId);
    if (!entry) return;
    this.running.delete(issueId);
    this.totals.seconds_running += (monotonicMs() - entry.startedAtMs) / 1000;
    if (reason === "normal") {
      this.completed.add(issueId);
      this.scheduleRetry(entry.issue, 1, 1000, null);
      this.logger.info("worker completed; continuation retry scheduled", { issue_id: issueId, issue_identifier: entry.issue.identifier });
    } else {
      const attempt = Math.max(entry.retryAttempt + 1, 1);
      const delay = failureBackoffMs(attempt, this.config.agent.maxRetryBackoffMs);
      this.scheduleRetry(entry.issue, attempt, delay, errorMessage(error));
      this.logger.warn("worker failed; retry scheduled", { issue_id: issueId, issue_identifier: entry.issue.identifier, attempt, error: errorMessage(error) });
    }
  }

  private scheduleRetry(issue: Issue, attempt: number, delayMs: number, error: string | null): void {
    const existing = this.retryAttempts.get(issue.id);
    if (existing) clearTimeout(existing.timerHandle);
    const dueAtMs = monotonicMs() + delayMs;
    const timerHandle = setTimeout(() => void this.handleRetryTimer(issue.id), delayMs);
    this.retryAttempts.set(issue.id, { issueId: issue.id, identifier: issue.identifier, issueUrl: issue.url, attempt, dueAtMs, timerHandle, error });
    this.claimed.add(issue.id);
  }

  private async handleRetryTimer(issueId: string): Promise<void> {
    const retry = this.retryAttempts.get(issueId);
    if (!retry) return;
    this.retryAttempts.delete(issueId);
    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch (error) {
      this.scheduleRetry({ id: issueId, identifier: retry.identifier, title: retry.identifier, description: null, priority: null, state: "", branch_name: null, url: retry.issueUrl, labels: [], blocked_by: [], created_at: null, updated_at: null }, retry.attempt + 1, failureBackoffMs(retry.attempt + 1, this.config.agent.maxRetryBackoffMs), "retry poll failed");
      this.logger.warn("retry poll failed", { issue_id: issueId, issue_identifier: retry.identifier, error: errorMessage(error) });
      return;
    }
    const issue = candidates.find((candidate) => candidate.id === issueId);
    if (!issue || !this.shouldRetryCandidate(issue)) {
      this.claimed.delete(issueId);
      return;
    }
    if (this.availableSlots() <= 0 || !this.hasPerStateSlot(normalizeState(issue.state))) {
      this.scheduleRetry(issue, retry.attempt + 1, failureBackoffMs(retry.attempt + 1, this.config.agent.maxRetryBackoffMs), "no available orchestrator slots");
      return;
    }
    this.claimed.delete(issueId);
    this.dispatchIssue(issue, retry.attempt);
  }

  private shouldRetryCandidate(issue: Issue): boolean {
    const state = normalizeState(issue.state);
    return this.normalizedActiveStates().has(state) && !this.normalizedTerminalStates().has(state) && this.hasRequiredLabels(issue);
  }

  private async reconcileRunningIssues(): Promise<void> {
    this.reconcileStalledRuns();
    const runningIds = [...this.running.keys()];
    if (runningIds.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(runningIds);
    } catch (error) {
      this.logger.warn("running issue refresh failed; workers kept running", { error: errorMessage(error) });
      return;
    }
    for (const issue of refreshed) {
      const state = normalizeState(issue.state);
      if (this.normalizedTerminalStates().has(state)) await this.terminateRunningIssue(issue.id, true);
      else if (this.normalizedActiveStates().has(state) && this.hasRequiredLabels(issue)) {
        const entry = this.running.get(issue.id);
        if (entry) entry.issue = issue;
      } else await this.terminateRunningIssue(issue.id, false);
    }
  }

  private reconcileStalledRuns(): void {
    if (this.config.opencode.stallTimeoutMs <= 0) return;
    const now = monotonicMs();
    for (const [issueId, entry] of this.running) {
      const lastActivity = entry.lastEventAtMs ?? entry.startedAtMs;
      if (now - lastActivity > this.config.opencode.stallTimeoutMs) {
        entry.controller.abort(new TwinpodError("turn_timeout", "OpenCode session stalled"));
        void this.runner.cancel?.(issueId);
      }
    }
  }

  private async terminateRunningIssue(issueId: string, cleanupWorkspace: boolean): Promise<void> {
    const entry = this.running.get(issueId);
    if (!entry) return;
    entry.controller.abort(new TwinpodError("message_cancelled", "Issue state changed"));
    await this.runner.cancel?.(issueId).catch(() => undefined);
    this.running.delete(issueId);
    this.claimed.delete(issueId);
    this.totals.seconds_running += (monotonicMs() - entry.startedAtMs) / 1000;
    if (cleanupWorkspace) await this.workspaceManager.removeForIssue(entry.issue.identifier).catch((error) => this.logger.warn("terminal workspace cleanup failed", { issue_id: issueId, issue_identifier: entry.issue.identifier, error: errorMessage(error) }));
  }

  private async startupTerminalWorkspaceCleanup(): Promise<void> {
    try {
      const terminalIssues = await this.tracker.fetchIssuesByStates(this.config.tracker.terminalStates);
      for (const issue of terminalIssues) await this.workspaceManager.removeForIssue(issue.identifier);
    } catch (error) {
      this.logger.warn("startup terminal workspace cleanup failed", { error: errorMessage(error) });
    }
  }

  private availableSlots(): number {
    return Math.max(this.config.agent.maxConcurrentAgents - this.running.size, 0);
  }

  private hasPerStateSlot(state: string): boolean {
    const limit = this.config.agent.maxConcurrentAgentsByState.get(state) ?? this.config.agent.maxConcurrentAgents;
    const count = [...this.running.values()].filter((entry) => normalizeState(entry.issue.state) === state).length;
    return count < limit;
  }

  private hasRequiredLabels(issue: Issue): boolean {
    const labels = new Set(issue.labels.map((label) => label.trim().toLowerCase()));
    return this.config.tracker.requiredLabels.every((label) => label !== "" && labels.has(label));
  }

  private normalizedActiveStates(): Set<string> {
    return new Set(this.config.tracker.activeStates.map(normalizeState));
  }

  private normalizedTerminalStates(): Set<string> {
    return new Set(this.config.tracker.terminalStates.map(normalizeState));
  }
}

export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
    const priorityB = b.priority ?? Number.POSITIVE_INFINITY;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const createdA = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
    const createdB = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
    if (createdA !== createdB) return createdA - createdB;
    return a.identifier.localeCompare(b.identifier);
  });
}

export function failureBackoffMs(attempt: number, maxRetryBackoffMs: number): number {
  return Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), maxRetryBackoffMs);
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}
