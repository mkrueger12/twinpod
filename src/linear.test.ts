import { describe, expect, it } from "vitest";
import { LinearClient } from "./linear.js";
import type { LinearIssue } from "./types.js";

describe("LinearClient", () => {
  it("queries qualifying issues with pure config-driven filters", async () => {
    const requests: unknown[] = [];
    const client = new LinearClient(
      { apiKey: "lin_api_key", pageSize: 25 },
      async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return jsonResponse({ data: { issues: { nodes: [] } } });
      },
    );

    await client.qualifyingIssues({ project: "Twinpod Backlog", statuses: ["Ready for Agent"], team: "ENG", labels: ["agent"], priority_min: 2 });

    expect(requests[0]).toMatchObject({
      variables: {
        first: 25,
        filter: {
          project: { name: { eq: "Twinpod Backlog" } },
          state: { name: { in: ["Ready for Agent"] } },
          team: { key: { eq: "ENG" } },
          labels: { name: { in: ["agent"] } },
          priority: { gte: 2 },
        },
      },
    });
  });

  it("transitions by resolving the named team state", async () => {
    const mutations: unknown[] = [];
    const issue: LinearIssue = {
      id: "issue-id",
      identifier: "TWIN-1",
      title: "Do it",
      state: { name: "Ready for Agent" },
      team: { id: "team-id", states: { nodes: [{ id: "state-review", name: "Agent: In Review" }] } },
    };
    const client = new LinearClient(
      { apiKey: "lin_api_key" },
      async (_url, init) => {
        mutations.push(JSON.parse(String(init?.body)));
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      },
    );

    await client.transitionIssue(issue, "Agent: In Review");

    expect(mutations[0]).toMatchObject({ variables: { id: "issue-id", input: { stateId: "state-review" } } });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
