import { basename } from "node:path";
import os from "node:os";
import { Orchestrator } from "./orchestrator.js";
import type { LinearClient } from "./linear.js";
import type { Logger, OpenCodeRunner, RepoRuntimeConfig, RuntimeEvent, RuntimeIssueStatus, StageLibrary } from "./types.js";

type OpenTuiCore = {
  createCliRenderer(options?: Record<string, unknown>): Promise<TuiRenderer>;
  BoxRenderable: new (ctx: unknown, props?: Record<string, unknown>) => TuiRenderable;
  TextRenderable: new (ctx: unknown, props?: Record<string, unknown>) => TuiRenderable;
};

type TuiRenderable = {
  content?: string;
  add(node: TuiRenderable): number;
};

type TuiRenderer = {
  root: TuiRenderable;
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
  inProgress: Map<string, RuntimeIssueStatus>;
  queued: Map<string, RuntimeIssueStatus>;
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
  concurrency?: number;
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
    inProgress: new Map(),
    queued: new Map(),
    logs: [],
    ticker: 0,
  };
  const renderer = (await core.createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    targetFps: 8,
    onDestroy: () => options.abort?.(new Error("TUI closed")),
  })) as TuiRenderer;

  // `createCliRenderer` doubles as the render context that Renderable subclasses expect as their
  // first constructor argument (see @opentui/core's `this.root = new RootRenderable(this)`).
  // The Box()/Text() JSX-style factories only build inert VNode descriptors that get discarded
  // once mounted; mutating their `.content` afterward never touches the live tree. Constructing
  // the real Renderable instances directly keeps stable references we can mutate every redraw.
  const header = new core.TextRenderable(renderer, { content: "" });
  const inProgress = new core.TextRenderable(renderer, { content: "" });
  const queued = new core.TextRenderable(renderer, { content: "" });
  const logs = new core.TextRenderable(renderer, { content: "" });
  const footer = new core.TextRenderable(renderer, { content: "" });

  const headerBox = new core.BoxRenderable(renderer, { borderStyle: "rounded", padding: 1, title: "Twinpod" });
  headerBox.add(header);
  const inProgressBox = new core.BoxRenderable(renderer, { borderStyle: "rounded", padding: 1, flexGrow: 1, title: "In Progress" });
  inProgressBox.add(inProgress);
  const queuedBox = new core.BoxRenderable(renderer, { borderStyle: "rounded", padding: 1, height: 8, title: "Queued Work" });
  queuedBox.add(queued);
  const logsBox = new core.BoxRenderable(renderer, { borderStyle: "rounded", padding: 1, height: 10, title: "Live Log" });
  logsBox.add(logs);

  const root = new core.BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    gap: 1,
  });
  root.add(headerBox);
  root.add(inProgressBox);
  root.add(queuedBox);
  root.add(logsBox);
  root.add(footer);
  renderer.root.add(root);

  renderer.requestLive?.();
  const redraw = () => {
    state.ticker += 1;
    header.content = renderHeader(state);
    inProgress.content = renderInProgress(state);
    queued.content = renderQueued(state);
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
      concurrency: options.concurrency,
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
    if (event.status.stage === "queued") {
      state.inProgress.delete(event.status.issueId);
      state.queued.delete(event.status.issueId);
      state.queued.set(event.status.issueId, event.status);
    } else {
      state.queued.delete(event.status.issueId);
      state.inProgress.set(event.status.issueId, event.status);
    }
    appendLog(state, "info", `${event.status.identifier}: ${event.status.stage}`);
  } else if (event.type === "issue.completed") {
    state.inProgress.delete(event.issueId);
    state.queued.delete(event.issueId);
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
    `in progress: ${state.inProgress.size}`,
    `queued: ${state.queued.size}`,
    `system RAM: ${formatBytes(os.totalmem() - os.freemem())} / ${formatBytes(os.totalmem())}`,
    `uptime: ${uptime}s`,
    `last poll: ${state.lastPollAt ? relativeTime(state.lastPollAt) : "not yet"}`,
  ].join("\n");
}

function renderInProgress(state: TuiState): string {
  if (state.inProgress.size === 0) return `No issues running ${ticker(state.ticker)}`;
  return [...state.inProgress.values()].map((status) => `${status.identifier} ${status.stage}${status.phase ? ` (${status.phase})` : ""} ${ticker(state.ticker)}`).join("\n");
}

function renderQueued(state: TuiState): string {
  if (state.queued.size === 0) return "No queued work.";
  return [...state.queued.values()].map((status, index) => `${index + 1}. ${status.identifier} ${status.title}`).join("\n");
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

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 / 1024 / 1024;
  return `${gib.toFixed(1)} GiB`;
}

async function loadOpenTui(): Promise<OpenTuiCore> {
  try {
    return (await import("@opentui/core")) as unknown as OpenTuiCore;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to start OpenTUI. Install/use Node 26.3+ with experimental FFI support, then rerun twinpod tui. OpenTUI error: ${detail}`);
  }
}
