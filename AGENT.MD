# Codex Queue Agent Notes

## Project

`codex-web` is a dependency-free Node.js web UI for queueing prompts into a Codex app-server session.

- `codex-web`: executable Node script; starts the local UI server, runs `codex app-server`, talks JSON-RPC, stores per-session queues.
- `www/index.html`: static UI shell.
- `www/app.js`: state rendering, UI actions, local API calls, SSE updates.
- `www/styles.css`: viewport-bounded layout and panel styling.

## Codex App-Server

Official docs: https://developers.openai.com/codex/app-server

Main methods used here:

- `thread/list`, `thread/resume`, `thread/start`, `thread/read`
- `turn/start`, `turn/interrupt`
- `account/rateLimits/read`

Approval-policy values must stay as CLI-style strings: `on-request`, `on-failure`, `untrusted`, `granular`, `never`. Do not convert them to camelCase; current app-server rejects values like `onRequest`.

Sandbox modes are mapped before sending: `read-only` -> `readOnly`, `workspace-write` -> `workspaceWrite`, `danger-full-access` -> `dangerFullAccess`.

## Runtime Flow

Startup initializes the local HTTP server, starts `codex app-server`, resumes a passed session or enters session selection, polls rate limits, then streams state to the UI over SSE.

Session routes:

- `/api/session/select`: resume existing session.
- `/api/session/create`: create a session with `thread/start`.

Queue routes:

- `/api/queue/add`: enqueue prompt text.
- Pending items are sent with `turn/start`.
- Approval requests are surfaced in the UI and answered through `/api/approval/respond`.

## Development

Validation:

```bash
node --check codex-web
node --check www/app.js
```

Run locally:

```bash
./codex-web --no-open --port 8092
```

Restart the server after editing `codex-web`; it is not hot-reloaded.

## Guidance

Keep changes small and dependency-free unless a feature clearly needs otherwise. Use `rg` for search and verify app-server payload changes against the official docs or live runtime errors.
