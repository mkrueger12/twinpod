import { describe, expect, test } from "vitest";
import { buildServiceConfig } from "../src/config.js";
import { TwinpodError } from "../src/errors.js";
import { renderPrompt } from "../src/prompt.js";
import { parseWorkflow, selectWorkflowPath } from "../src/workflow.js";
import { issue } from "./helpers.js";

describe("workflow and config", () => {
  test("selects explicit path or cwd WORKFLOW.md", () => {
    expect(selectWorkflowPath("custom.md", "/repo")).toBe("/repo/custom.md");
    expect(selectWorkflowPath(undefined, "/repo")).toBe("/repo/WORKFLOW.md");
  });

  test("parses YAML front matter and prompt body", () => {
    const workflow = parseWorkflow("---\ntracker:\n  kind: linear\n---\n# Prompt\n", "/repo/WORKFLOW.md");
    expect(workflow.config).toEqual({ tracker: { kind: "linear" } });
    expect(workflow.prompt_template).toBe("# Prompt");
  });

  test("rejects non-map front matter", () => {
    expect(() => parseWorkflow("---\n- nope\n---\nBody", "/repo/WORKFLOW.md")).toThrow(TwinpodError);
  });

  test("applies defaults, env indirection, path resolution, and state concurrency normalization", () => {
    const workflow = parseWorkflow(
      `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: TP
workspace:
  root: ./work
agent:
  max_concurrent_agents_by_state:
    Todo: 2
    bad: 0
opencode:
  command: opencode --profile twinpod
  server: {}
---
Prompt`,
      "/repo/WORKFLOW.md",
    );
    const cfg = buildServiceConfig(workflow, { LINEAR_API_KEY: "secret" });
    expect(cfg.tracker.apiKey).toBe("secret");
    expect(cfg.workspace.root).toBe("/repo/work");
    expect(cfg.opencode.command).toBe("opencode --profile twinpod");
    expect(cfg.agent.maxConcurrentAgentsByState.get("todo")).toBe(2);
    expect(cfg.agent.maxConcurrentAgentsByState.has("bad")).toBe(false);
    expect(cfg.opencode.pipeline.map((stage) => stage.name)).toEqual(["plan", "execute", "review"]);
  });
});

describe("prompt rendering", () => {
  test("renders issue and attempt in strict mode", async () => {
    await expect(renderPrompt("{{ issue.identifier }} {{ attempt }}", issue(), 3)).resolves.toBe("TP-1 3");
  });

  test("fails on unknown variables", async () => {
    await expect(renderPrompt("{{ missing.value }}", issue(), null)).rejects.toMatchObject({ code: "template_render_error" });
  });
});
