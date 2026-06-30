import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRepoConfig } from "./config.js";

describe("loadRepoConfig", () => {
  it("loads repo-local config, workflows, prompts, and agents", async () => {
    const repo = await fixtureRepo();
    const config = await loadRepoConfig(repo);

    expect(config.repoRoot).toBe(repo);
    expect(config.twinpod.intake.sources[0]?.project).toBe("Twinpod Backlog");
    expect(config.workflows.get("feature")?.phases[0]?.agent).toBe("design-agent");
    expect(config.agents.has("design-agent")).toBe(true);
  });

  it("accepts Linear project slugs as the source binding", async () => {
    const repo = await fixtureRepo({ projectKey: "project_slug", projectValue: "agent-v2-e6613e94140b" });

    const config = await loadRepoConfig(repo);

    expect(config.twinpod.intake.sources[0]?.project_slug).toBe("agent-v2-e6613e94140b");
  });

  it("hard-fails when a workflow references a missing agent", async () => {
    const repo = await fixtureRepo({ agentName: "other-agent" });

    await expect(loadRepoConfig(repo)).rejects.toThrow(/design-agent referenced by workflows\/feature.yaml phase design/);
  });

  it("hard-fails when a workflow references a missing prompt", async () => {
    const repo = await fixtureRepo({ promptPath: "prompts/missing.md" });

    await expect(loadRepoConfig(repo)).rejects.toThrow(/prompt prompts\/missing.md referenced by workflows\/feature.yaml phase design/);
  });
});

async function fixtureRepo(options: { agentName?: string; promptPath?: string; projectKey?: string; projectValue?: string } = {}): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "twinpod-config-"));
  await mkdir(path.join(repo, "workflows"), { recursive: true });
  await mkdir(path.join(repo, "prompts"), { recursive: true });
  await mkdir(path.join(repo, ".opencode", "agents"), { recursive: true });
  await writeFile(
    path.join(repo, "twinpod.yaml"),
    `intake:
  poll_interval: 30s
  sources:
    - ${options.projectKey ?? "project"}: ${options.projectValue ?? "Twinpod Backlog"}
      statuses: [Ready for Agent]
  claim:
    in_progress: "Agent: In Progress"
    review: "Agent: In Review"
    failed: "Agent: Needs Attention"
`,
    "utf8",
  );
  await writeFile(
    path.join(repo, "workflows", "feature.yaml"),
    `class: feature
phases:
  - id: design
    agent: design-agent
    prompt: ${options.promptPath ?? "prompts/design.md"}
    reads: [issue.md]
    writes: [design.md]
`,
    "utf8",
  );
  await writeFile(path.join(repo, "prompts", "design.md"), "Design {{issue_id}} using {{reads}} and write {{writes}}.", "utf8");
  await writeFile(path.join(repo, ".opencode", "agents", `${options.agentName ?? "design-agent"}.md`), "---\nmodel: test/model\n---\nYou design.", "utf8");
  return repo;
}
