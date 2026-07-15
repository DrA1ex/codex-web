# codex-web

A small local web UI for queueing prompts into a Codex session.

`codex-web` runs on your machine, starts `codex app-server`, and opens a browser UI where you can queue prompts, watch rate limits, approve requests, interrupt running work, and manage queued tasks.


<img width="720" alt="web-ui" src="https://github.com/user-attachments/assets/5ef1b364-be92-4ad8-96f6-3618d98813c1" />


## Requirements

- Node.js 18 or newer
- Codex CLI installed and authenticated
- macOS, Linux, or another Unix-like shell for the symlink examples below

No npm packages are required. The app uses only Node.js built-ins.

## Quick Start

Clone the repo:

```bash
git clone https://github.com/DrA1ex/codex-web
cd codex-web
```

Run it directly:

```bash
./codex-web
```

The script prints a local URL and opens the browser unless `--no-open` is used.

## Install as `codex-web`

### Option 1: symlink into `~/.local/bin`

```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/codex-web" ~/.local/bin/codex-web
```

Make sure `~/.local/bin` is on your `PATH`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Restart your shell, then run:

```bash
codex-web
```

### Option 2: symlink into `/usr/local/bin`

```bash
ln -sf "$(pwd)/codex-web" /usr/local/bin/codex-web
```

Restart your shell, then run:

```bash
codex-web
```

## Common Usage

Start in the current directory:

```bash
codex-web
```

Start for a specific project:

```bash
codex-web --project-dir /path/to/project
```

Do not open the browser automatically:

```bash
codex-web --no-open
```

Use a fixed port:

```bash
codex-web --port 8092
```

Start with a model override:

```bash
codex-web --model gpt-5.4
```

Resume a known Codex session:

```bash
codex-web SESSION_ID
```

## Useful Options

```text
--project-dir <dir>       Project directory Codex should work in
--port <number>           Local web server port, default is random
--no-open                 Print the URL without opening a browser
--model <model>           Model override, for example gpt-5.5
--sandbox <mode>          read-only, workspace-write, or danger-full-access
--approval-policy <mode>  on-request, never, untrusted, or on-failure
--approval-response <x>   manual, accept, accept-for-session, decline, cancel
--state-dir <dir>         Where queues, settings, and session state are stored
```

## Where Data Is Stored

By default, state is stored under:

```text
~/.local/state/codex-web
```

This includes active prompts in `queue.json`, completed prompt history in append-only `completed.jsonl`, per-session state, theme settings, and logs. Browser local storage is not used for app settings.

## Notes

- The UI is token-protected and listens on `127.0.0.1` by default.
- Approval requests are handled manually in the browser by default. Automatic approval requires an explicit `--approval-response` option.
- Queued prompts are persisted per project/session pair.
- Theme selection is saved in the app state directory and works across ports.


## Development

Validate backend and frontend syntax, including the browser ES modules:

```bash
npm run check
```

Run the Node.js unit and protocol tests:

```bash
npm test
```

Run browser E2E tests against the bundled mock `codex app-server`:

```bash
npm run e2e
```

Run syntax checks, unit tests, and Playwright E2E tests:

```bash
npm run validate
```

The E2E runner discovers the number of tests in each spec and splits large specs into isolated browser batches. Every test receives a fresh mock app-server, codex-web process, project directory, state directory, and navigation; the Chromium process and page are reused only within one bounded batch. Each batch has a watchdog, process-tree cleanup, and a short cooldown before the next Chromium launch.

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium` to use a system browser when the Playwright-managed browser is unavailable. CI hosts can tune `E2E_MAX_TESTS_PER_PROCESS`, `E2E_FILE_TIMEOUT_MS`, and `E2E_BATCH_COOLDOWN_MS` when Chromium startup or teardown is unusually slow.

## Reliability Notes

- Explicit CLI values for model, effort, sandbox, and approval policy take precedence over saved settings.
- Turn events are correlated to the selected thread and active turn before they can change queue state.
- Output updates use sequenced incremental SSE patches; clients resynchronize from `/api/state` if a sequence gap is detected.
- Slow SSE clients are bounded and disconnected instead of allowing an unbounded server-side buffer.
