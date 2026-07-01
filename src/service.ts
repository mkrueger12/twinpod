import fs from "node:fs";
import { buildServiceConfig } from "./config.js";
import { LinearClient } from "./linear.js";
import { consoleLogger } from "./logger.js";
import { OpenCodeAgentRunner, OpenCodeClient, OpenCodeServerManager } from "./opencode.js";
import { Orchestrator } from "./orchestrator.js";
import { loadWorkflow } from "./workflow.js";
import { TwinpodHttpServer } from "./http.js";
import { Logger, ServiceConfig, WorkflowDefinition } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { errorMessage } from "./errors.js";

export class TwinpodService {
  private workflow!: WorkflowDefinition;
  private config!: ServiceConfig;
  private serverManager!: OpenCodeServerManager;
  private orchestrator!: Orchestrator;
  private httpServer: TwinpodHttpServer | null = null;
  private watcher: fs.FSWatcher | null = null;

  constructor(private readonly workflowPath: string, private readonly cliPort: number | null = null, private readonly logger: Logger = consoleLogger) {}

  async start(): Promise<void> {
    await this.installRuntime(await this.buildRuntime());
    await this.serverManager.ensureStartedAndHealthy();
    await this.orchestrator.start();
    this.watchWorkflow();
    const port = this.cliPort ?? this.config.httpServer.port;
    if (port !== null) {
      this.httpServer = new TwinpodHttpServer(this.orchestrator, this.logger);
      await this.httpServer.start(port, this.config.httpServer.hostname);
    }
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    await this.httpServer?.stop();
    await this.orchestrator?.stop();
    await this.serverManager?.stop();
  }

  private async buildRuntime(): Promise<{
    workflow: WorkflowDefinition;
    config: ServiceConfig;
    serverManager: OpenCodeServerManager;
    workspaceManager: WorkspaceManager;
    runner: OpenCodeAgentRunner;
    tracker: LinearClient;
  }> {
    const workflow = await loadWorkflow(this.workflowPath);
    const config = buildServiceConfig(workflow);
    const shouldReuseServer = this.serverManager && this.config && serverKey(this.config) === serverKey(config);
    const serverManager = shouldReuseServer ? this.serverManager : new OpenCodeServerManager(config.opencode, this.logger);
    const workspaceManager = new WorkspaceManager(config.workspace.root, config.hooks, this.logger);
    const opencodeClient = new OpenCodeClient(serverManager, config.opencode);
    const runner = new OpenCodeAgentRunner(config, () => this.workflow.prompt_template, workspaceManager, serverManager, opencodeClient, this.logger);
    const tracker = new LinearClient(config.tracker);
    return { workflow, config, serverManager, workspaceManager, runner, tracker };
  }

  private async installRuntime(runtime: Awaited<ReturnType<TwinpodService["buildRuntime"]>>): Promise<void> {
    const oldServerManager = this.serverManager;
    const replacingServer = oldServerManager && oldServerManager !== runtime.serverManager;
    this.workflow = runtime.workflow;
    this.config = runtime.config;
    this.serverManager = runtime.serverManager;
    if (this.orchestrator) this.orchestrator.updateDependencies({ config: this.config, tracker: runtime.tracker, runner: runtime.runner, workspaceManager: runtime.workspaceManager });
    else this.orchestrator = new Orchestrator(this.config, runtime.tracker, runtime.runner, runtime.workspaceManager, this.logger);
    if (replacingServer) await oldServerManager.stop();
  }

  private watchWorkflow(): void {
    this.watcher?.close();
    this.watcher = fs.watch(this.workflowPath, { persistent: false }, () => {
      void this.reloadWorkflow();
    });
  }

  private async reloadWorkflow(): Promise<void> {
    try {
      const runtime = await this.buildRuntime();
      await runtime.serverManager.ensureStartedAndHealthy();
      await this.installRuntime(runtime);
    } catch (error) {
      this.logger.error("workflow reload failed; keeping last known good config", { error: errorMessage(error) });
    }
  }
}

function serverKey(config: ServiceConfig): string {
  return JSON.stringify({
    command: config.opencode.command,
    server: config.opencode.server,
    configPath: config.opencode.configPath,
    configDir: config.opencode.configDir,
    configContent: config.opencode.configContent,
  });
}
