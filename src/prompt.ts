import { Liquid } from "liquidjs";
import { TwinpodError } from "./errors.js";
import { Issue } from "./types.js";

const engine = new Liquid({ strictVariables: true, strictFilters: true });

export async function renderPrompt(template: string, issue: Issue, attempt: number | null): Promise<string> {
  const source = template.trim() || "You are working on an issue from Linear.";
  try {
    return await engine.parseAndRender(source, { issue, attempt });
  } catch (error) {
    throw new TwinpodError("template_render_error", "Failed to render workflow prompt", error);
  }
}

export function buildStagePrompt(input: {
  basePrompt: string;
  stageName: string;
  stagePrompt: string | null;
  cycle: number;
  stageResults: Record<string, string>;
}): string {
  const previous = Object.entries(input.stageResults)
    .map(([stage, result]) => `## Previous stage: ${stage}\n${result}`)
    .join("\n\n");
  return [
    `# Twinpod Stage: ${input.stageName}`,
    `Cycle: ${input.cycle}`,
    input.stagePrompt ? `## Stage guidance\n${input.stagePrompt}` : null,
    previous || null,
    "## Issue task",
    input.basePrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}
