# Codex Queue Agent Notes

## Project Shape

`codex-web` is a dependency-free Node.js web UI for queueing prompts into a Codex app-server session.

- `codex-web`: executable entrypoint.
- `src/cli/index.js`: CLI args and startup options.
- `src/app/index.js`: main `CodexLimitWatchApp` state container; composes modules from `src/app/modules/*`.
- `src/app/prompt-sender.js`: prompt sending, countdown, queued command execution, model/effort payloads.
- `src/app/queue-processing.js`: auto-pump loop.
- `src/queue/index.js`: queue item normalization, counts, reorder/update helpers, command parsing.
- `src/http/api-routes.js`: local JSON API routes.
- `www/index.html`: static UI shell.
- `www/src/*`: modular frontend; no `www/app.js`.
- `www/styles.css`: main responsive layout and theme styling.

The app is CommonJS and intentionally has no runtime dependencies.

## App-Server API Facts

The app starts `codex app-server` and talks JSON-RPC through `src/codex/json-rpc-client.js`.

Methods currently used:

- Sessions: `thread/list`, `thread/resume`, `thread/start`, `thread/read`, `thread/loaded/list`
- Prompt turns: `turn/start`, `turn/interrupt`
- Queued commands: `thread/compact/start`, completion via `thread/compacted`
- Account/model data: `account/rateLimits/read`, `account/rateLimitResetCredit/consume`, `model/list`

Important verified protocol details:

- `turn/start` input shape is `input: [{ type: 'text', text }]`.
- `turn/steer` exists and accepts `{ threadId, expectedTurnId, input }`. It can fail with `activeTurnNotSteerable`.
- `thread/compact/start` takes `{ threadId }` and completes with `thread/compacted`.
- Approval policy values are mapped in `src/codex/policies.js`; do not send raw CLI values blindly.
- Sandbox policy values are mapped before sending.

## Queue And Output Behavior

Queue items are persisted per project/session pair. `loadQueue` recovers interrupted `sending`/`sent` items as `unknown` so work is not silently lost.

Queue statuses include:

- Active/pending-like: `pending`, `next`, `sending`, `sent`
- Finished: `completed`, `cancelled`, `failed`, `unknown`

Commands:

- Immediate standalone commands are parsed by `parseExactCommand`.
- Queued commands are parsed by `parseQueuedCommand`.
- `/compact` is a queued command, not immediate; it runs in queue order and waits for `thread/compacted`.

Prompt sending:

- `sendComposerNow` immediately sends only when the queue is idle, processing is enabled, and limits are available.
- When the queue is paused, composer input is queued rather than sent immediately.
- Manual send of an item while a prompt is running moves it to `next`; it should not resume a paused queue.
- Countdown ticks append only output lines and should not redraw the whole queue.

Output:

- Prompt output is grouped by queue item in `outputGroups`.
- Completed groups auto-collapse to `Prompt + summary`.
- Summaries come from `turn/summary/delta` or final `agentMessage`; fallback summary is generated from tools/diffs/status.
- Tool output blocks are update-in-place by item id and can be collapsed/expanded.
- Diff blocks are update-in-place, expandable by clicking the header, and show file caption plus `+count / -count`.

Usage:

- Token usage is attached from `thread/tokenUsage/updated` only when the turn id matches the active/completed queue item.
- Per-item usage also tracks account-level limit deltas before/after execution, with a delayed refresh to handle server-side lag.

## UI Notes

The frontend uses static ES modules under `www/src`.

- `www/src/core/renderer.js`: keyed partial rendering for header, queue, output, approval, sessions.
- `www/src/features/output/index.js`: output lines, grouped prompt rendering, diff/tool toggles, visible output copy.
- `www/src/features/queue/render.js`: queue item cards, status labels, usage badges.
- `www/src/ui/header.js`: topbar, session picker, limits panel, mobile collapse state.

Important UI behavior already implemented:

- Limits panel has responsive/collapsed mobile states.
- Mobile queue/output panels have collapse controls and overflow-aware menus.
- Queue drag supports long-touch mobile drag.
- Output group collapse icons use chevrons, not text glyphs.
- Queue completion popups should only show after actual queue execution, not on page reload.
- Server shutdown shows a centered modal telling the user to start a new codex-web instance.

## Persistence And Safety

Queue data is the most important local data.

- Queue persistence uses session/project-specific paths.
- Writes are designed to be safer than plain overwrite and keep backups.
- Startup can restore from backup when the queue file is missing/corrupt.
- A per project/session lock prevents multiple codex-web instances from writing the same queue state.

Always check `git status --short` before editing. This repo may have user changes in progress; do not revert unrelated edits.

## Current Known Work / Next Feature

Next planned feature: active prompt steering.

Proposed behavior:

- `/think <text>` sends a native `turn/steer` to the active turn with `expectedTurnId`.
- The steering note should appear inside the current output group as a user note.
- It must not create a queue item and must not mark the active queue item failed.
- `/think! <text>` is the force path: interrupt the active turn, mark the current item `cancelled` or `interrupted` rather than `failed`, then send/queue the correction according to current limits and queue state.
- If `turn/steer` fails with `activeTurnNotSteerable`, preserve the note in UI and offer force-send instead of silently dropping it.

There is an existing `/api/control/interrupt` route, but it currently pauses and relies on the normal failure path. The steering work needs a distinct interrupt reason so user-forced correction does not look like a prompt error.

## Development

Validation:

```bash
npm test
node --check codex-web
find src www/src -name '*.js' -print0 | xargs -0 -n1 node --check
```

Run locally:

```bash
./codex-web --no-open --port 8092
```

Restart the server after backend edits; it is not hot-reloaded.
