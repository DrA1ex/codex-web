# Development

This page contains contributor and test-harness documentation for `codex-web`. User installation and usage are documented in the main [README](../README.md).

## Setup

Clone the repository and install development dependencies:

```bash
git clone https://github.com/DrA1ex/codex-web.git
cd codex-web
npm install
```

The application has no third-party runtime dependencies. Playwright is installed only for development and E2E testing.

## Project Layout

```text
codex-web                 CLI entrypoint
src/                      backend, CLI, queue, persistence, and RPC modules
www/                      browser UI and ES modules
test/                     Node.js unit and protocol tests
e2e/                      Playwright scenarios and mock app-server
scripts/check-syntax.js   backend and browser-module syntax validation
scripts/run-e2e.js        isolated parallel E2E batch runner
playwright.config.js      Playwright configuration
```

See `AGENT.MD` for repository-specific implementation rules.

## Validation Commands

Check backend and frontend syntax, including browser ES modules:

```bash
npm run check
```

Run Node.js unit and protocol tests:

```bash
npm test
```

Run browser E2E tests against the bundled mock `codex app-server`:

```bash
npm run e2e
```

Run all checks and tests:

```bash
npm run validate
```

## Mock app-server

The E2E suite starts `e2e/mock-app-server.js` instead of a real authenticated Codex process. The mock communicates over line-delimited JSON-RPC on stdio and models the protocol behavior needed by the UI tests, including:

- `initialize` / `initialized` startup;
- session listing, reading, and creation;
- turn and output-item lifecycle events;
- interruption and steering;
- command, file, and permission approvals;
- token usage and rate-limit updates;
- context compaction;
- delayed, duplicated, malformed, foreign, and out-of-order events;
- controlled RPC failures and process exits.

The mock is intentionally strict around request correlation and lifecycle ordering so that E2E tests expose application races rather than silently accepting them.

## E2E Isolation and Parallelism

The E2E runner discovers tests in each spec and splits large files into bounded browser batches. By default, two independent batches run concurrently:

```bash
npm run e2e
```

Each scenario receives its own:

- mock app-server process;
- `codex-web` process;
- HTTP port;
- project directory;
- state directory;
- navigation and application state.

A browser process and page may be reused only inside one bounded batch. Concurrent batches write to separate `test-results/e2e-batches/batch-*` directories and have independent watchdog and process-tree cleanup.

Run serially for investigation:

```bash
E2E_PARALLEL_PROCESSES=1 npm run e2e
```

Increase process parallelism on a machine with enough CPU and memory:

```bash
E2E_PARALLEL_PROCESSES=4 npm run e2e
```

The runner caps the value at available CPU parallelism.

Use a system Chromium executable when the Playwright-managed browser is unavailable:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium npm run e2e
```

Additional CI tuning variables:

```text
E2E_MAX_TESTS_PER_PROCESS  Maximum tests placed in one browser batch
E2E_FILE_TIMEOUT_MS        Watchdog timeout for a batch
E2E_BATCH_COOLDOWN_MS      Delay before starting another browser batch
```

## Failure Artifacts

Each failed E2E batch keeps its Playwright output under `test-results/e2e-batches/`. Depending on the failure, the fixture also records application stdout, stderr, mock JSON-RPC traffic, and Playwright error context.

When debugging a failure, first rerun the smallest affected spec or test in serial mode before changing global timeouts.

## Reliability Invariants

The test suite should preserve these invariants:

- thread and turn events cannot change state unless their IDs match the active operation;
- a settled coordinator is not interruptible or steerable;
- app-server exit rejects active RPC and turn waiters without killing the HTTP UI;
- fatal RPC state cannot be overwritten by normal prompt cleanup;
- persistence mutations either complete durably or roll back in memory;
- completed prompts live in append-only JSONL history rather than the active queue file;
- output patches are sequenced and clients resynchronize after a gap;
- slow SSE clients cannot create an unbounded server-side buffer;
- every E2E scenario releases its app, mock, browser, and temporary directories.

## Global Development Link

A contributor can expose the current checkout as the global `codex-web` command with:

```bash
npm link
```

The package declares `codex-web` in its `bin` field, so npm creates and manages the executable link. Remove it with:

```bash
npm unlink --global codex-web
```
