import http from "node:http";
import { Orchestrator } from "./orchestrator.js";
import { Logger } from "./types.js";

export class TwinpodHttpServer {
  private server: http.Server | null = null;

  constructor(private readonly orchestrator: Orchestrator, private readonly logger: Logger) {}

  async start(port: number, hostname = "127.0.0.1"): Promise<number> {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server!.listen(port, hostname, resolve));
    const address = this.server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    this.logger.info("http server started", { hostname, port: actualPort });
    return actualPort;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((error) => (error ? reject(error) : resolve())));
    this.server = null;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      const state = this.orchestrator.snapshot() as any;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Twinpod</title><h1>Twinpod</h1><p>Running: ${state.counts.running}</p><p>Retrying: ${state.counts.retrying}</p><pre>${escapeHtml(JSON.stringify(state, null, 2))}</pre>`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/state") {
      json(response, 200, this.orchestrator.snapshot());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/refresh") {
      json(response, 202, this.orchestrator.requestRefresh());
      return;
    }
    const issueMatch = url.pathname.match(/^\/api\/v1\/([^/]+)$/);
    if (request.method === "GET" && issueMatch) {
      const snapshot = this.orchestrator.issueSnapshot(decodeURIComponent(issueMatch[1]));
      if (!snapshot) json(response, 404, { error: { code: "issue_not_found", message: "Issue is unknown to current runtime state" } });
      else json(response, 200, snapshot);
      return;
    }
    if (["/api/v1/state", "/api/v1/refresh"].includes(url.pathname) || issueMatch) {
      json(response, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      return;
    }
    json(response, 404, { error: { code: "not_found", message: "Not found" } });
  }
}

function json(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
}
