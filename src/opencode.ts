import { Agent } from "undici";
import type { OpenCodeRunner, PhaseRunInput, PhaseRunResult } from "./types.js";

// Node's default fetch dispatcher times out request bodies after 5 minutes, which kills
// long-running OpenCode phases mid-stream. Route through an Agent with no timeout instead.
const noTimeoutAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const longRunningFetch = (request: unknown) => (fetch as (input: unknown, init?: Record<string, unknown>) => Promise<unknown>)(request, { dispatcher: noTimeoutAgent });

type OpenCodeModule = {
  createOpencodeServer: (options?: { hostname?: string; port?: number; signal?: AbortSignal }) => Promise<{ url: string; close(): void | Promise<void> }>;
  createOpencodeClient: (options?: { baseUrl?: string; fetch?: (request: unknown) => Promise<unknown> }) => unknown;
};

type AnyResponse<T> = T | { data?: T };

export class SdkOpenCodeRunner implements OpenCodeRunner {
  private clientPromise?: Promise<unknown>;
  private serverHandle?: { server?: { close?: () => void | Promise<void>; url?: string }; client?: unknown };

  constructor(private readonly options: { baseUrl?: string; hostname?: string; port?: number; signal?: AbortSignal } = {}) {}

  async runPhase(input: PhaseRunInput): Promise<PhaseRunResult> {
    const client = await this.client();
    const session = unwrap<{ id: string }>(
      await call(client, ["session", "create"], {
        query: { directory: input.worktreePath },
        body: { title: `${input.issue.identifier} ${input.phase.id}` },
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
    if (this.options.baseUrl) return sdk.createOpencodeClient({ baseUrl: this.options.baseUrl, fetch: longRunningFetch });
    const server = await sdk.createOpencodeServer({
      hostname: this.options.hostname ?? "127.0.0.1",
      port: this.options.port ?? 4096,
      signal: this.options.signal,
    });
    this.serverHandle = { server };
    return sdk.createOpencodeClient({ baseUrl: server.url, fetch: longRunningFetch });
  }
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
