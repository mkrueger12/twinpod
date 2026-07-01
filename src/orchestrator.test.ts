import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { runFile } from "./process.js";
import type { LinearClient } from "./linear.js";
import type { LinearIssue, OpenCodeRunner, RepoRuntimeConfig, StageLibrary } from "./types.js";

describe("Orchestrator", () => {
  it("keeps polling in live mode after a transient Linear intake failure", async () => {
    const repoRoot = await initGitRepo();
    const controller = new AbortController();
    let calls = 0;
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const linear = {
      qualifyingIssues: async () => {
        calls += 1;
        if (calls === 1) throw new Error("Linear GraphQL HTTP 503: upstream connect error");
        controller.abort();
        return [];
      },
      getIssueStatus: async () => ({ assigneeId: "user-1", stateName: "Agent: In Progress", stateType: "started" }),
      transitionIssue: async () => {},
      commentIssue: async () => {},
    } as unknown as LinearClient;

    await new Orchestrator({
      repos: [repoConfig(repoRoot)],
      stageLibrary: stageLibrary(repoRoot),
      linear,
      openCode: { runPhase: async () => ({ text: "done" }), close: async () => {} },
      logger: { info() {}, warn(message, meta) { warnings.push({ message, meta }); }, error() {} },
      signal: controller.signal,
    }).start();

    expect(calls).toBe(2);
    expect(warnings).toEqual([
      expect.objectContaining({
        message: "Linear poll failed; will retry on the next interval",
        meta: expect.objectContaining({ error: expect.stringContaining("Linear GraphQL HTTP 503") }),
      }),
    ]);
  });

  it("stops cleanly when shutdown happens between live polls", async () => {
    const repoRoot = await initGitRepo();
    const controller = new AbortController();
    const linear = {
      qualifyingIssues: async () => [],
      getIssueStatus: async () => ({ assigneeId: "user-1", stateName: "Agent: In Progress", stateType: "started" }),
      transitionIssue: async () => {},
      commentIssue: async () => {},
    } as unknown as LinearClient;

    const run = new Orchestrator({
      repos: [repoConfig(repoRoot)],
      stageLibrary: stageLibrary(repoRoot),
      linear,
      openCode: { runPhase: async () => ({ text: "done" }), close: async () => {} },
      logger: { info() {}, warn() {}, error() {} },
      signal: controller.signal,
    }).start();

    await waitFor(() => !controller.signal.aborted);
    controller.abort(new Error("shutdown"));

    await expect(run).resolves.toBeUndefined();
  });

  it("continues when a runtime event handler throws", async () => {
    const repoRoot = await initGitRepo();
    const controller = new AbortController();
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const linear = {
      qualifyingIssues: async () => {
        controller.abort();
        return [];
      },
      getIssueStatus: async () => ({ assigneeId: "user-1", stateName: "Agent: In Progress", stateType: "started" }),
      transitionIssue: async () => {},
      commentIssue: async () => {},
    } as unknown as LinearClient;

    await new Orchestrator({
      repos: [repoConfig(repoRoot)],
      stageLibrary: stageLibrary(repoRoot),
      linear,
      openCode: { runPhase: async () => ({ text: "done" }), close: async () => {} },
      logger: { info() {}, warn(message, meta) { warnings.push({ message, meta }); }, error() {} },
      signal: controller.signal,
      onEvent: () => {
        throw new Error("renderer failed");
      },
    }).start();

    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: "Runtime event handler failed; continuing",
        meta: expect.objectContaining({ event: "server.started", error: expect.stringContaining("renderer failed") }),
      }),
    );
  });

  it("continues when the runtime event failure logger also throws", async () => {
    const repoRoot = await initGitRepo();
    const controller = new AbortController();
    const linear = {
      qualifyingIssues: async () => {
        controller.abort();
        return [];
      },
      getIssueStatus: async () => ({ assigneeId: "user-1", stateName: "Agent: In Progress", stateType: "started" }),
      transitionIssue: async () => {},
      commentIssue: async () => {},
    } as unknown as LinearClient;

    await expect(
      new Orchestrator({
        repos: [repoConfig(repoRoot)],
        stageLibrary: stageLibrary(repoRoot),
        linear,
        openCode: { runPhase: async () => ({ text: "done" }), close: async () => {} },
        logger: { info() {}, warn() { throw new Error("logger failed"); }, error() {} },
        signal: controller.signal,
        onEvent: () => {
          throw new Error("renderer failed");
        },
      }).start(),
    ).resolves.toBeUndefined();
  });

  it("prioritizes in-progress issues before todo work", async () => {
    const repoRoot = await initGitRepo();
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3, "Agent: In Progress")];
    const linear = {
      qualifyingIssues: async () => issues,
      getIssueStatus: async () => ({ assigneeId: "user-1", stateName: "Agent: In Progress", stateType: "started" }),
      transitionIssue: async () => {},
      commentIssue: async () => {},
    } as unknown as LinearClient;

    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const openCode: OpenCodeRunner = {
      runPhase: async (input) => {
        started.push(input.issue.identifier);
        return new Promise((resolve) => {
          resolvers.push(() => resolve({ text: "done" }));
        });
      },
      close: async () => {},
    };

    const orchestrator = new Orchestrator({
      repos: [repoConfig(repoRoot)],
      stageLibrary: stageLibrary(repoRoot),
      linear,
      openCode,
      logger: { info() {}, warn() {}, error() {} },
      once: true,
      concurrency: 1,
    });

    const run = orchestrator.start();
    await waitFor(() => started.length === 1);
    expect(started[0]).toBe("DEV-3");

    while (started.length < issues.length) {
      const expectedStarted = started.length + 1;
      resolvers.shift()?.();
      await waitFor(() => started.length === expectedStarted);
    }
    for (const resolve of resolvers.splice(0)) resolve();
    await run;
  }, 10_000);

  it("defaults to one parallel issue run and starts queued issues as slots free", async () => {
    const repoRoot = await initGitRepo();
    const issues = Array.from({ length: 5 }, (_, index) => makeIssue(index + 1));
    const transitions: string[] = [];
    const linear = {
      qualifyingIssues: async () => issues,
      getIssueStatus: async () => ({ assigneeId: "user-1", stateName: "Agent: In Progress", stateType: "started" }),
      transitionIssue: async (issue: LinearIssue, statusName: string) => {
        transitions.push(`${issue.identifier}:${statusName}`);
      },
      commentIssue: async () => {},
    } as unknown as LinearClient;

    let activeRuns = 0;
    let peakActiveRuns = 0;
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const openCode: OpenCodeRunner = {
      runPhase: async (input) => {
        activeRuns += 1;
        peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
        started.push(input.issue.identifier);
        return new Promise((resolve) => {
          resolvers.push(() => {
            activeRuns -= 1;
            resolve({ text: "done" });
          });
        });
      },
      close: async () => {},
    };

    const events: Array<{ type: string; status?: { stage: string; issueId: string } }> = [];
    const orchestrator = new Orchestrator({
      repos: [repoConfig(repoRoot)],
      stageLibrary: stageLibrary(repoRoot),
      linear,
      openCode,
      logger: { info() {}, warn() {}, error() {} },
      once: true,
      onEvent: (event) => events.push(event),
    });

    const run = orchestrator.start();
    await waitFor(() => started.length === 1);

    expect(started).toEqual(["DEV-1"]);
    expect(events.filter((event) => event.type === "issue.updated" && event.status?.stage === "queued").map((event) => event.status?.issueId)).toEqual(["issue-2", "issue-3", "issue-4", "issue-5"]);

    while (started.length < issues.length) {
      const expectedStarted = started.length + 1;
      resolvers.shift()?.();
      await waitFor(() => started.length === expectedStarted);
    }
    for (const resolve of resolvers.splice(0)) resolve();
    await run;

    expect(started).toHaveLength(5);
    expect(started).toEqual(expect.arrayContaining(["DEV-1", "DEV-2", "DEV-3", "DEV-4", "DEV-5"]));
    expect(peakActiveRuns).toBe(1);
    expect(transitions.filter((transition) => transition.endsWith(":Agent: In Progress"))).toHaveLength(5);
  }, 10_000);

  it("honors an explicit parallel issue cap above the safe default", async () => {
    const repoRoot = await initGitRepo();
    const issues = Array.from({ length: 3 }, (_, index) => makeIssue(index + 1));
    const linear = {
      qualifyingIssues: async () => issues,
      getIssueStatus: async () => ({ assigneeId: "user-1", stateName: "Agent: In Progress", stateType: "started" }),
      transitionIssue: async () => {},
      commentIssue: async () => {},
    } as unknown as LinearClient;

    let activeRuns = 0;
    let peakActiveRuns = 0;
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const openCode: OpenCodeRunner = {
      runPhase: async (input) => {
        activeRuns += 1;
        peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
        started.push(input.issue.identifier);
        return new Promise((resolve) => {
          resolvers.push(() => {
            activeRuns -= 1;
            resolve({ text: "done" });
          });
        });
      },
      close: async () => {},
    };

    const events: Array<{ type: string; status?: { stage: string; issueId: string } }> = [];
    const orchestrator = new Orchestrator({
      repos: [repoConfig(repoRoot)],
      stageLibrary: stageLibrary(repoRoot),
      linear,
      openCode,
      logger: { info() {}, warn() {}, error() {} },
      once: true,
      concurrency: 2,
      onEvent: (event) => events.push(event),
    });

    const run = orchestrator.start();
    await waitFor(() => started.length === 2);

    expect(started).toEqual(expect.arrayContaining(["DEV-1", "DEV-2"]));
    expect(events.filter((event) => event.type === "issue.updated" && event.status?.stage === "queued").map((event) => event.status?.issueId)).toEqual(["issue-3"]);

    resolvers.shift()?.();
    await waitFor(() => started.length === 3);
    for (const resolve of resolvers.splice(0)) resolve();
    await run;

    expect(peakActiveRuns).toBe(2);
  }, 10_000);

  it("pauses additional parallel issue starts when free RAM is below the reserve", async () => {
    const repoRoot = await initGitRepo();
    const issues = Array.from({ length: 2 }, (_, index) => makeIssue(index + 1));
    const linear = {
      qualifyingIssues: async () => issues,
      getIssueStatus: async () => ({ assigneeId: "user-1", stateName: "Agent: In Progress", stateType: "started" }),
      transitionIssue: async () => {},
      commentIssue: async () => {},
    } as unknown as LinearClient;

    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    let freeMemory = 1 * 1024 * 1024 * 1024;
    const openCode: OpenCodeRunner = {
      runPhase: async (input) => {
        started.push(input.issue.identifier);
        return new Promise((resolve) => {
          resolvers.push(() => resolve({ text: "done" }));
        });
      },
      close: async () => {},
    };

    const run = new Orchestrator({
      repos: [repoConfig(repoRoot)],
      stageLibrary: stageLibrary(repoRoot),
      linear,
      openCode,
      logger: { info() {}, warn(message, meta) { warnings.push({ message, meta }); }, error() {} },
      once: true,
      concurrency: 2,
      minFreeMemoryBytes: 2 * 1024 * 1024 * 1024,
      memorySnapshot: () => ({ free: freeMemory, total: 8 * 1024 * 1024 * 1024 }),
    }).start();

    await waitFor(() => started.length === 1 && warnings.some((warning) => warning.message === "Pausing queued issue starts until more RAM is available"));
    expect(started).toEqual(["DEV-1"]);

    freeMemory = 3 * 1024 * 1024 * 1024;
    await waitFor(() => started.length === 2);
    for (const resolve of resolvers.splice(0)) resolve();
    await run;
  }, 10_000);

  it("runs two issue agents end to end in parallel when resources allow it", async () => {
    const repoRoot = await initGitRepo();
    const issues = Array.from({ length: 2 }, (_, index) => makeIssue(index + 1));
    const transitions: string[] = [];
    const comments: string[] = [];
    const linear = {
      qualifyingIssues: async () => issues,
      getIssueStatus: async () => ({ assigneeId: "user-1", stateName: "Agent: In Progress", stateType: "started" }),
      transitionIssue: async (issue: LinearIssue, statusName: string) => {
        transitions.push(`${issue.identifier}:${statusName}`);
      },
      commentIssue: async (issueId: string, body: string) => {
        comments.push(`${issueId}:${body}`);
      },
    } as unknown as LinearClient;

    let activeRuns = 0;
    let peakActiveRuns = 0;
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const openCode: OpenCodeRunner = {
      runPhase: async (input) => {
        activeRuns += 1;
        peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
        started.push(`${input.issue.identifier}:${input.phase.id}`);
        return new Promise((resolve) => {
          resolvers.push(() => {
            activeRuns -= 1;
            resolve({ text: `completed ${input.issue.identifier}` });
          });
        });
      },
      close: async () => {},
    };

    const completed: string[] = [];
    const run = new Orchestrator({
      repos: [repoConfig(repoRoot)],
      stageLibrary: stageLibrary(repoRoot),
      linear,
      openCode,
      logger: { info() {}, warn() {}, error() {} },
      once: true,
      concurrency: 2,
      minFreeMemoryBytes: 0,
      currentPrUrl: async (worktreePath) => `https://github.com/acme/repo/pull/${path.basename(worktreePath)}`,
      onEvent: (event) => {
        if (event.type === "issue.completed") completed.push(`${event.identifier}:${event.stage}`);
      },
    }).start();

    await waitFor(() => started.length === 2);
    expect(started).toEqual(expect.arrayContaining(["DEV-1:implement", "DEV-2:implement"]));
    expect(peakActiveRuns).toBe(2);

    for (const resolve of resolvers.splice(0)) resolve();
    await run;

    expect(transitions).toEqual(expect.arrayContaining(["DEV-1:Agent: In Progress", "DEV-2:Agent: In Progress", "DEV-1:Agent: In Review", "DEV-2:Agent: In Review"]));
    expect(comments).toEqual(expect.arrayContaining([expect.stringContaining("issue-1:Twinpod opened a green PR:"), expect.stringContaining("issue-2:Twinpod opened a green PR:")]));
    expect(completed).toEqual(expect.arrayContaining(["DEV-1:review", "DEV-2:review"]));
  }, 10_000);

  it("stops an in-flight issue once it's unassigned or moved to backlog, without touching Linear again", async () => {
    const repoRoot = await initGitRepo();
    const issue: LinearIssue = {
      id: "issue-1",
      identifier: "DEV-844",
      title: "Do the thing",
      state: { name: "Ready for Agent" },
      team: { id: "team-1", states: { nodes: [{ id: "state-in-progress", name: "Agent: In Progress" }] } },
    };

    const transitions: string[] = [];
    const comments: string[] = [];
    let statusCalls = 0;
    const linear = {
      qualifyingIssues: async () => (statusCalls === 0 ? [issue] : []),
      getIssueStatus: async () => {
        statusCalls += 1;
        if (statusCalls === 1) return { assigneeId: "user-1", stateName: "Agent: In Progress", stateType: "started" };
        return { assigneeId: null, stateName: "Backlog", stateType: "backlog" };
      },
      transitionIssue: async (_issue: LinearIssue, statusName: string) => {
        transitions.push(statusName);
      },
      commentIssue: async (_id: string, body: string) => {
        comments.push(body);
      },
    } as unknown as LinearClient;

    let runPhaseCalls = 0;
    const openCode: OpenCodeRunner = {
      runPhase: async (input) =>
        new Promise((_resolve, reject) => {
          runPhaseCalls += 1;
          input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      close: async () => {},
    };

    const stageLibrary: StageLibrary = {
      root: repoRoot,
      prompts: new Map([["implement", { name: "implement", agent: "impl-agent", template: "Implement {{issue_id}}." }]]),
      agents: new Set(["impl-agent"]),
      agentFiles: new Map(),
    };

    const repo: RepoRuntimeConfig = {
      repoRoot,
      twinpod: {
        repoRoot,
        intake: {
          poll_interval: "50ms",
          sources: [{ statuses: ["Ready for Agent"] }],
          claim: { in_progress: "Agent: In Progress", review: "Agent: In Review", failed: "Agent: Needs Attention" },
        },
      },
      workflow: { phases: [{ id: "implement", prompt: "implement" }] },
    };

    const events: Array<{ type: string }> = [];
    const orchestrator = new Orchestrator({
      repos: [repo],
      stageLibrary,
      linear,
      openCode,
      logger: { info() {}, warn() {}, error() {} },
      once: true,
      onEvent: (event) => events.push(event),
    });

    await orchestrator.start();

    expect(runPhaseCalls).toBe(1);
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    // Only the initial claim transition happened; no review/failed transition or failure comment was issued
    // once the issue was found unassigned/backlog, and no error was surfaced as a run failure.
    expect(transitions).toEqual(["Agent: In Progress"]);
    expect(comments).toEqual([]);
    // The TUI's "Current Work" panel only drops an issue on `issue.completed` — the stopped
    // run must emit one (not just an `issue.updated`) or it stays listed as active forever.
    expect(events).toContainEqual(expect.objectContaining({ type: "issue.completed", issueId: "issue-1", stage: "interrupted" }));
  }, 10_000);
});

