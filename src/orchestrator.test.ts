import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { runFile } from "./process.js";
import type { LinearClient } from "./linear.js";
import type { LinearIssue, OpenCodeRunner, RepoRuntimeConfig, StageLibrary } from "./types.js";

describe("Orchestrator", () => {
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

async function initGitRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "twinpod-orch-"));
  await runFile("git", ["init"], { cwd: repoRoot });
  await runFile("git", ["config", "user.email", "test@twinpod.dev"], { cwd: repoRoot });
  await runFile("git", ["config", "user.name", "Twinpod Test"], { cwd: repoRoot });
  await runFile("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });
  return repoRoot;
}
