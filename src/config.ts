import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { RepoRuntimeConfig, TwinpodConfig, Workflow, WorkflowPhase } from "./types.js";

export async function loadRepoConfig(repoRootInput: string): Promise<RepoRuntimeConfig> {
  const repoRoot = path.resolve(repoRootInput);
  const configPath = path.join(repoRoot, "twinpod.yaml");
  if (!existsSync(configPath)) throw new Error(`Missing twinpod.yaml in ${repoRoot}`);

  const parsed = YAML.parse(await readFile(configPath, "utf8")) as unknown;
  const twinpod = parseTwinpodConfig(parsed, repoRoot, configPath);
  const workflows = await loadWorkflows(repoRoot);
  const agents = await readLocalAgents(repoRoot);
  validateRepoConfig({ repoRoot, twinpod, workflows, agents });
  return { repoRoot, twinpod, workflows, agents };
}

export async function loadRepoConfigs(repoRoots: string[]): Promise<RepoRuntimeConfig[]> {
  return Promise.all(repoRoots.map((repoRoot) => loadRepoConfig(repoRoot)));
}

export function validateRepoConfig(config: RepoRuntimeConfig): void {
  if (config.twinpod.intake.sources.length === 0) {
    throw new Error(`${config.repoRoot}: intake.sources must contain at least one source`);
  }
  if (config.workflows.size === 0) {
    throw new Error(`${config.repoRoot}: workflows/*.yaml must define at least one workflow`);
  }

  const missing: string[] = [];
  for (const workflow of config.workflows.values()) {
    workflow.phases.forEach((phase) => {
      if (!config.agents.has(phase.agent)) missing.push(`${phase.agent} referenced by ${path.relative(config.repoRoot, workflow.filePath)} phase ${phase.id}`);
      if (!existsSync(path.join(config.repoRoot, phase.prompt))) {
        missing.push(`prompt ${phase.prompt} referenced by ${path.relative(config.repoRoot, workflow.filePath)} phase ${phase.id}`);
      }
    });
  }
  if (missing.length > 0) throw new Error(`${config.repoRoot}: invalid workflow references:\n${missing.map((entry) => `- ${entry}`).join("\n")}`);
}

function parseTwinpodConfig(value: unknown, repoRoot: string, configPath: string): TwinpodConfig {
  const record = requireRecord(value, configPath);
  const intake = requireRecord(record.intake, `${configPath}: intake`);
  const sourcesValue = intake.sources;
  if (!Array.isArray(sourcesValue)) throw new Error(`${configPath}: intake.sources must be an array`);
  const sources = sourcesValue.map((source, index) => {
    const sourceRecord = requireRecord(source, `${configPath}: intake.sources[${index}]`);
    const project = requireString(sourceRecord.project, `${configPath}: intake.sources[${index}].project`);
    const statuses = requireStringArray(sourceRecord.statuses, `${configPath}: intake.sources[${index}].statuses`);
    return {
      project,
      statuses,
      team: optionalString(sourceRecord.team),
      labels: optionalStringArray(sourceRecord.labels),
      priority_min: optionalNumber(sourceRecord.priority_min),
    };
  });

  const claimRecord = requireRecord(intake.claim, `${configPath}: intake.claim`);
  const twinpod: TwinpodConfig = {
    repoRoot,
    intake: {
      poll_interval: optionalString(intake.poll_interval) ?? "30s",
      sources,
      claim: {
        in_progress: requireString(claimRecord.in_progress, `${configPath}: intake.claim.in_progress`),
        review: requireString(claimRecord.review, `${configPath}: intake.claim.review`),
        failed: requireString(claimRecord.failed, `${configPath}: intake.claim.failed`),
        needs_info: optionalString(claimRecord.needs_info),
      },
    },
  };

  if (record.linear !== undefined) {
    const linear = requireRecord(record.linear, `${configPath}: linear`);
    twinpod.linear = {
      api_key: optionalString(linear.api_key),
      api_key_env: optionalString(linear.api_key_env),
      endpoint: optionalString(linear.endpoint),
      page_size: optionalNumber(linear.page_size),
    };
  }
  if (record.ci !== undefined) {
    const ci = requireRecord(record.ci, `${configPath}: ci`);
    twinpod.ci = { command: optionalString(ci.command) };
  }
  return twinpod;
}

