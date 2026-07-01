import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { TwinpodError } from "./errors.js";
import { WorkflowDefinition } from "./types.js";

export function selectWorkflowPath(explicitPath?: string, cwd = process.cwd()): string {
  return path.resolve(cwd, explicitPath ?? "WORKFLOW.md");
}

export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new TwinpodError("missing_workflow_file", `Workflow file not found: ${filePath}`, error);
  }

  try {
    return parseWorkflow(raw, filePath);
  } catch (error) {
    if (error instanceof TwinpodError) throw error;
    throw new TwinpodError("workflow_parse_error", `Failed to parse workflow file: ${filePath}`, error);
  }
}

export function parseWorkflow(raw: string, filePath: string): WorkflowDefinition {
  let config: Record<string, unknown> = {};
  let body = raw;

  if (raw.startsWith("---")) {
    const lines = raw.split(/\r?\n/);
    let end = -1;
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].trim() === "---") {
        end = index;
        break;
      }
    }
    if (end === -1) {
      throw new TwinpodError("workflow_parse_error", "YAML front matter was opened but not closed");
    }

    const yamlText = lines.slice(1, end).join("\n");
    const parsed = yamlText.trim() === "" ? {} : parseYaml(yamlText);
    if (parsed === null) config = {};
    else if (typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
    else throw new TwinpodError("workflow_front_matter_not_a_map", "Workflow front matter must be a map/object");
    body = lines.slice(end + 1).join("\n");
  }

  return { config, prompt_template: body.trim(), path: path.resolve(filePath) };
}
