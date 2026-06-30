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
        parts: [{ type: "text", text: `${input.prompt}\n\nReturn exactly one raw JSON object. Do not include markdown fences, commentary, or extra text.` }],
      },
    });
    const firstText = extractTextOrThrow(result);
    try {
      return normalizeClassification(parseJsonFromText(firstText));
    } catch {
      const repair = await call(client, ["session", "prompt"], {
        path: { id: session.id },
        query: { directory: input.worktreePath },
        body: {
          agent: "general",
          parts: [
            {
              type: "text",
              text: `Your previous classifier response was not valid Twinpod classification JSON. Convert it to exactly one raw JSON object with keys runnable, class, risk, model_tier, confidence, and reasons. No markdown. Previous response:\n\n${firstText}`,
            },
          ],
        },
      });
      const repairText = extractTextOrThrow(repair);
      try {
        return normalizeClassification(parseJsonFromText(repairText));
      } catch (error) {
        throw new Error(`Classifier response did not contain valid JSON. First response: ${firstText.slice(0, 2000)}\nRepair response: ${repairText.slice(0, 2000)}`);
      }
    }
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
        agent: input.agent,
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

function parseJsonFromText(text: string): unknown {
  const direct = text.trim();
  if (direct.startsWith("{")) return JSON.parse(direct);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) return JSON.parse(fenced[1]);
  const object = /\{[\s\S]*\}/.exec(text);
  if (object) return JSON.parse(object[0]);
  throw new Error("Classifier response did not contain JSON");
}

function extractTextOrThrow(value: unknown): string {
  const text = extractText(value);
  if (text) return text;
  const unwrapped = unwrap<{ info?: { error?: unknown }; error?: unknown }>(value as AnyResponse<{ info?: { error?: unknown }; error?: unknown }>);
  const error = unwrapped.info?.error ?? unwrapped.error;
  if (error) throw new Error(`OpenCode classifier failed: ${JSON.stringify(error)}`);
  throw new Error(`OpenCode classifier returned no text: ${JSON.stringify(value).slice(0, 2000)}`);
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
