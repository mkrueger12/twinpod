import type { Classification, LinearIssue, OpenCodeRunner, PhaseRunInput, PhaseRunResult } from "./types.js";

type OpenCodeModule = {
  createOpencodeServer: (options?: { hostname?: string; port?: number; signal?: AbortSignal }) => Promise<{ url: string; close(): void | Promise<void> }>;
  createOpencodeClient: (options?: { baseUrl?: string }) => unknown;
};

type AnyResponse<T> = T | { data?: T };

export class SdkOpenCodeRunner implements OpenCodeRunner {
  private clientPromise?: Promise<unknown>;
  private serverHandle?: { server?: { close?: () => void | Promise<void>; url?: string }; client?: unknown };

  constructor(private readonly options: { baseUrl?: string; hostname?: string; port?: number; signal?: AbortSignal } = {}) {}

  async listAgents(repoRoot: string): Promise<Set<string>> {
    const client = await this.client();
    const result = await call(client, ["app", "agents"], { query: { directory: repoRoot } });
    const agents = unwrap<Array<{ name: string }>>(result as AnyResponse<Array<{ name: string }>>);
    return new Set(agents.map((agent) => agent.name));
  }

  async classify(input: { issue: LinearIssue; repoRoot: string; worktreePath: string; prompt: string }): Promise<Classification> {
    const client = await this.client();
    const session = unwrap<{ id: string }>(
      await call(client, ["session", "create"], {
        query: { directory: input.worktreePath },
        body: { title: `Classify ${input.issue.identifier}` },
      }) as AnyResponse<{ id: string }>,
    );
    const result = await call(client, ["session", "prompt"], {
      path: { id: session.id },
      query: { directory: input.worktreePath },
      body: {
        agent: "general",
        parts: [{ type: "text", text: input.prompt }],
        format: { type: "json_schema", schema: classificationSchema(), retryCount: 2 },
      },
    });
    return normalizeClassification(extractStructuredOutput(result) ?? parseJsonFromText(extractText(result)));
  }

  async runPhase(input: PhaseRunInput): Promise<PhaseRunResult> {
    const client = await this.client();
    const session = unwrap<{ id: string }>(
      await call(client, ["session", "create"], {
        query: { directory: input.worktreePath },
        body: { title: `${input.issue.identifier} ${input.workflow.class}/${input.phase.id}` },
      }) as AnyResponse<{ id: string }>,
    );
    const result = await call(client, ["session", "prompt"], {
      path: { id: session.id },
      query: { directory: input.worktreePath },
      body: {
        agent: input.phase.agent,
        parts: [{ type: "text", text: input.prompt }],
      },
    });
    const unwrapped = unwrap<{ info?: { cost?: number }; parts?: unknown[] }>(result as AnyResponse<{ info?: { cost?: number }; parts?: unknown[] }>);
    return { text: extractText(unwrapped), costUsd: unwrapped.info?.cost };
  }

  async close(): Promise<void> {
    await this.serverHandle?.server?.close?.();
  }

  private async client(): Promise<unknown> {
    this.clientPromise ??= this.createClient();
    return this.clientPromise;
  }

  private async createClient(): Promise<unknown> {
    const sdk = (await import("@opencode-ai/sdk")) as unknown as OpenCodeModule;
    if (this.options.baseUrl) return sdk.createOpencodeClient({ baseUrl: this.options.baseUrl });
    const server = await sdk.createOpencodeServer({
      hostname: this.options.hostname ?? "127.0.0.1",
      port: this.options.port ?? 4096,
      signal: this.options.signal,
    });
    this.serverHandle = { server };
    return sdk.createOpencodeClient({ baseUrl: server.url });
  }
}

function classificationSchema() {
  return {
    type: "object",
    properties: {
      runnable: { type: "boolean" },
      class: { type: "string", enum: ["feature", "bug", "refactor", "docs", "chore", "unclear", "risky"] },
      risk: { type: "string", enum: ["low", "medium", "high"] },
      model_tier: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reasons: { type: "array", items: { type: "string" } },
    },
    required: ["runnable", "class", "risk", "confidence", "reasons"],
    additionalProperties: false,
  };
}

function normalizeClassification(value: unknown): Classification {
  if (!value || typeof value !== "object") throw new Error("Classifier did not return a JSON object");
  const record = value as Record<string, unknown>;
  if (typeof record.runnable !== "boolean") throw new Error("Classifier result missing runnable boolean");
  if (typeof record.class !== "string") throw new Error("Classifier result missing class string");
  if (typeof record.risk !== "string") throw new Error("Classifier result missing risk string");
  if (typeof record.confidence !== "number") throw new Error("Classifier result missing confidence number");
  if (!Array.isArray(record.reasons) || record.reasons.some((reason) => typeof reason !== "string")) throw new Error("Classifier result missing reasons string array");
  return {
    runnable: record.runnable,
    class: record.class,
    risk: record.risk,
    model_tier: typeof record.model_tier === "string" ? record.model_tier : undefined,
    confidence: record.confidence,
    reasons: record.reasons as string[],
  };
}

function extractStructuredOutput(value: unknown): unknown {
  const unwrapped = unwrap<Record<string, unknown>>(value as AnyResponse<Record<string, unknown>>);
  const info = unwrapped.info as Record<string, unknown> | undefined;
  return info?.structured_output ?? info?.structuredOutput;
}

function parseJsonFromText(text: string): unknown {
  const direct = text.trim();
  if (direct.startsWith("{")) return JSON.parse(direct);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) return JSON.parse(fenced[1]);
  const object = /\{[\s\S]*\}/.exec(text);
  if (object) return JSON.parse(object[0]);
  throw new Error("Classifier response did not contain JSON");
}

function extractText(value: unknown): string {
  const unwrapped = unwrap<{ parts?: Array<{ type?: string; text?: string }> }>(value as AnyResponse<{ parts?: Array<{ type?: string; text?: string }> }>);
  return (unwrapped.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function unwrap<T>(value: AnyResponse<T>): T {
  if (value && typeof value === "object" && "data" in value) return ((value as { data?: T }).data ?? value) as T;
  return value as T;
}

async function call(target: unknown, path: string[], input?: unknown): Promise<unknown> {
  let current = target as Record<string, unknown>;
  for (const segment of path.slice(0, -1)) current = current[segment] as Record<string, unknown>;
  const methodName = path[path.length - 1];
  if (!methodName) throw new Error("OpenCode SDK method path cannot be empty");
  const method = current[methodName];
  if (typeof method !== "function") throw new Error(`OpenCode SDK method ${path.join(".")} is not available`);
  return method.call(current, input);
}
