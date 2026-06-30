import type { IntakeSource, LinearIssue } from "./types.js";

type GraphQlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

export class LinearClient {
  constructor(
    private readonly options: { apiKey: string; endpoint?: string; pageSize?: number },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async qualifyingIssues(source: IntakeSource): Promise<LinearIssue[]> {
    const filter: Record<string, unknown> = {
      project: { name: { eq: source.project } },
      state: { name: { in: source.statuses } },
    };
    if (source.team) filter.team = { key: { eq: source.team } };
    if (source.labels && source.labels.length > 0) filter.labels = { name: { in: source.labels } };
    if (source.priority_min !== undefined) filter.priority = { gte: source.priority_min };

    const data = await this.graphql<{ issues: { nodes: LinearIssue[] } }>(
      `query TwinpodQualifyingIssues($filter: IssueFilter, $first: Int!) {
        issues(filter: $filter, first: $first, orderBy: updatedAt) {
          nodes {
            id identifier title description url priority branchName
            state { name }
            project { name }
            team { id key name states { nodes { id name } } }
            labels { nodes { name } }
          }
        }
      }`,
      { filter, first: this.options.pageSize ?? 50 },
    );
    return data.issues.nodes;
  }

  async transitionIssue(issue: LinearIssue, statusName: string): Promise<void> {
    const state = issue.team.states?.nodes.find((candidate) => candidate.name === statusName) ?? (await this.findTeamState(issue.team.id, statusName));
    if (!state) throw new Error(`Linear state ${statusName} not found for issue ${issue.identifier}`);
    await this.graphql<{ issueUpdate: { success: boolean } }>(
      `mutation TwinpodIssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id: issue.id, input: { stateId: state.id } },
    );
  }

  async commentIssue(issueId: string, body: string): Promise<void> {
    await this.graphql<{ commentCreate: { success: boolean } }>(
      `mutation TwinpodCommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }`,
      { input: { issueId, body } },
    );
  }

  private async findTeamState(teamId: string, statusName: string): Promise<{ id: string; name: string } | undefined> {
    const data = await this.graphql<{ team: { states: { nodes: Array<{ id: string; name: string }> } } }>(
      `query TwinpodTeamStates($id: String!) {
        team(id: $id) { states { nodes { id name } } }
      }`,
      { id: teamId },
    );
    return data.team.states.nodes.find((state) => state.name === statusName);
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(this.options.endpoint ?? "https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.options.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}: ${await response.text()}`);
    const payload = (await response.json()) as GraphQlResponse<T>;
    if (payload.errors && payload.errors.length > 0) throw new Error(`Linear GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
    if (!payload.data) throw new Error("Linear GraphQL response did not include data");
    return payload.data;
  }
}
