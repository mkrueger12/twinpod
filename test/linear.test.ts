import { describe, expect, test, vi } from "vitest";
import { CANDIDATE_QUERY, ISSUE_STATES_QUERY, LinearClient, normalizeLinearIssue } from "../src/linear.js";

describe("Linear client", () => {
  test("candidate query filters by project slugId and paginates in order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { issues: page([{ id: "1", identifier: "TP-1", title: "A", state: { name: "Todo" } }], true, "cursor-1") } }))
      .mockResolvedValueOnce(jsonResponse({ data: { issues: page([{ id: "2", identifier: "TP-2", title: "B", state: { name: "Todo" } }], false, null) } }));
    const client = new LinearClient({ kind: "linear", endpoint: "https://linear.test/graphql", apiKey: "key", projectSlug: "TP", requiredLabels: [], activeStates: ["Todo"], terminalStates: ["Done"] }, fetchMock as any);
    const issues = await client.fetchCandidateIssues();
    expect(issues.map((item) => item.identifier)).toEqual(["TP-1", "TP-2"]);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(firstBody.variables.projectSlug).toBe("TP");
    expect(firstBody.variables.stateNames).toEqual(["Todo"]);
    expect(firstBody.query).toContain("slugId");
  });

  test("empty state fetch avoids API call", async () => {
    const fetchMock = vi.fn();
    const client = new LinearClient({ kind: "linear", endpoint: "https://linear.test/graphql", apiKey: "key", projectSlug: "TP", requiredLabels: [], activeStates: ["Todo"], terminalStates: ["Done"] }, fetchMock as any);
    await expect(client.fetchIssuesByStates([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("state refresh query uses GraphQL ID typing", () => {
    expect(ISSUE_STATES_QUERY).toContain("$ids: [ID!]");
  });

  test("normalizes labels, priority, dates, and blockers from inverse blocks relations", () => {
    const normalized = normalizeLinearIssue({
      id: "1",
      identifier: "TP-1",
      title: "Title",
      priority: "bad",
      state: { name: "Todo" },
      labels: { nodes: [{ name: " Ready " }] },
      inverseRelations: { nodes: [{ type: "blocks", issue: { id: "b1", identifier: "TP-0", state: { name: "Done" } } }, { type: "related", issue: { id: "x" } }] },
      createdAt: "2024-01-01T00:00:00Z",
    });
    expect(normalized.labels).toEqual(["ready"]);
    expect(normalized.priority).toBeNull();
    expect(normalized.blocked_by).toEqual([{ id: "b1", identifier: "TP-0", state: "Done" }]);
    expect(normalized.created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  test("exports candidate query with the required project filter field", () => {
    expect(CANDIDATE_QUERY).toContain("slugId");
    expect(CANDIDATE_QUERY).toContain("$projectSlug");
    expect(CANDIDATE_QUERY).toContain("pageInfo");
  });
});

function page(nodes: unknown[], hasNextPage: boolean, endCursor: string | null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}
