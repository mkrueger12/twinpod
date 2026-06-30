import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export async function runFile(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function runShell(
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const result = await execFileAsync(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/c", command] : ["-lc", command], {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 10 * 60_000,
    maxBuffer: 50 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export function errorOutput(error: unknown): string {
  if (error && typeof error === "object") {
    const anyError = error as { stdout?: string; stderr?: string; message?: string };
    return [anyError.stdout, anyError.stderr, anyError.message].filter(Boolean).join("\n");
  }
  return String(error);
}
