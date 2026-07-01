import { existsSync } from "node:fs";
import { cp, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runFile } from "./process.js";
import { slugify } from "./slug.js";
import type { LinearIssue, StageLibrary } from "./types.js";

export type WorktreeInfo = {
  branch: string;
  path: string;
  runDir: string;
};

export async function materializeStageLibrary(worktreePath: string, stageLibrary: StageLibrary): Promise<void> {
  const agentsDir = path.join(worktreePath, ".opencode", "agents");
  await mkdir(agentsDir, { recursive: true });
  for (const [name, filePath] of stageLibrary.agentFiles) {
    await cp(filePath, path.join(agentsDir, `${name}.md`));
  }

  const skillsSrc = path.join(stageLibrary.root, "skills");
  if (existsSync(skillsSrc)) {
    await cp(skillsSrc, path.join(worktreePath, ".opencode", "skills"), { recursive: true });
  }
}

export async function ensureIssueWorktree(repoRoot: string, issue: LinearIssue): Promise<WorktreeInfo> {
  const branch = `twinpod/${issue.identifier.toLowerCase()}-${slugify(issue.title)}`;
  const existing = await findWorktreeForBranch(repoRoot, branch);
  const worktreePath = existing ?? path.join(path.dirname(repoRoot), ".twinpod-worktrees", path.basename(repoRoot), issue.identifier.toLowerCase());
  if (!existing) {
    await mkdir(path.dirname(worktreePath), { recursive: true });
    if (await branchExists(repoRoot, branch)) await runFile("git", ["worktree", "add", worktreePath, branch], { cwd: repoRoot });
    else await runFile("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], { cwd: repoRoot });
  }
  await linkNodeModules(repoRoot, worktreePath);
  const runDir = path.join(worktreePath, ".twinpod", "runs", issue.id);
  await mkdir(runDir, { recursive: true });
  await ensureGitignore(worktreePath);
  return { branch, path: worktreePath, runDir };
}

export async function cleanupMergedWorktrees(repoRoot: string): Promise<string[]> {
  const worktrees = await listWorktrees(repoRoot);
  const mergedOutput = await runFile("git", ["branch", "--merged"], { cwd: repoRoot });
  const merged = new Set(
    mergedOutput.stdout
      .split("\n")
      .map((line) => line.replace(/^\*/, "").trim())
      .filter(Boolean),
  );
  const removed: string[] = [];
  for (const worktree of worktrees) {
    if (!worktree.branch?.startsWith("twinpod/") || !merged.has(worktree.branch)) continue;
    await runFile("git", ["worktree", "remove", worktree.path], { cwd: repoRoot });
    removed.push(worktree.path);
  }
  return removed;
}

// `git worktree add` never installs dependencies, so freshly created worktrees are missing
// node_modules (and any devDependency binaries like biome/eslint that CI commands need).
// Symlinking from the source checkout is far cheaper than reinstalling per issue.
async function linkNodeModules(repoRoot: string, worktreePath: string): Promise<void> {
  await linkIfMissing(repoRoot, worktreePath, ".");
  const entries = await readdir(repoRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    if (!existsSync(path.join(repoRoot, entry.name, "package.json"))) continue;
    await linkIfMissing(repoRoot, worktreePath, entry.name);
  }
}

async function linkIfMissing(repoRoot: string, worktreePath: string, relativeDir: string): Promise<void> {
  const source = path.join(repoRoot, relativeDir, "node_modules");
  const target = path.join(worktreePath, relativeDir, "node_modules");
  if (!existsSync(source) || existsSync(target)) return;
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(source, target, "dir");
}

async function ensureGitignore(worktreePath: string): Promise<void> {
  const gitignorePath = path.join(worktreePath, ".gitignore");
  if (!existsSync(gitignorePath)) {
    await writeFile(gitignorePath, ".twinpod/\n", "utf8");
    return;
  }
  const { readFile, appendFile } = await import("node:fs/promises");
  const content = await readFile(gitignorePath, "utf8");
  if (!content.split("\n").some((line) => line.trim() === ".twinpod/")) await appendFile(gitignorePath, `${content.endsWith("\n") ? "" : "\n"}.twinpod/\n`, "utf8");
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runFile("git", ["rev-parse", "--verify", branch], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

async function findWorktreeForBranch(repoRoot: string, branch: string): Promise<string | undefined> {
  return (await listWorktrees(repoRoot)).find((worktree) => worktree.branch === branch)?.path;
}

async function listWorktrees(repoRoot: string): Promise<Array<{ path: string; branch?: string }>> {
  const result = await runFile("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const worktrees: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      worktrees.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return worktrees;
}
