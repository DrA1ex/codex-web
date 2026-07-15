# codex-web

A local browser UI for working with Codex sessions and prompt queues.

`codex-web` starts `codex app-server` on your machine and opens a local web interface where you can send and queue prompts, monitor usage limits, approve requests, interrupt active work, and return to existing sessions.

<img width="720" alt="codex-web interface" src="https://github.com/user-attachments/assets/5ef1b364-be92-4ad8-96f6-3618d98813c1" />

## Features

- Queue multiple prompts for a Codex session.
- Send an urgent prompt ahead of the queue.
- Interrupt or steer active work.
- Review command, file, and permission approvals in the browser.
- Monitor rate limits and automatically continue when capacity returns.
- Resume existing Codex sessions or create a new one.
- Persist active queues and completed history per project and session.
- Keep the web server local and protected by a generated access token.

## Requirements

- Node.js 18 or newer
- npm
- Codex CLI installed and authenticated
- macOS, Linux, or another environment supported by the Codex CLI

The application itself uses only Node.js built-ins at runtime. npm is used to create the global `codex-web` command.

## Install

Clone the repository and create a global npm link:

```bash
git clone https://github.com/DrA1ex/codex-web.git
cd codex-web
npm link
```

The `codex-web` command is now available from any directory:

```bash
codex-web --help
```

`npm link` points the global command at this checkout. After pulling newer code, the command uses the updated files without copying them elsewhere.

To remove the global command:

```bash
npm unlink --global codex-web
```

## Quick Start

Open a terminal in the project Codex should work on, then run:

```bash
codex-web
```

The command prints a local URL and opens it in the default browser. Use `--no-open` when the browser should not open automatically.

Start for a different project directory:

```bash
codex-web --project-dir /path/to/project
```

Resume a known Codex session:

```bash
codex-web SESSION_ID
```

When no session ID is supplied, the browser can show recent sessions or create a new one.

## Common Usage

Use a fixed local port:

```bash
codex-web --port 8092
```

Start without opening a browser:

```bash
codex-web --no-open
```

Override the model and reasoning effort:

```bash
codex-web --model gpt-5.5 --effort high
```

Start in a read-only sandbox:

```bash
codex-web --sandbox read-only
```

Allow workspace changes while keeping approvals manual:

```bash
codex-web \
  --sandbox workspace-write \
  --approval-policy on-request \
  --approval-response manual
```

Show sessions outside the current project:

```bash
codex-web --all-sessions
```

## Command-Line Options

```text
codex-web [session_id] [options]

--host <address>          Address for the local web server, default 127.0.0.1
--port <number>           Local web server port, default is a random free port
--no-open                 Print the URL without opening a browser
--state-dir <dir>         Queue, settings, history, and session state directory
--codex-bin <path>        Codex executable, default codex
--project-dir <dir>       Project directory Codex should work in
--all-sessions            Include sessions outside the selected project
--session-picker-limit N  Maximum recent sessions shown in the picker
--watch-interval N        Usage-limit polling interval in seconds
--countdown N             Countdown before an automatically queued prompt starts
--model <model-id>        Model override
--effort <effort-id>      Reasoning-effort override
--sandbox <mode>          read-only, workspace-write, or danger-full-access
--approval-policy <mode>  on-request, never, untrusted, or on-failure
--approval-response <x>   manual, accept, accept-for-session, decline, or cancel
--network true|false      Override network permission
--add-dir <dir>           Add another writable directory
--log-jsonrpc             Save Codex JSON-RPC traffic to the application log
--debug                   Enable additional diagnostic output
```

Run `codex-web --help` to see the options supported by the installed checkout.

## Security

- The server listens on `127.0.0.1` by default and is not exposed to the network.
- Browser access is protected by a generated token included in the local URL.
- Approval requests are manual by default.
- Explicit CLI values for model, effort, sandbox, and approval policy take precedence over saved settings.
- `danger-full-access` and automatic approvals should be enabled only when their consequences are understood.

## Data Storage

By default, application data is stored under:

```text
~/.local/state/codex-web
```

The directory contains active queues, append-only completed history, per-session state, saved interface settings, and optional logs. Queues are separated by project and Codex session.

To use another location:

```bash
codex-web --state-dir /path/to/codex-web-state
```

## Updating

Because `npm link` points to the cloned repository, updating normally requires only:

```bash
cd /path/to/codex-web
git pull
```

Run `npm link` again only if the global link was removed, the package location changed, or npm itself was reinstalled with a different global prefix.

## Troubleshooting

### `codex-web: command not found`

Check that npm's global binary directory is on `PATH`:

```bash
npm prefix --global
npm bin --global 2>/dev/null || true
```

Then run `npm link` again from the repository root. On installations where `npm bin --global` is unavailable, the executable is normally under the `bin` directory associated with `npm prefix --global`.

### Codex does not start

Verify that the Codex CLI is installed and authenticated:

```bash
codex --version
```

Use `--codex-bin /absolute/path/to/codex` when the executable is not discoverable through `PATH`.

### The browser should not open automatically

```bash
codex-web --no-open
```

### A fixed port is already in use

Omit `--port` to select a free port automatically, or choose another port:

```bash
codex-web --port 8093
```

## Development

Contributor setup, project structure, the mock app-server, Playwright E2E tests, test parallelism, and validation commands are documented in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
