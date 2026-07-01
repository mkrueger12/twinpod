import os from "node:os";
import path from "node:path";

export function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function isInsideDirectory(child: string, parent: string): boolean {
  const normalizedChild = path.resolve(child);
  const normalizedParent = path.resolve(parent);
  const relative = path.relative(normalizedParent, normalizedChild);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function resolveEnvReference(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value !== "string") return value;
  const match = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!match) return value;
  return env[match[1]] ?? "";
}

export function resolvePathValue(value: unknown, baseDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const resolvedEnv = String(resolveEnvReference(value, env));
  const expanded = expandHome(resolvedEnv);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded));
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string");
}

export function asInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? (value as number) : fallback;
}

export function asPositiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function monotonicMs(): number {
  return performance.now();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}
