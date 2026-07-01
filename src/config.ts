import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { parseDurationMs } from "./duration.js";
import type { PromptDefinition, RepoRuntimeConfig, StageLibrary, TwinpodConfig, Workflow, WorkflowPhase } from "./types.js";

export function findTwinpodRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export async function loadStageLibrary(twinpodRootInput: string): Promise<StageLibrary> {
  const root = path.resolve(twinpodRootInput);
  const { agents, agentFiles } = await readAgents(root);
  const prompts = await readPrompts(root, agents);
  return { root, prompts, agents, agentFiles };
}

export async function loadRepoConfig(repoRootInput: string, stageLibrary: StageLibrary): Promise<RepoRuntimeConfig> {
  const repoRoot = path.resolve(repoRootInput);
  const configPath = path.join(repoRoot, "twinpod.yaml");
  if (!existsSync(configPath)) throw new Error(`Missing twinpod.yaml in ${repoRoot}`);

  const parsed = requireRecord(YAML.parse(await readFile(configPath, "utf8")), configPath);
  const twinpod = parseTwinpodConfig(parsed, repoRoot, configPath);
  const workflow = parseWorkflow(parsed.workflow, configPath);
  const config: RepoRuntimeConfig = { repoRoot, twinpod, workflow };
  validateRepoConfig(config, stageLibrary);
  return config;
}

export async function loadRepoConfigs(repoRoots: string[], stageLibrary: StageLibrary): Promise<RepoRuntimeConfig[]> {
  return Promise.all(repoRoots.map((repoRoot) => loadRepoConfig(repoRoot, stageLibrary)));
}

export function validateRepoConfig(config: RepoRuntimeConfig, stageLibrary: StageLibrary): void {
  if (config.twinpod.intake.sources.length === 0) {
    throw new Error(`${config.repoRoot}: intake.sources must contain at least one source`);
  }

  const missing: string[] = [];
  config.workflow.phases.forEach((phase) => {
    if (!stageLibrary.prompts.has(phase.prompt)) missing.push(`prompt ${phase.prompt} referenced by workflow.phases[${phase.id}] is not defined in twinpod's prompts/`);
  });
  if (missing.length > 0) throw new Error(`${config.repoRoot}: invalid workflow references:\n${missing.map((entry) => `- ${entry}`).join("\n")}`);
}

