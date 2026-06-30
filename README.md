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
npm run dev -- cleanup --repo .
```

`twinpod.yaml` is repo-local. Edit its Linear project/status names to match the managed repo. You can provide the Linear key with `LINEAR_API_KEY`, `linear.api_key_env`, `linear.api_key`, or `--linear-api-key`.

If `OPENCODE_SERVER_URL` is set, Twinpod attaches to that server. Otherwise it starts an OpenCode server through `@opencode-ai/sdk` when needed.

## Verification

```bash
npm run check
```

The included smoke pattern uses a fake Linear endpoint and `--once` to prove startup and polling without touching production Linear.
