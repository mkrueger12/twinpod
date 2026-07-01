# Twinpod

Twinpod is a long-lived OpenCode orchestration process that polls Linear, claims qualifying issues, runs deterministic class-specific workflows in per-issue git worktrees, and only moves issues to review after a green PR exists.

## Run

```bash
npm install
npm run build
LINEAR_API_KEY=lin_api_xxx npm run dev -- serve --repo .
```

Useful commands:

```bash
npm run dev -- validate --repo .
npm run dev -- serve --repo . --once
npm run dev -- serve --repo . --max-agents 3
npm run dev -- tui --repo .
npm run dev -- cleanup --repo .
```

`twinpod.yaml` is repo-local. Edit its Linear project/status names to match the managed repo. You can provide the Linear key with `LINEAR_API_KEY`, `linear.api_key_env`, `linear.api_key`, or `--linear-api-key`.

Twinpod runs up to 3 issue agents at a time by default. Set `max_parallel_agents` in `twinpod.yaml`, or pass `--max-agents`, to override the cap. Extra qualifying issues are queued locally and start when an active run completes.

If `OPENCODE_SERVER_URL` is set, Twinpod attaches to that server. Otherwise it starts an OpenCode server through `@opencode-ai/sdk` when needed.

`twinpod tui` runs the same orchestrator with an OpenTUI dashboard showing active Linear issue, stage, phase, recent activity, and any reported OpenCode cost. OpenTUI's native renderer requires a Node runtime with experimental FFI support; use Node 26.3+ with the appropriate FFI flag for the dashboard. The regular `serve`, `validate`, and `cleanup` commands do not require that runtime.

## Verification

```bash
npm run check
```

The included smoke pattern uses a fake Linear endpoint and `--once` to prove startup and polling without touching production Linear.
