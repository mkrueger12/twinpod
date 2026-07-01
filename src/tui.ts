import { basename } from "node:path";
import { Orchestrator } from "./orchestrator.js";
import type { LinearClient } from "./linear.js";
import type { Logger, OpenCodeRunner, RepoRuntimeConfig, RuntimeEvent, RuntimeIssueStatus, StageLibrary } from "./types.js";

type OpenTuiCore = {
  createCliRenderer(options?: Record<string, unknown>): Promise<unknown>;
  Box(props?: Record<string, unknown>, ...children: unknown[]): unknown;
  Text(props?: Record<string, unknown>): unknown;
};

type TuiRenderable = {
  content?: string;
};

type TuiRenderer = {
  root: { add(node: unknown): void };
  requestLive?: () => void;
  dropLive?: () => void;
  requestRender?: () => void;
  destroy?: () => void | Promise<void>;
};

type TuiRepoInfo = {
  repoRoot: string;
  projects: string[];
  pollInterval: string;
};

type TuiState = {
  startedAt: Date;
  repos: TuiRepoInfo[];
  active: Map<string, RuntimeIssueStatus>;
  logs: string[];
  lastPollAt?: string;
  ticker: number;
};

export async function runTui(options: {
  repos: RepoRuntimeConfig[];
  stageLibrary: StageLibrary;
  linear: LinearClient;
  openCode: OpenCodeRunner;
  once?: boolean;
  signal?: AbortSignal;
  abort?: (reason?: unknown) => void;
}): Promise<void> {
  const core = await loadOpenTui();
  const state: TuiState = {
    startedAt: new Date(),
    repos: options.repos.map((repo) => ({
      repoRoot: repo.repoRoot,
      projects: repo.twinpod.intake.sources.map((source) => source.project_slug ?? source.project ?? "any project"),
      pollInterval: repo.twinpod.intake.poll_interval,
    })),
    active: new Map(),
    logs: [],
    ticker: 0,
  };
  const renderer = (await core.createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    targetFps: 8,
    onDestroy: () => options.abort?.(new Error("TUI closed")),
  })) as TuiRenderer;

  const header = core.Text({ content: "" }) as TuiRenderable;
  const issues = core.Text({ content: "" }) as TuiRenderable;
  const logs = core.Text({ content: "" }) as TuiRenderable;
  const footer = core.Text({ content: "" }) as TuiRenderable;

  renderer.root.add(
    core.Box(
      {
        width: "100%",
        height: "100%",
        flexDirection: "column",
        padding: 1,
        gap: 1,
      },
      core.Box({ borderStyle: "rounded", padding: 1, title: "Twinpod" }, header),
      core.Box({ borderStyle: "rounded", padding: 1, flexGrow: 1, title: "Current Work" }, issues),
      core.Box({ borderStyle: "rounded", padding: 1, height: 10, title: "Live Log" }, logs),
      footer,
    ),
  );

  renderer.requestLive?.();
  const redraw = () => {
    state.ticker += 1;
    header.content = renderHeader(state);
    issues.content = renderIssues(state);
    logs.content = state.logs.slice(-8).join("\n") || "No activity yet.";
    footer.content = "Ctrl+C exits. Twinpod keeps Linear as the source of truth.";
    renderer.requestRender?.();
  };
  const interval = setInterval(redraw, 250);
  redraw();

  const logger = tuiLogger((event) => handleEvent(state, event));
  try {
    await new Orchestrator({
      repos: options.repos,
      stageLibrary: options.stageLibrary,
      linear: options.linear,
      openCode: options.openCode,
      logger,
      once: options.once,
      signal: options.signal,
      onEvent: (event) => handleEvent(state, event),
    }).start();
  } finally {
    clearInterval(interval);
    renderer.dropLive?.();
    await renderer.destroy?.();
  }
}

function tuiLogger(onEvent: (event: RuntimeEvent) => void): Logger {
  return {
    info(message, meta) {
      onEvent({ type: "log", level: "info", message, meta, at: new Date().toISOString() });
    },
    warn(message, meta) {
      onEvent({ type: "log", level: "warn", message, meta, at: new Date().toISOString() });
    },
    error(message, meta) {
      onEvent({ type: "log", level: "error", message, meta, at: new Date().toISOString() });
    },
  };
}

function handleEvent(state: TuiState, event: RuntimeEvent): void {
  if (event.type === "server.started") appendLog(state, "info", `server started for ${event.repos.length} repo(s)`);
  else if (event.type === "poll.started") {
    state.lastPollAt = event.at;
    appendLog(state, "info", `polling ${basename(event.repoRoot)}`);
  } else if (event.type === "issue.updated") {
    state.active.set(event.status.issueId, event.status);
    appendLog(state, "info", `${event.status.identifier}: ${event.status.stage}`);
  } else if (event.type === "issue.completed") {
    state.active.delete(event.issueId);
    appendLog(state, "info", `${event.identifier}: ${event.stage}${event.prUrl ? ` ${event.prUrl}` : ""}`);
  } else appendLog(state, event.level, formatLog(event.message, event.meta));
}

function renderHeader(state: TuiState): string {
  const uptime = Math.max(0, Math.floor((Date.now() - state.startedAt.getTime()) / 1000));
  const repoLines = state.repos.map(
    (repo) => `  ${basename(repo.repoRoot)} — ${repo.projects.join(", ")} (polling every ${repo.pollInterval})`,
  );
  return [
    `repos:`,
    ...repoLines,
    `active issues: ${state.active.size}`,
    `uptime: ${uptime}s`,
    `last poll: ${state.lastPollAt ? relativeTime(state.lastPollAt) : "not yet"}`,
  ].join("\n");
}

function renderIssues(state: TuiState): string {
  if (state.active.size === 0) return `Waiting for qualifying Linear issues ${ticker(state.ticker)}`;
  return [...state.active.values()].map((status) => renderIssue(status, state.ticker)).join("\n\n");
}

function renderIssue(status: RuntimeIssueStatus, tick: number): string {
  const parts = [`${status.identifier}: ${status.title}`, `stage: ${status.stage} ${ticker(tick)}`];
  if (status.phase) parts.push(`phase: ${status.phase}${status.cycle ? ` (${status.cycle}/${status.maxCycles ?? status.cycle})` : ""}`);
  parts.push(`repo: ${basename(status.repoRoot)}`);
  parts.push(`updated: ${relativeTime(status.updatedAt)}`);
  parts.push(`cost: ${typeof status.costUsd === "number" ? `$${status.costUsd.toFixed(4)}` : "pending"}`);
  if (status.url) parts.push(`linear: ${status.url}`);
  return parts.join("\n");
}

function appendLog(state: TuiState, level: string, message: string): void {
  state.logs.push(`${new Date().toLocaleTimeString()} ${level.toUpperCase()} ${message}`);
  if (state.logs.length > 100) state.logs.splice(0, state.logs.length - 100);
}

function formatLog(message: string, meta?: Record<string, unknown>): string {
  return meta && Object.keys(meta).length > 0 ? `${message} ${JSON.stringify(meta)}` : message;
}

function ticker(tick: number): string {
  return ["|", "/", "-", "\\"][tick % 4] ?? "|";
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

async function loadOpenTui(): Promise<OpenTuiCore> {
  try {
    return (await import("@opentui/core")) as unknown as OpenTuiCore;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to start OpenTUI. Install/use Node 26.3+ with experimental FFI support, then rerun twinpod tui. OpenTUI error: ${detail}`);
  }
}
