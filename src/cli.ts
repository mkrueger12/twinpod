#!/usr/bin/env node
import { loadRepoConfigs } from "./config.js";
import { consoleLogger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { LinearClient } from "./linear.js";
import { SdkOpenCodeRunner } from "./opencode.js";
import { runTui } from "./tui.js";
import { cleanupMergedWorktrees } from "./worktree.js";
import type { RepoRuntimeConfig } from "./types.js";

type CliOptions = {
  command: "serve" | "tui" | "cleanup" | "validate" | "help";
  repos: string[];
  once: boolean;
  linearApiKey?: string;
  linearEndpoint?: string;
  opencodeUrl?: string;
  opencodePort?: number;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
    return;
  }

  const repos = await loadRepoConfigs(options.repos.length > 0 ? options.repos : [process.cwd()]);

  if (options.command === "validate") {
    consoleLogger.info("Configuration is valid", { repos: repos.map((repo) => repo.repoRoot) });
    return;
  }

  if (options.command === "cleanup") {
    for (const repo of repos) {
      const removed = await cleanupMergedWorktrees(repo.repoRoot);
      consoleLogger.info("Cleanup complete", { repo: repo.repoRoot, removed });
    }
    return;
  }

  const linearApiKey = resolveLinearApiKey(options, repos);
  const linearEndpoint = options.linearEndpoint ?? repos.find((repo) => repo.twinpod.linear?.endpoint)?.twinpod.linear?.endpoint;
  const pageSize = repos.find((repo) => repo.twinpod.linear?.page_size)?.twinpod.linear?.page_size;
  const controller = new AbortController();
  for (const signalName of ["SIGINT", "SIGTERM"] as const) {
    process.on(signalName, () => controller.abort(new Error(`${signalName} received`)));
  }

  const openCode = new SdkOpenCodeRunner({
    baseUrl: options.opencodeUrl ?? process.env.OPENCODE_SERVER_URL,
    port: options.opencodePort,
    signal: controller.signal,
  });

  try {
    const linear = new LinearClient({ apiKey: linearApiKey, endpoint: linearEndpoint, pageSize });
    if (options.command === "tui") {
      await runTui({ repos, linear, openCode, once: options.once, signal: controller.signal, abort: (reason) => controller.abort(reason) });
    } else {
      await new Orchestrator({
        repos,
        linear,
        openCode,
        logger: consoleLogger,
        once: options.once,
        signal: controller.signal,
      }).start();
    }
  } finally {
    await openCode.close();
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { command: "serve", repos: [], once: false };
  const first = args[0];
  if (first === "serve" || first === "tui" || first === "cleanup" || first === "validate" || first === "help") args.shift();
  if (first === "serve" || first === "tui" || first === "cleanup" || first === "validate" || first === "help") options.command = first;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--repo") options.repos.push(requireValue(args, ++index, arg));
    else if (arg.startsWith("--repo=")) options.repos.push(arg.slice("--repo=".length));
    else if (arg === "--once") options.once = true;
    else if (arg === "--linear-api-key") options.linearApiKey = requireValue(args, ++index, arg);
    else if (arg.startsWith("--linear-api-key=")) options.linearApiKey = arg.slice("--linear-api-key=".length);
    else if (arg === "--linear-endpoint") options.linearEndpoint = requireValue(args, ++index, arg);
    else if (arg.startsWith("--linear-endpoint=")) options.linearEndpoint = arg.slice("--linear-endpoint=".length);
    else if (arg === "--opencode-url") options.opencodeUrl = requireValue(args, ++index, arg);
    else if (arg.startsWith("--opencode-url=")) options.opencodeUrl = arg.slice("--opencode-url=".length);
    else if (arg === "--opencode-port") options.opencodePort = Number(requireValue(args, ++index, arg));
    else if (arg.startsWith("--opencode-port=")) options.opencodePort = Number(arg.slice("--opencode-port=".length));
    else if (arg === "--help" || arg === "-h") options.command = "help";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function resolveLinearApiKey(options: CliOptions, repos: RepoRuntimeConfig[]): string {
  if (options.linearApiKey) return options.linearApiKey;
  const configWithInlineKey = repos.find((repo) => repo.twinpod.linear?.api_key);
  if (configWithInlineKey?.twinpod.linear?.api_key) return configWithInlineKey.twinpod.linear.api_key;
  const envName = repos.find((repo) => repo.twinpod.linear?.api_key_env)?.twinpod.linear?.api_key_env ?? "LINEAR_API_KEY";
  const value = process.env[envName];
  if (!value) throw new Error(`Missing Linear API key. Set ${envName}, add linear.api_key_env/api_key to twinpod.yaml, or pass --linear-api-key.`);
  return value;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Twinpod

Usage:
  twinpod serve [--repo PATH ...] [--once] [--linear-api-key KEY] [--opencode-url URL]
  twinpod tui [--repo PATH ...] [--once] [--linear-api-key KEY] [--opencode-url URL]
  twinpod validate [--repo PATH ...]
  twinpod cleanup [--repo PATH ...]

Environment:
  LINEAR_API_KEY          Linear API key, unless twinpod.yaml uses linear.api_key_env or linear.api_key
  OPENCODE_SERVER_URL     Existing opencode server URL. If omitted, Twinpod starts one through @opencode-ai/sdk.
`);
}

main().catch((error) => {
  consoleLogger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
