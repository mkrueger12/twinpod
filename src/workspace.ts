import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { TwinpodError, errorMessage } from "./errors.js";
import { HooksConfig, Logger, Workspace } from "./types.js";
import { isInsideDirectory, sanitizeWorkspaceKey } from "./util.js";

const execAsync = promisify(exec);

export class WorkspaceManager {
  constructor(
    private readonly root: string,
    private readonly hooks: HooksConfig,
    private readonly logger: Logger,
  ) {}

  async createForIssue(identifier: string): Promise<Workspace> {
    const workspaceKey = sanitizeWorkspaceKey(identifier);
    const workspacePath = path.resolve(this.root, workspaceKey);
    this.assertInsideRoot(workspacePath);

    let createdNow = false;
    try {
      const stat = await fs.stat(workspacePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat && !stat.isDirectory()) {
        throw new TwinpodError("workspace_path_not_directory", `Workspace path exists but is not a directory: ${workspacePath}`);
      }
      if (!stat) {
        await fs.mkdir(workspacePath, { recursive: true });
        createdNow = true;
      }
      if (createdNow && this.hooks.afterCreate) await this.runHook("after_create", this.hooks.afterCreate, workspacePath, true);
      return { path: workspacePath, workspaceKey, createdNow };
    } catch (error) {
      if (error instanceof TwinpodError) throw error;
      throw new TwinpodError("workspace_creation_failed", `Failed to create workspace for ${identifier}`, error);
    }
  }

  async beforeRun(workspacePath: string): Promise<void> {
    this.assertInsideRoot(workspacePath);
    if (this.hooks.beforeRun) await this.runHook("before_run", this.hooks.beforeRun, workspacePath, true);
  }

  async afterRun(workspacePath: string): Promise<void> {
    this.assertInsideRoot(workspacePath);
    if (this.hooks.afterRun) await this.runHook("after_run", this.hooks.afterRun, workspacePath, false);
  }

  async removeForIssue(identifier: string): Promise<void> {
    const workspacePath = path.resolve(this.root, sanitizeWorkspaceKey(identifier));
    this.assertInsideRoot(workspacePath);
    const stat = await fs.stat(workspacePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (this.hooks.beforeRemove) await this.runHook("before_remove", this.hooks.beforeRemove, workspacePath, false);
    await fs.rm(workspacePath, { recursive: true, force: true });
  }

  assertInsideRoot(workspacePath: string): void {
    if (!isInsideDirectory(workspacePath, this.root)) {
      throw new TwinpodError("invalid_workspace_cwd", `Workspace path is outside workspace root: ${workspacePath}`);
    }
  }

  private async runHook(name: string, script: string, cwd: string, fatal: boolean): Promise<void> {
    this.logger.info("hook started", { hook: name, cwd });
    try {
      const result = await execAsync(script, {
        cwd,
        timeout: this.hooks.timeoutMs,
        maxBuffer: 64 * 1024,
        shell: "/bin/sh",
      });
      if (result.stderr.trim()) this.logger.warn("hook stderr", { hook: name, stderr: truncate(result.stderr) });
      this.logger.info("hook completed", { hook: name });
    } catch (error) {
      this.logger.warn("hook failed", { hook: name, error: errorMessage(error) });
      if (fatal) throw new TwinpodError("hook_failed", `Hook ${name} failed`, error);
    }
  }
}

function truncate(value: string): string {
  return value.length > 4000 ? `${value.slice(0, 4000)}...` : value;
}
