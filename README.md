# Twinpod

Twinpod is an OpenCode-backed issue orchestration daemon. It reads `WORKFLOW.md`, polls Linear for eligible issues, creates per-issue workspaces, and runs each issue through a long-lived `opencode serve` runtime.

## Usage

```bash
npm install
npm run build
twinpod ./WORKFLOW.md
```

Development:

```bash
npm run dev -- ./WORKFLOW.md --port 0
npm test
```

The implementation is intentionally trust-boundary explicit: workspace paths are contained under `workspace.root`, hooks are trusted workflow configuration, secrets are resolved from explicit `$VAR` references and not logged, and OpenCode permissions are expressed through generated profile fragments passed to the server when supported.
