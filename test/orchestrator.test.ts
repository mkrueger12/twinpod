import { afterEach, describe, expect, test, vi } from "vitest";
import { Orchestrator, failureBackoffMs, sortForDispatch } from "../src/orchestrator.js";
import { AgentRunner, Issue, TrackerClient } from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";
import { config, issue, silentLogger } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("orchestrator scheduling helpers", () => {
  test("sorts by priority, created_at, then identifier", () => {
    const sorted = sortForDispatch([
      issue({ id: "3", identifier: "TP-3", priority: null, created_at: "2024-01-01T00:00:00.000Z" }),
      issue({ id: "2", identifier: "TP-2", priority: 1, created_at: "2024-01-02T00:00:00.000Z" }),
      issue({ id: "1", identifier: "TP-1", priority: 1, created_at: "2024-01-01T00:00:00.000Z" }),
    ]);
    expect(sorted.map((item) => item.identifier)).toEqual(["TP-1", "TP-2", "TP-3"]);
  });

  test("failure backoff starts at 10s and caps", () => {
    expect(failureBackoffMs(1, 300_000)).toBe(10_000);
    expect(failureBackoffMs(3, 25_000)).toBe(25_000);
  });
});

describe("orchestrator dispatch", () => {
  test("does not dispatch Todo issues with non-terminal blockers", async () => {
    vi.useFakeTimers();
    const runner = fakeRunner();
    const tracker = fakeTracker([issue({ blocked_by: [{ id: "b", identifier: "TP-0", state: "In Progress" }] })]);
    const orchestrator = new Orchestrator(config(), tracker, runner, fakeWorkspaceManager(), silentLogger);
    await orchestrator.tick();
    expect(runner.started).toEqual([]);
    await orchestrator.stop();
  });

  test("dispatches eligible issues and exposes running snapshot", async () => {
    vi.useFakeTimers();
    const runner = fakeRunner({ neverResolve: true });
    const tracker = fakeTracker([issue({ labels: ["ready"] })]);
    const cfg = config();
    cfg.tracker.requiredLabels = ["ready"];
    const orchestrator = new Orchestrator(cfg, tracker, runner, fakeWorkspaceManager(), silentLogger);
    await orchestrator.tick();
    expect(runner.started).toEqual(["TP-1"]);
    expect((orchestrator.snapshot() as any).counts.running).toBe(1);
    await orchestrator.stop();
  });

  test("normal worker exit schedules continuation retry", async () => {
    vi.useFakeTimers();
    const runner = fakeRunner();
    const tracker = fakeTracker([issue()]);
    const orchestrator = new Orchestrator(config(), tracker, runner, fakeWorkspaceManager(), silentLogger);
    await orchestrator.tick();
    await Promise.resolve();
    expect((orchestrator.snapshot() as any).counts.retrying).toBe(1);
    await orchestrator.stop();
  });
});

function fakeTracker(candidates: Issue[]): TrackerClient {
  return {
    fetchCandidateIssues: async () => candidates,
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async (ids) => candidates.filter((item) => ids.includes(item.id)),
  };
}

function fakeRunner(options: { neverResolve?: boolean } = {}): AgentRunner & { started: string[] } {
  const started: string[] = [];
  return {
    started,
    runAttempt: async (item) => {
      started.push(item.identifier);
      if (options.neverResolve) await new Promise(() => undefined);
    },
    cancel: async () => undefined,
  };
}

function fakeWorkspaceManager(): WorkspaceManager {
  return {
    removeForIssue: async () => undefined,
  } as unknown as WorkspaceManager;
}
