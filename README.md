# codex-web

A small local web UI for queueing prompts into a Codex session.

`codex-web` runs on your machine, starts `codex app-server`, and opens a browser UI where you can queue prompts, watch rate limits, approve requests, interrupt running work, and manage queued tasks.

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
./codex-limit-watch-web
```

The script prints a local URL and opens the browser unless `--no-open` is used.

## Install as `codex-web`

The executable in this repo is named `codex-limit-watch-web`, but the recommended user command is shorter: `codex-web`.

### Option 1: symlink into `~/.local/bin`

```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/codex-limit-watch-web" ~/.local/bin/codex-web
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
ln -sf "$(pwd)/codex-limit-watch-web" /usr/local/bin/codex-web
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
~/.local/state/codex-limit-watch-web
```

This includes queued prompts, per-session state, theme settings, and logs. Browser local storage is not used for app settings.

## Notes

- The UI is token-protected and listens on `127.0.0.1` by default.
- Approval requests can be handled in the browser UI.
- Queued prompts are persisted per project/session pair.
- Theme selection is saved in the app state directory and works across ports.
