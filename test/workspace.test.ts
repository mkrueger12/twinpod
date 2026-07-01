import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WorkspaceManager } from "../src/workspace.js";
import { silentLogger } from "./helpers.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "twinpod-test-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("workspace manager", () => {
  test("creates deterministic sanitized workspaces and reuses them", async () => {
    const manager = new WorkspaceManager(root, emptyHooks(), silentLogger);
    const created = await manager.createForIssue("TP/1: unsafe");
    const reused = await manager.createForIssue("TP/1: unsafe");
    expect(created.workspaceKey).toBe("TP_1__unsafe");
    expect(created.createdNow).toBe(true);
    expect(reused.createdNow).toBe(false);
    expect(reused.path).toBe(created.path);
  });

  test("runs after_create only for new workspace and before_run for every attempt", async () => {
    const marker = path.join(root, "events.log");
    const manager = new WorkspaceManager(
      root,
      { ...emptyHooks(), afterCreate: `printf after_create >> ${marker}`, beforeRun: `printf before_run >> ${marker}` },
      silentLogger,
    );
    const workspace = await manager.createForIssue("TP-1");
    await manager.createForIssue("TP-1");
    await manager.beforeRun(workspace.path);
    await manager.beforeRun(workspace.path);
    expect(await fs.readFile(marker, "utf8")).toBe("after_createbefore_runbefore_run");
  });

  test("rejects non-directory workspace path", async () => {
    const manager = new WorkspaceManager(root, emptyHooks(), silentLogger);
    await fs.writeFile(path.join(root, "TP-1"), "file");
    await expect(manager.createForIssue("TP-1")).rejects.toMatchObject({ code: "workspace_path_not_directory" });
  });
});

function emptyHooks() {
  return { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 };
}