async function loadWorkflows(repoRoot: string): Promise<Map<string, Workflow>> {
  const workflowsDir = path.join(repoRoot, "workflows");
  const workflows = new Map<string, Workflow>();
  if (!existsSync(workflowsDir)) return workflows;
  const entries = await readdir(workflowsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const filePath = path.join(workflowsDir, entry.name);
    const workflowRecord = requireRecord(YAML.parse(await readFile(filePath, "utf8")), filePath);
    const workflowClass = requireString(workflowRecord.class, `${filePath}: class`);
    if (workflows.has(workflowClass)) throw new Error(`${repoRoot}: duplicate workflow for class ${workflowClass}`);
    const phasesValue = workflowRecord.phases;
    if (!Array.isArray(phasesValue) || phasesValue.length === 0) throw new Error(`${filePath}: phases must be a non-empty array`);
    const phases = phasesValue.map((phase, index) => parsePhase(phase, `${filePath}: phases[${index}]`));
    workflows.set(workflowClass, { filePath, class: workflowClass, phases });
  }
  return workflows;
}

function parsePhase(value: unknown, context: string): WorkflowPhase {
  const phase = requireRecord(value, context);
  return {
    id: requireString(phase.id, `${context}.id`),
    agent: requireString(phase.agent, `${context}.agent`),
    prompt: requireString(phase.prompt, `${context}.prompt`),
    reads: optionalStringArray(phase.reads),
    writes: optionalStringArray(phase.writes),
    gate: optionalString(phase.gate),
    loop_until: optionalString(phase.loop_until),
    budget: phase.budget === undefined ? undefined : parseBudget(phase.budget, `${context}.budget`),
  };
}

function parseBudget(value: unknown, context: string) {
  const budget = requireRecord(value, context);
  return { usd: optionalNumber(budget.usd), cycles: optionalNumber(budget.cycles) };
}

export async function readLocalAgents(repoRoot: string): Promise<Set<string>> {
  const agents = new Set<string>(["general", "build", "plan", "explore"]);
  for (const file of ["opencode.json", "opencode.jsonc", path.join(".opencode", "opencode.json"), path.join(".opencode", "opencode.jsonc")]) {
    const filePath = path.join(repoRoot, file);
    if (!existsSync(filePath)) continue;
    const content = stripJsonComments(await readFile(filePath, "utf8"));
    const parsed = JSON.parse(content) as { agent?: Record<string, unknown>; mode?: Record<string, unknown> };
    Object.keys(parsed.agent ?? {}).forEach((name) => agents.add(name));
    Object.keys(parsed.mode ?? {}).forEach((name) => agents.add(name));
  }

  const agentDir = path.join(repoRoot, ".opencode", "agents");
  if (existsSync(agentDir)) {
    const entries = await readdir(agentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      const filePath = path.join(agentDir, entry.name);
      agents.add(entry.name.replace(/\.md$/i, ""));
      const frontmatterName = parseFrontmatterName(await readFile(filePath, "utf8"));
      if (frontmatterName) agents.add(frontmatterName);
    }
  }
  return agents;
}

function parseFrontmatterName(content: string): string | undefined {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return undefined;
  const parsed = YAML.parse(match[1]) as unknown;
  if (!parsed || typeof parsed !== "object") return undefined;
  const name = (parsed as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function stripJsonComments(content: string): string {
  return content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${context} must be a non-empty string`);
  return value;
}

function requireStringArray(value: unknown, context: string): string[] {
  const array = optionalStringArray(value);
  if (!array || array.length === 0) throw new Error(`${context} must be a non-empty string array`);
  return array;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) return undefined;
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
