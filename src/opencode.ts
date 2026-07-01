import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { TwinpodError, errorMessage } from "./errors.js";
import { buildStagePrompt, renderPrompt } from "./prompt.js";
import { buildOpenCodeEnvironment } from "./config.js";
import { Issue, Logger, OpenCodeConfig, RuntimeEvent, ServiceConfig } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { isInsideDirectory, nowIso, sleep } from "./util.js";

export interface OpenCodeServerState {
  url: string;
  pid: string | null;
  managed: boolean;
  healthy: boolean;
}

export interface OpenCodeMessageResult {
  sessionId: string | null;
  messageId: string | null;
  summary: string;
  usage?: Record<string, unknown>;
}

export class OpenCodeServerManager {
  private process: ChildProcess | null = null;
  private state: OpenCodeServerState | null = null;
  private restarting = false;

  constructor(private readonly config: OpenCodeConfig, private readonly logger: Logger) {}

  getState(): OpenCodeServerState | null {
    return this.state;
  }

  async ensureStartedAndHealthy(): Promise<OpenCodeServerState> {
    if (this.state?.healthy && (await this.checkHealth(this.state.url))) return this.state;

    const configuredUrl = this.config.server.url;
    if (configuredUrl) {
      if (!(await this.checkHealth(configuredUrl))) throw new TwinpodError("server_health_failed", `OpenCode server is not healthy: ${configuredUrl}`);
      this.state = { url: configuredUrl, pid: null, managed: false, healthy: true };
      return this.state;
    }

    const port = this.config.server.port === 0 ? await chooseFreePort(this.config.server.hostname) : (this.config.server.port ?? 4096);
    const url = `http://${this.config.server.hostname}:${port}`;
    if (this.config.server.reuseExisting && (await this.checkHealth(url))) {
      this.state = { url, pid: null, managed: false, healthy: true };
      return this.state;
    }

    await this.startManagedServer(port, url);
    return this.state!;
  }

  async ensureHealthy(): Promise<OpenCodeServerState> {
    const state = await this.ensureStartedAndHealthy();
    if (!(await this.checkHealth(state.url))) {
      state.healthy = false;
      throw new TwinpodError("server_health_failed", `OpenCode server health check failed: ${state.url}`);
    }
    return state;
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    this.process.kill("SIGTERM");
    this.process = null;
    if (this.state) this.state.healthy = false;
  }

  authHeader(): string | null {
    const passwordEnv = this.config.server.passwordEnv;
    if (!passwordEnv) return null;
    const password = process.env[passwordEnv];
    if (!password) return null;
    const usernameEnv = this.config.server.usernameEnv;
    const username = usernameEnv ? process.env[usernameEnv] || "opencode" : "opencode";
    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  private async startManagedServer(port: number, url: string): Promise<void> {
    const env = buildOpenCodeEnvironment(this.config);
    const args = ["serve", "--hostname", this.config.server.hostname, "--port", String(port)];
    this.logger.info("opencode server starting", { url });
    this.process = spawn(this.config.command, args, {
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process.stdout?.on("data", (chunk) => this.logger.debug("opencode stdout", { message: String(chunk).trim() }));
    this.process.stderr?.on("data", (chunk) => this.logger.warn("opencode stderr", { message: String(chunk).trim() }));
    this.process.once("exit", (code, signal) => {
      this.logger.warn("opencode server exited", { code, signal });
      if (this.state) this.state.healthy = false;
      if (this.config.server.restartOnExit) void this.restartManaged();
    });
    this.state = { url, pid: this.process.pid ? String(this.process.pid) : null, managed: true, healthy: false };

    const deadline = Date.now() + this.config.server.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.checkHealth(url)) {
        this.state.healthy = true;
        this.logger.info("opencode server ready", { url, pid: this.state.pid });
        return;
      }
      await sleep(250);
    }
    throw new TwinpodError("startup_timeout", `OpenCode server did not become ready within ${this.config.server.startupTimeoutMs}ms`);
  }

  private async restartManaged(): Promise<void> {
    if (this.restarting || !this.state?.managed) return;
    this.restarting = true;
    try {
      await sleep(this.config.server.restartBackoffMs);
      await this.startManagedServer(Number(new URL(this.state.url).port), this.state.url);
    } catch (error) {
      this.logger.error("opencode server restart failed", { error: errorMessage(error) });
    } finally {
      this.restarting = false;
    }
  }

  private async checkHealth(url: string): Promise<boolean> {
    const headers: Record<string, string> = {};
    const auth = this.authHeader();
    if (auth) headers.Authorization = auth;
    for (const endpoint of ["/health", "/status", "/openapi.json", "/doc", "/"]) {
      try {
        const response = await fetch(new URL(endpoint, url), { headers, signal: AbortSignal.timeout(this.config.readTimeoutMs) });
        if (response.ok) return true;
        if (response.status === 401 || response.status === 403) throw new TwinpodError("server_auth_failed", "OpenCode server authentication failed");
      } catch (error) {
        if (error instanceof TwinpodError) throw error;
      }
    }
    return false;
  }
}

export class OpenCodeClient {
  constructor(private readonly manager: OpenCodeServerManager, private readonly config: OpenCodeConfig) {}

