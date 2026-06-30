import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { errorOutput, runFile, runShell } from "./process.js";

export type CiResult = {
  ok: boolean;
  command?: string;
  output: string;
};

export async function detectCiCommand(worktreePath: string, override?: string): Promise<string | undefined> {
  if (override) return override;
  const packagePath = path.join(worktreePath, "package.json");
  if (existsSync(packagePath)) {
    const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = parsed.scripts ?? {};
    if (scripts.ci) return packageManager(worktreePath, "run ci");
    const pieces: string[] = [];
    if (scripts.test) pieces.push(packageManager(worktreePath, "test"));
    if (scripts.lint) pieces.push(packageManager(worktreePath, "run lint"));
    if (scripts.build) pieces.push(packageManager(worktreePath, "run build"));
    if (pieces.length > 0) return pieces.join(" && ");
  }
  if (existsSync(path.join(worktreePath, "Makefile"))) return "make test";
  if (existsSync(path.join(worktreePath, "Cargo.toml"))) return "cargo test";
  if (existsSync(path.join(worktreePath, "go.mod"))) return "go test ./...";
  return undefined;
}

export async function runCi(worktreePath: string, override?: string): Promise<CiResult> {
  const command = await detectCiCommand(worktreePath, override);
  if (!command) return { ok: false, output: "No CI command could be auto-detected and ci.command is not configured." };
  try {
    const result = await runShell(command, { cwd: worktreePath, timeoutMs: 30 * 60_000 });
    return { ok: true, command, output: [result.stdout, result.stderr].filter(Boolean).join("\n") };
  } catch (error) {
    return { ok: false, command, output: errorOutput(error) };
  }
}

export async function currentPrUrl(worktreePath: string): Promise<string | undefined> {
  try {
    const result = await runFile("gh", ["pr", "view", "--json", "url", "--jq", ".url"], { cwd: worktreePath, timeoutMs: 30_000 });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function packageManager(worktreePath: string, script: string): string {
  if (existsSync(path.join(worktreePath, "pnpm-lock.yaml"))) return `pnpm ${script}`;
  if (existsSync(path.join(worktreePath, "yarn.lock"))) return `yarn ${script}`;
  return `npm ${script}`;
}
