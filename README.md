# codex-web

A small local web UI for queueing prompts into a Codex session.

`codex-web` runs on your machine, starts `codex app-server`, and opens a browser UI where you can queue prompts, watch rate limits, approve requests, interrupt running work, and manage queued tasks.


<img width="720" alt="web-ui" src="https://github.com/user-attachments/assets/5ef1b364-be92-4ad8-96f6-3618d98813c1" />


## Requirements

- Node.js 18 or newer
- Codex CLI installed and authenticated
- macOS, Linux, or another Unix-like shell for the symlink examples below

No npm packages are required at runtime. The application uses only Node.js built-ins; development and browser testing use Playwright as a dev dependency.

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

Install development dependencies and the Playwright Chromium build:

```bash
npm ci
npx playwright install chromium
```

Validate backend and frontend syntax, including browser ES modules:

```bash
npm run check
```

Run the Node.js unit and protocol regression suite:

```bash
npm test
```

Run the browser E2E suite:

```bash
npm run e2e
```

Run all checks, unit tests, and E2E tests:

```bash
npm run validate
```

Use an already installed Chromium build when Playwright browser downloads are unavailable:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium npm run e2e
```

### Mock app-server

The E2E suite launches `e2e/mock-app-server.js` in place of the Codex CLI. The mock follows the public Codex app-server protocol documented at <https://developers.openai.com/codex/app-server/>:

- newline-delimited JSON messages over stdio without a required `jsonrpc` field;
- `initialize` request followed by the `initialized` notification;
- thread, turn, and item lifecycle notifications;
- command and file approval server requests;
- rate-limit reads and reset-credit consumption;
- compaction completion through the `contextCompaction` item lifecycle.

The mock is strict enough to reject requests before initialization, unknown methods, invalid threads, overlapping active turns, and mismatched interrupts or steering requests. Scenario prompts cover early completion, foreign and duplicate events, Unicode, long delta streams, failures, interruption, approvals, process exit, and force-steer replacement turns.

Each Playwright test gets an isolated state directory, project directory, mock control file, RPC transcript, app process tree, and browser server. Failed tests attach the application output and JSONL RPC transcript.

## Reliability Notes

- Explicit CLI values for model, effort, sandbox, and approval policy take precedence over saved settings.
- Turn events are correlated to the selected thread and active turn before they can change queue state.
- Output updates use sequenced incremental SSE patches; clients resynchronize from `/api/state` if a sequence gap is detected.
- Slow SSE clients are bounded and disconnected instead of allowing an unbounded server-side buffer.