function makeIssue(index: number, stateName = "Ready for Agent"): LinearIssue {
  return {
    id: `issue-${index}`,
    identifier: `DEV-${index}`,
    title: `Do the thing ${index}`,
    state: { name: stateName },
    team: { id: "team-1", states: { nodes: [{ id: "state-in-progress", name: "Agent: In Progress" }, { id: "state-failed", name: "Agent: Needs Attention" }] } },
  };
}

function repoConfig(repoRoot: string): RepoRuntimeConfig {
  return {
    repoRoot,
    twinpod: {
      repoRoot,
      intake: {
        poll_interval: "50ms",
        sources: [{ statuses: ["Ready for Agent"] }],
        claim: { in_progress: "Agent: In Progress", review: "Agent: In Review", failed: "Agent: Needs Attention" },
      },
    },
    workflow: { phases: [{ id: "implement", prompt: "implement" }] },
  };
}

function stageLibrary(repoRoot: string): StageLibrary {
  return {
    root: repoRoot,
    prompts: new Map([["implement", { name: "implement", agent: "impl-agent", template: "Implement {{issue_id}}." }]]),
    agents: new Set(["impl-agent"]),
    agentFiles: new Map(),
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > 5_000) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function initGitRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "twinpod-orch-"));
  await runFile("git", ["init"], { cwd: repoRoot });
  await runFile("git", ["config", "user.email", "test@twinpod.dev"], { cwd: repoRoot });
  await runFile("git", ["config", "user.name", "Twinpod Test"], { cwd: repoRoot });
  await runFile("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });
  return repoRoot;
}
