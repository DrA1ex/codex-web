# Codex Queue Agent Notes

## Project

This repository contains `codex-limit-watch-web`, a local Node.js web UI for queueing prompts into a Codex app-server session.

The browser assets live in `www/`:

- `www/index.html` defines the static UI shell.
- `www/app.js` renders state, handles UI actions, and calls the local HTTP API.
- `www/styles.css` owns the viewport-bounded layout and panel styling.

The executable `codex-limit-watch-web` is a dependency-free Node.js script. It starts a local HTTP server, starts `codex app-server`, talks to it over JSON-RPC, and exposes a token-protected browser UI.

## Codex App-Server API

Primary documentation:

- https://developers.openai.com/codex/app-server

Important methods used here:

- `thread/list`: list available Codex threads/sessions.
- `thread/resume`: resume an existing session.
- `thread/start`: create a new session.
- `thread/read`: refresh session metadata.
- `turn/start`: send a queued prompt into the active session.
- `turn/interrupt`: cancel an active turn.
- `account/rateLimits/read`: read current Codex rate-limit status.

Current app-server approval-policy values are CLI-style strings:

- `on-request`
- `on-failure`
- `untrusted`
- `granular`
- `never`

Do not convert these to camelCase. In particular, `onRequest` is rejected by current Codex app-server builds.

Sandbox mode values are currently mapped before being sent to app-server:

- `read-only` -> `readOnly`
- `workspace-write` -> `workspaceWrite`
- `danger-full-access` -> `dangerFullAccess`

## Runtime Flow

Startup:

1. Parse CLI options.
2. Start the local HTTP server.
3. Start and initialize `codex app-server`.
4. If a session ID is passed, resume it.
5. Otherwise enter `selecting-session` and load sessions.
6. Poll rate limits.
7. Serve the UI and stream state via SSE.

Session selection:

- Existing sessions are selected through `/api/session/select`.
- New sessions are created through `/api/session/create`, which calls `thread/start`.
- Queue state is stored per project/session pair under the configured state directory.

Queue processing:

1. UI sends prompt text to `/api/queue/add`.
2. Pending queue items are sent with `turn/start`.
3. App-server notifications update output and item status.
4. Approval requests are surfaced in the UI and answered through `/api/approval/respond`.

## Local Development

Syntax check:

```bash
node --check codex-limit-watch-web
node --check www/app.js
```

Run locally without opening a browser:

```bash
./codex-limit-watch-web --no-open --port 8092
```

If the local server is already running, restart it after editing `codex-limit-watch-web`; the Node script is not hot-reloaded.

## UI Notes

The layout is intended to fit inside the browser viewport while keeping minimum usable heights:

- `body` is a flex column with viewport height.
- Header, session picker, composer, and debug areas are fixed/flexible chrome.
- The main queue/output area flexes and scrolls internally.
- On narrow screens the page can scroll normally.

When changing UI text or controls, keep the app operational rather than landing-page-like. This is a utility UI for repeated queue management.

## Agent Guidance

Prefer small, direct changes. This app has no build system and no external runtime dependencies, so avoid introducing packages unless the feature clearly needs them.

Use `rg` for code search and `node --check` for fast validation. If changing app-server payloads, verify against the official Codex app-server documentation and current runtime errors.

Do not revert unrelated local changes. This workspace may not be a Git repository.
