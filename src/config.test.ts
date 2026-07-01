import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRepoConfig, loadStageLibrary } from "./config.js";

describe("loadStageLibrary", () => {
  it("loads central prompts bound to their frontmatter agent", async () => {
    const twinpodRoot = await fixtureStageLibrary();

    const stageLibrary = await loadStageLibrary(twinpodRoot);

    expect(stageLibrary.agents.has("design-agent")).toBe(true);
    expect(stageLibrary.prompts.get("design")?.agent).toBe("design-agent");
    expect(stageLibrary.prompts.get("design")?.template.trim()).toBe("Design {{issue_id}} using {{reads}} and write {{writes}}.");
  });

  it("hard-fails when a prompt's frontmatter agent is not defined", async () => {
    const twinpodRoot = await fixtureStageLibrary({ promptAgent: "missing-agent" });

    await expect(loadStageLibrary(twinpodRoot)).rejects.toThrow(/frontmatter agent "missing-agent" is not defined/);
  });
});

describe("loadRepoConfig", () => {
  it("loads repo-local config and workflow, validated against the central stage library", async () => {
    const twinpodRoot = await fixtureStageLibrary();
    const stageLibrary = await loadStageLibrary(twinpodRoot);
    const repo = await fixtureRepo();

    const config = await loadRepoConfig(repo, stageLibrary);

    expect(config.repoRoot).toBe(repo);
    expect(config.twinpod.intake.sources[0]?.project).toBe("Twinpod Backlog");
    expect(config.workflow.phases[0]?.prompt).toBe("design");
  });

  it("accepts Linear project slugs as the source binding", async () => {
    const twinpodRoot = await fixtureStageLibrary();
    const stageLibrary = await loadStageLibrary(twinpodRoot);
    const repo = await fixtureRepo({ projectKey: "project_slug", projectValue: "agent-v2-e6613e94140b" });

    const config = await loadRepoConfig(repo, stageLibrary);

    expect(config.twinpod.intake.sources[0]?.project_slug).toBe("agent-v2-e6613e94140b");
  });

  it("hard-fails when a workflow references a prompt the stage library doesn't define", async () => {
    const twinpodRoot = await fixtureStageLibrary();
    const stageLibrary = await loadStageLibrary(twinpodRoot);
    const repo = await fixtureRepo({ promptName: "missing-prompt" });

    await expect(loadRepoConfig(repo, stageLibrary)).rejects.toThrow(/prompt missing-prompt referenced by workflow.phases\[design\]/);
  });
});

async function fixtureStageLibrary(options: { promptAgent?: string } = {}): Promise<string> {
  const twinpodRoot = await mkdtemp(path.join(os.tmpdir(), "twinpod-stagelib-"));
  await mkdir(path.join(twinpodRoot, "prompts"), { recursive: true });
  await mkdir(path.join(twinpodRoot, ".opencode", "agents"), { recursive: true });
  await writeFile(
    path.join(twinpodRoot, "prompts", "design.md"),
    `---\nagent: ${options.promptAgent ?? "design-agent"}\n---\nDesign {{issue_id}} using {{reads}} and write {{writes}}.`,
    "utf8",
  );
  await writeFile(path.join(twinpodRoot, ".opencode", "agents", "design-agent.md"), "---\nmodel: test/model\n---\nYou design.", "utf8");
  return twinpodRoot;
}

async function fixtureRepo(options: { promptName?: string; projectKey?: string; projectValue?: string } = {}): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "twinpod-config-"));
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

workflow:
  phases:
    - id: design
      prompt: ${options.promptName ?? "design"}
      reads: [issue.md]
      writes: [design.md]
`,
    "utf8",
  );
  return repo;
}