  async createSession(workspacePath: string, title: string): Promise<string> {
    const server = await this.manager.ensureHealthy();
    const body = { cwd: workspacePath, path: workspacePath, workspace: workspacePath, title };
    const response = await this.postAny(server.url, ["/session", "/sessions"], body, this.config.readTimeoutMs);
    const id = extractString(response, ["id", "sessionId", "session_id", "session.id"]);
    if (!id) throw new TwinpodError("response_error", "OpenCode session response did not include a session ID");
    return id;
  }

  async runMessage(input: {
    sessionId: string;
    workspacePath: string;
    prompt: string;
    agent: string;
    model: string | null;
    permissionProfileName: string;
    permissionProfile: unknown;
    stage: string;
    signal: AbortSignal;
    onEvent: (event: RuntimeEvent) => void;
  }): Promise<OpenCodeMessageResult> {
    const server = await this.manager.ensureHealthy();
    const body = {
      session_id: input.sessionId,
      sessionId: input.sessionId,
      cwd: input.workspacePath,
      path: input.workspacePath,
      workspace: input.workspacePath,
      message: input.prompt,
      prompt: input.prompt,
      agent: input.agent,
      model: input.model ?? undefined,
      permission: input.permissionProfile,
      permission_profile: input.permissionProfileName,
    };
    input.onEvent(runtimeEvent("message_started", server, { stage: input.stage, agent: input.agent, permission_profile: input.permissionProfileName }));
    const response = await this.postAny(
      server.url,
      [`/session/${encodeURIComponent(input.sessionId)}/message`, `/session/${encodeURIComponent(input.sessionId)}/messages`, "/message", "/messages"],
      body,
      this.config.turnTimeoutMs,
      input.signal,
    );
    const messageId = extractString(response, ["messageId", "message_id", "id", "message.id"]);
    const usage = extractUsage(response);
    input.onEvent(runtimeEvent("message_completed", server, { stage: input.stage, agent: input.agent, permission_profile: input.permissionProfileName, message_id: messageId, usage }));
    return {
      sessionId: input.sessionId,
      messageId,
      summary: summarizeResponse(response),
      usage,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const server = await this.manager.ensureHealthy();
    await this.postAny(server.url, [`/session/${encodeURIComponent(sessionId)}/abort`, `/session/${encodeURIComponent(sessionId)}/cancel`, "/cancel"], { session_id: sessionId }, this.config.readTimeoutMs).catch(() => undefined);
  }

  private async postAny(baseUrl: string, paths: string[], body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const auth = this.manager.authHeader();
    if (auth) headers.Authorization = auth;
    let lastError: unknown;
    for (const endpoint of paths) {
      try {
        const response = await fetch(new URL(endpoint, baseUrl), {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 404 || response.status === 405) continue;
        if (!response.ok) throw new TwinpodError("response_error", `OpenCode server returned HTTP ${response.status}`);
        const text = await response.text();
        return text ? JSON.parse(text) : {};
      } catch (error) {
        lastError = error;
        if (error instanceof TwinpodError) throw error;
      }
    }
    throw new TwinpodError("server_unavailable", "No compatible OpenCode server endpoint responded", lastError);
  }
}

export class OpenCodeAgentRunner {
  private sessionsByIssue = new Map<string, string>();

  constructor(
    private readonly serviceConfig: ServiceConfig,
    private readonly workflowPromptTemplate: () => string,
    private readonly workspaceManager: WorkspaceManager,
    private readonly serverManager: OpenCodeServerManager,
    private readonly client: OpenCodeClient,
    private readonly logger: Logger,
  ) {}

  async runAttempt(issue: Issue, attempt: number | null, signal: AbortSignal, onEvent: (event: RuntimeEvent) => void): Promise<void> {
    const server = await this.serverManager.ensureHealthy();
    onEvent(runtimeEvent("server_ready", server));
    const workspace = await this.workspaceManager.createForIssue(issue.identifier);
    if (!isInsideDirectory(workspace.path, this.serviceConfig.workspace.root)) {
      throw new TwinpodError("invalid_workspace_cwd", "Workspace path escaped workspace root");
    }
    await writeGeneratedConfigIfEnabled(this.serviceConfig, workspace.path, this.logger);
    await this.workspaceManager.beforeRun(workspace.path);

    try {
      const basePrompt = await renderPrompt(this.workflowPromptTemplate(), issue, attempt);
      let sessionId = this.sessionsByIssue.get(issue.id);
      if (!sessionId) {
        sessionId = await this.client.createSession(workspace.path, `${issue.identifier}: ${issue.title}`);
        this.sessionsByIssue.set(issue.id, sessionId);
        onEvent(runtimeEvent("session_started", server, { opencode_session_id: sessionId }));
      }

      const stageResults: Record<string, string> = {};
      for (let cycle = 1; cycle <= this.serviceConfig.opencode.maxPipelineCycles; cycle += 1) {
        for (const stage of this.serviceConfig.opencode.pipeline) {
          const profile = this.serviceConfig.opencode.permissionProfiles[stage.permissionProfile];
          onEvent(runtimeEvent("stage_started", server, { opencode_session_id: sessionId, stage: stage.name, agent: stage.agent, permission_profile: stage.permissionProfile }));
          try {
            const result = await this.client.runMessage({
              sessionId,
              workspacePath: workspace.path,
              prompt: buildStagePrompt({ basePrompt, stageName: stage.name, stagePrompt: stage.prompt, cycle, stageResults }),
              agent: stage.agent,
              model: stage.model ?? this.serviceConfig.opencode.model,
              permissionProfileName: stage.permissionProfile,
              permissionProfile: profile,
              stage: stage.name,
              signal,
              onEvent,
            });
            stageResults[stage.name] = result.summary;
            onEvent(runtimeEvent("stage_completed", server, { opencode_session_id: sessionId, message_id: result.messageId, stage: stage.name, agent: stage.agent, permission_profile: stage.permissionProfile, usage: result.usage }));
          } catch (error) {
            onEvent(runtimeEvent("stage_failed", server, { opencode_session_id: sessionId, stage: stage.name, agent: stage.agent, permission_profile: stage.permissionProfile, message: errorMessage(error) }));
            if (stage.required && stage.onFailure !== "continue") throw new TwinpodError("stage_failed", `Stage failed: ${stage.name}`, error);
          }
        }
        break;
      }
    } finally {
      await this.workspaceManager.afterRun(workspace.path).catch((error) => this.logger.warn("after_run hook ignored", { issue_id: issue.id, issue_identifier: issue.identifier, error: errorMessage(error) }));
    }
  }

  async cancel(issueId: string): Promise<void> {
    const sessionId = this.sessionsByIssue.get(issueId);
    if (sessionId) await this.client.cancel(sessionId);
  }
}

async function writeGeneratedConfigIfEnabled(config: ServiceConfig, workspacePath: string, logger: Logger): Promise<void> {
  if (!config.opencode.configHygiene.writeGeneratedConfig) return;
  const dir = path.join(workspacePath, ".twinpod");
  await fs.mkdir(dir, { recursive: true });
  const generated = {
    permission: config.opencode.permissionProfiles[config.opencode.permissionProfile],
    watcher: { ignore: config.opencode.configHygiene.watcherIgnore },
    formatter: config.opencode.quality.formatter,
    lsp: config.opencode.quality.lsp,
    disabled_providers: config.opencode.configHygiene.disabledProviders,
    instructions: config.opencode.configHygiene.instructions,
    mcp: config.opencode.configHygiene.mcp,
    plugins: config.opencode.configHygiene.plugins,
    compaction: config.opencode.configHygiene.compaction,
  };
  await fs.writeFile(path.join(dir, "opencode.generated.json"), `${JSON.stringify(generated, null, 2)}\n`, "utf8");
  logger.debug("generated opencode config written", { path: path.join(dir, "opencode.generated.json") });
}

function runtimeEvent(event: string, server: OpenCodeServerState, fields: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return { event, timestamp: nowIso(), opencode_server_pid: server.pid, opencode_server_url: server.url, ...fields };
}

function extractString(value: any, keys: string[]): string | null {
  for (const key of keys) {
    const found = key.split(".").reduce<any>((current, part) => (current && typeof current === "object" ? current[part] : undefined), value);
    if (typeof found === "string" && found) return found;
  }
  return null;
}

function extractUsage(value: any): Record<string, unknown> | undefined {
  const usage = value?.usage ?? value?.tokens ?? value?.message?.usage;
  return usage && typeof usage === "object" ? usage : undefined;
}

function summarizeResponse(value: any): string {
  const text = value?.summary ?? value?.text ?? value?.message?.text ?? value?.message ?? value?.status;
  if (typeof text === "string") return text.slice(0, 4000);
  return JSON.stringify(value).slice(0, 4000);
}

function chooseFreePort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, hostname, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new TwinpodError("startup_timeout", "Failed to allocate a free port"));
      });
    });
    server.on("error", reject);
  });
}
