import { Logger, ServiceConfig } from "../src/types.js";
import { buildServiceConfig } from "../src/config.js";
import { parseWorkflow } from "../src/workflow.js";

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export function config(overrides = "", env: NodeJS.ProcessEnv = { LINEAR_API_KEY: "test-key" }): ServiceConfig {
  const workflow = parseWorkflow(
    `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: TEST
opencode:
  server: {}
${overrides}
---
Work on {{ issue.identifier }} attempt={{ attempt }}
`,
    "/tmp/repo/WORKFLOW.md",
  );
  return buildServiceConfig(workflow, env);
}

export function issue(partial: Partial<import("../src/types.js").Issue> = {}): import("../src/types.js").Issue {
  return {
    id: "issue-1",
    identifier: "TP-1",
    title: "Do work",
    description: null,
    priority: 2,
    state: "Todo",
    branch_name: null,
    url: "https://linear.test/TP-1",
    labels: [],
    blocked_by: [],
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: null,
    ...partial,
  };
}