function parseTwinpodConfig(value: unknown, repoRoot: string, configPath: string): TwinpodConfig {
  const record = requireRecord(value, configPath);
  const intake = requireRecord(record.intake, `${configPath}: intake`);
  const sourcesValue = intake.sources;
  if (!Array.isArray(sourcesValue)) throw new Error(`${configPath}: intake.sources must be an array`);
  const sources = sourcesValue.map((source, index) => {
    const sourceRecord = requireRecord(source, `${configPath}: intake.sources[${index}]`);
    const project = optionalString(sourceRecord.project);
    const project_slug = optionalString(sourceRecord.project_slug);
    if (!project && !project_slug) throw new Error(`${configPath}: intake.sources[${index}] must set project or project_slug`);
    const statuses = requireStringArray(sourceRecord.statuses, `${configPath}: intake.sources[${index}].statuses`);
    return {
      project,
      project_slug,
      statuses,
      team: optionalString(sourceRecord.team),
      assignee: optionalString(sourceRecord.assignee),
      labels: optionalStringArray(sourceRecord.labels),
      priority_min: optionalNumber(sourceRecord.priority_min),
    };
  });

  const claimRecord = requireRecord(intake.claim, `${configPath}: intake.claim`);
  const pollInterval = optionalString(intake.poll_interval) ?? "30s";
  try {
    parseDurationMs(pollInterval);
  } catch (error) {
    throw new Error(`${configPath}: intake.poll_interval is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const twinpod: TwinpodConfig = {
    repoRoot,
    max_parallel_agents: optionalPositiveInteger(record.max_parallel_agents, `${configPath}: max_parallel_agents`),
    intake: {
      poll_interval: pollInterval,
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

function parseWorkflow(value: unknown, configPath: string): Workflow {
  const workflowRecord = requireRecord(value, `${configPath}: workflow`);
  const phasesValue = workflowRecord.phases;
  if (!Array.isArray(phasesValue) || phasesValue.length === 0) throw new Error(`${configPath}: workflow.phases must be a non-empty array`);
  const phases = phasesValue.map((phase, index) => parsePhase(phase, `${configPath}: workflow.phases[${index}]`));
  return { phases };
}

function parsePhase(value: unknown, context: string): WorkflowPhase {
  const phase = requireRecord(value, context);
  return {
    id: requireString(phase.id, `${context}.id`),
    prompt: requireString(phase.prompt, `${context}.prompt`),
    reads: optionalStringArray(phase.reads),
    writes: optionalStringArray(phase.writes),
    gate: optionalString(phase.gate),
    loop_until: optionalString(phase.loop_until),
    cycles: optionalNumber(phase.cycles),
  };
}

async function readAgents(twinpodRoot: string): Promise<{ agents: Set<string>; agentFiles: Map<string, string> }> {
  const agents = new Set<string>(["general", "build", "plan", "explore"]);
  const agentFiles = new Map<string, string>();
  for (const file of ["opencode.json", "opencode.jsonc", path.join(".opencode", "opencode.json"), path.join(".opencode", "opencode.jsonc")]) {
    const filePath = path.join(twinpodRoot, file);
    if (!existsSync(filePath)) continue;
    const content = stripJsonComments(await readFile(filePath, "utf8"));
    const parsed = JSON.parse(content) as { agent?: Record<string, unknown>; mode?: Record<string, unknown> };
    Object.keys(parsed.agent ?? {}).forEach((name) => agents.add(name));
    Object.keys(parsed.mode ?? {}).forEach((name) => agents.add(name));
  }

  const agentDir = path.join(twinpodRoot, ".opencode", "agents");
  if (existsSync(agentDir)) {
    const entries = await readdir(agentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      const filePath = path.join(agentDir, entry.name);
      const stem = entry.name.replace(/\.md$/i, "");
      agents.add(stem);
      agentFiles.set(stem, filePath);
      const frontmatter = parseFrontmatter(await readFile(filePath, "utf8"));
      const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
      if (frontmatterName) {
        agents.add(frontmatterName);
        agentFiles.set(frontmatterName, filePath);
      }
    }
  }
  return { agents, agentFiles };
}

async function readPrompts(twinpodRoot: string, agents: Set<string>): Promise<Map<string, PromptDefinition>> {
  const prompts = new Map<string, PromptDefinition>();
  const promptsDir = path.join(twinpodRoot, "prompts");
  if (!existsSync(promptsDir)) return prompts;
  const entries = await readdir(promptsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    const filePath = path.join(promptsDir, entry.name);
    const content = await readFile(filePath, "utf8");
    const frontmatter = parseFrontmatter(content);
    const agent = frontmatter.agent;
    if (typeof agent !== "string" || agent.trim() === "") throw new Error(`${filePath}: prompt is missing required frontmatter field "agent"`);
    if (!agents.has(agent)) throw new Error(`${filePath}: frontmatter agent "${agent}" is not defined in .opencode/agents/`);
    const name = typeof frontmatter.name === "string" ? frontmatter.name : entry.name.replace(/\.md$/i, "");
    prompts.set(name, { name, agent, template: stripFrontmatter(content) });
  }
  return prompts;
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return {};
  const parsed = YAML.parse(match[1]) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function stripFrontmatter(content: string): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(content);
  return match ? content.slice(match[0].length) : content;
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

function optionalPositiveInteger(value: unknown, context: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${context} must be a positive integer`);
  return value;
}
