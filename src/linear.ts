import { TwinpodError } from "./errors.js";
import { Issue, TrackerClient, TrackerConfig } from "./types.js";
import { normalizeLabel } from "./util.js";

interface LinearPage<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export class LinearClient implements TrackerClient {
  constructor(private readonly config: TrackerConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuePages(CANDIDATE_QUERY, { projectSlug: this.config.projectSlug, stateNames: this.config.activeStates, first: 50 });
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    return this.fetchIssuePages(CANDIDATE_QUERY, { projectSlug: this.config.projectSlug, stateNames, first: 50 });
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];
    const data = await this.graphql(ISSUE_STATES_QUERY, { ids: issueIds });
    const nodes = data?.issues?.nodes;
    if (!Array.isArray(nodes)) throw new TwinpodError("linear_unknown_payload", "Linear issue state response was malformed");
    return nodes.map(normalizeLinearIssue);
  }

  private async fetchIssuePages(query: string, variables: Record<string, unknown>): Promise<Issue[]> {
    const issues: Issue[] = [];
    let after: string | null = null;
    do {
      const data = await this.graphql(query, { ...variables, after });
      const page = data?.issues as LinearPage<unknown> | undefined;
      if (!page || !Array.isArray(page.nodes) || !page.pageInfo) {
        throw new TwinpodError("linear_unknown_payload", "Linear issue page response was malformed");
      }
      issues.push(...page.nodes.map(normalizeLinearIssue));
      if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
        throw new TwinpodError("linear_missing_end_cursor", "Linear page indicated hasNextPage without endCursor");
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return issues;
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.endpoint, {
        method: "POST",
        headers: {
          Authorization: this.config.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new TwinpodError("linear_api_request", "Linear API request failed", error);
    }
    if (!response.ok) throw new TwinpodError("linear_api_status", `Linear API returned HTTP ${response.status}`);
    const payload: any = await response.json().catch((error) => {
      throw new TwinpodError("linear_unknown_payload", "Linear API returned invalid JSON", error);
    });
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new TwinpodError("linear_graphql_errors", "Linear GraphQL response contained errors", payload.errors);
    }
    if (!payload || typeof payload !== "object" || !("data" in payload)) {
      throw new TwinpodError("linear_unknown_payload", "Linear GraphQL response missing data");
    }
    return payload.data;
  }
}

export function normalizeLinearIssue(input: any): Issue {
  const labels = Array.isArray(input?.labels?.nodes) ? input.labels.nodes.map((label: any) => label?.name).filter(Boolean) : [];
  const inverseRelations = Array.isArray(input?.inverseRelations?.nodes) ? input.inverseRelations.nodes : [];
  const blockedBy = inverseRelations
    .filter((relation: any) => relation?.type === "blocks")
    .map((relation: any) => ({
      id: relation?.issue?.id ?? null,
      identifier: relation?.issue?.identifier ?? null,
      state: relation?.issue?.state?.name ?? null,
    }));
  return {
    id: String(input?.id ?? ""),
    identifier: String(input?.identifier ?? ""),
    title: String(input?.title ?? ""),
    description: typeof input?.description === "string" ? input.description : null,
    priority: Number.isInteger(input?.priority) ? input.priority : null,
    state: String(input?.state?.name ?? input?.state ?? ""),
    branch_name: typeof input?.branchName === "string" ? input.branchName : null,
    url: typeof input?.url === "string" ? input.url : null,
    labels: labels.map(normalizeLabel),
    blocked_by: blockedBy,
    created_at: typeof input?.createdAt === "string" && !Number.isNaN(Date.parse(input.createdAt)) ? new Date(input.createdAt).toISOString() : null,
    updated_at: typeof input?.updatedAt === "string" && !Number.isNaN(Date.parse(input.updatedAt)) ? new Date(input.updatedAt).toISOString() : null,
  };
}

export const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { name } } } }
`;

export const CANDIDATE_QUERY = `
  query TwinpodCandidateIssues($projectSlug: String!, $stateNames: [String!], $first: Int!, $after: String) {
    issues(filter: { project: { slugId: { eq: $projectSlug } }, state: { name: { in: $stateNames } } }, first: $first, after: $after) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const ISSUE_STATES_QUERY = `
  query TwinpodIssueStates($ids: [ID!]) {
    issues(filter: { id: { in: $ids } }) {
      nodes { ${ISSUE_FIELDS} }
    }
  }
`;
