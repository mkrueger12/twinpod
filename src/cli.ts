#!/usr/bin/env node
import fs from "node:fs";
import { TwinpodService } from "./service.js";
import { selectWorkflowPath } from "./workflow.js";
import { consoleLogger } from "./logger.js";
import { errorCode, errorMessage } from "./errors.js";

interface CliArgs {
  workflowPath?: string;
  port: number | null;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const workflowPath = selectWorkflowPath(args.workflowPath);
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Workflow file not found: ${workflowPath}`);
  }
  const service = new TwinpodService(workflowPath, args.port, consoleLogger);
  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await service.start();
}

export function parseArgs(argv: string[]): CliArgs {
  let workflowPath: string | undefined;
  let port: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      const raw = argv[++index];
      if (raw === undefined || !Number.isInteger(Number(raw))) throw new Error("--port requires an integer value");
      port = Number(raw);
    } else if (arg.startsWith("--port=")) {
      const raw = arg.slice("--port=".length);
      if (!Number.isInteger(Number(raw))) throw new Error("--port requires an integer value");
      port = Number(raw);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: twinpod [path-to-WORKFLOW.md] [--port <port>]\n");
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (!workflowPath) {
      workflowPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { workflowPath, port };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    consoleLogger.error("startup failed", { code: errorCode(error), error: errorMessage(error) });
    process.exit(1);
  });
}
