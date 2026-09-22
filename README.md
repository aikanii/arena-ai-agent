<!--
  ◆ Arena Agent — README
  Format conventions: GitHub-flavored Markdown, shields.io badges,
  alert callouts (> [!NOTE]), collapsible <details> for long references.
-->

<div align="center">

# ◆ Arena Agent

**An AI coding agent for your terminal — powered by Arena Agent.**

Claude Code–style agentic coding that runs directly in the **VS Code integrated terminal** — or any terminal you already live in.

[![Node](https://img.shields.io/badge/node-%3E%3D18-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](package.json)
[![Terminal](https://img.shields.io/badge/interface-ANSI%20terminal-222222?logo=windowsterminal&logoColor=white)](#the-interactive-repl)
[![License](https://img.shields.io/badge/license-MIT-d4aa00)](LICENSE)

**[Quick Start](#quick-start)** · **[Features](#highlights)** · **[CLI Reference](#cli-reference)** · **[Architecture](#architecture)** · **[Contributing](#contributing)**

</div>

---

## Highlights

Arena Agent pairs the **Arena Agent API** (the intelligence) with a hardened terminal runtime (the hands): an orchestration loop that *explores → plans → implements → verifies → iterates* until the task is genuinely done.

| Capability | How it works |
| :--- | :--- |
| **Understands codebases** | Auto-generated repo map, git-aware regex search, offset reads for large files |
| **Edits like a developer** | Exact-match replacements with unique-match safety · live rendered diffs · atomic writes |
| **Runs your toolchain** | Tests, builds, linters, installs — with timeouts and capped output capture |
| **Plans multi-step work** | A visible todo list the model maintains as it goes |
| **Debugs iteratively** | Reads compiler/runtime errors from real command output, fixes, re-runs |
| **Keeps you in control** | Four permission modes · per-command allow-rules · <kbd>Esc</kbd> interrupts any turn |
| **Remembers everything** | Per-project resumable sessions · `ARENA.md` project memory |
| **Sandboxed to the project** | Every file tool resolves inside the working directory; escapes are rejected |
| **Signs in — no keys to paste** | `arena login` connects your Arena AI account via OAuth device flow |
| **Works offline** | Bundled mock model exercises the full agent loop with zero network |

<div align="center">

```text
$ arena "add authentication to this application"

● update_plan(update plan)
  ⎿  Plan: 3 items
● search_files(/session|auth/ in src)
  ⎿  4 matches in 3 files
● edit_file(src/routes.js)
   - app.get('/dashboard', renderDashboard);
   + app.get('/dashboard', requireAuth, renderDashboard);
   +1 −1
● run_command($ npm test)
  ⎿  ✓ exit 0 · 14 passing (212ms)

Done. Added session auth in src/auth.js and gated /dashboard; all tests pass.
```

</div>

---

## Table of Contents

- [Highlights](#highlights)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Authentication](#authentication)
- [Usage](#usage)
- [CLI Reference](#cli-reference)
- [The Interactive REPL](#the-interactive-repl)
- [Agent Tools](#agent-tools)
- [Permission Model](#permission-model)
- [Project Memory](#project-memory)
- [Sessions](#sessions)
- [Configuration](#configuration)
- [VS Code Integration](#vs-code-integration)
- [Architecture](#architecture)
- [Development](#development)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [License](#license)

---

## Quick Start

**Three commands from zero to agentic coding:**

```bash
# 1 — Connect your Arena AI account (opens a browser; type the code shown)
arena login

# 2 — Start an interactive session in any project
cd your-project
arena

# 3 — …or hand the agent a task directly
arena "add authentication to this application"
```

Fully scripted, one-shot mode:

```bash
arena -p "fix the failing tests" --auto-edit
```

> [!TIP]
> **No account yet?** The bundled offline mock demonstrates the complete agent loop with no network:
>
> ```bash
> arena --mock "add authentication to this application"
> ```

---

## Installation

### Requirements

| Dependency | Version | Notes |
| :--- | :--- | :--- |
| [Node.js](https://nodejs.org) | **≥ 18** | uses built-in `fetch` — check with `node -v` |
| Git | any recent | optional — enables git context and the `git` tool |
| Terminal | any | VS Code integrated terminal recommended |

Arena Agent has **zero npm runtime dependencies** — the entire CLI is plain Node.js standard library, so there is no supply-chain surface and it installs anywhere Node runs.

### Install globally (from source)

```bash
git clone <repo-url> arena-agent
cd arena-agent
npm link            # puts the `arena` command on your PATH
arena --version
```

### Run without installing

```bash
node /path/to/arena-agent/bin/arena.js
```

### Verify your environment

```bash
arena doctor
# ✓ node version · workspace · credentials · API reachability · git
```

---

## Authentication

Arena Agent uses the **OAuth 2.0 Device Authorization Grant** ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)) — the same flow GitHub CLI uses. No API keys to copy for humans.

```text
$ arena login

◆ Sign in to Arena AI  · connecting to https://api.arena.ai/v1

  1. Open:  https://api.arena.ai/activate
  2. Code:   ARENA-7Q4M (copied to clipboard)

opening your browser…
waiting for you to approve in the browser… (Ctrl+C to cancel)
╭─ Signed in to Arena AI ─────────────────────────────
│ ✓ account:  kai — kai@example.com  (pro)
│   token:    saved to ~/.arena-agent/auth.json
╰─────────────────────────────────────────────────────
```

> [!NOTE]
> **Why device flow?** Approval happens in *any* browser on *any* device, so sign-in works even where a browser can't reach the terminal — **SSH sessions, containers, and remote VS Code workspaces**. The CLI never sees your password.

### Endpoints

The CLI talks to a single host. Everything is derived from the API base URL — override just `ARENA_BASE_URL` and the rest follows.

| Purpose | URL |
| :--- | :--- |
| **API base URL** (chat completions, models) | `https://api.arena.ai/v1` |
| Device code — `POST /oauth/device/code` | `https://api.arena.ai/oauth/device/code` |
| Token exchange / polling — `POST /oauth/token` | `https://api.arena.ai/oauth/token` |
| Activation page (opened in your browser) | `https://api.arena.ai/activate` |
| Account info — `GET /me` | `https://api.arena.ai/me` |

| Command | Description |
| :--- | :--- |
| `arena login` | Sign in (`--no-browser` skips auto-opening the browser) |
| `arena whoami` | Show the connected account (refreshed live from the API) |
| `arena logout` | Remove saved credentials |

**Token storage.** The account token is written to `~/.arena-agent/auth.json` with file mode **`600`** and is picked up automatically by every subsequent run. Tokens are bound to the endpoint they were issued against — a token from one endpoint is never sent to another.

### Automation & CI

API keys remain fully supported and **take precedence** over the signed-in account:

```bash
export ARENA_API_KEY="your-key"          # or: --api-key <key>
export ARENA_BASE_URL="https://…"        # any OpenAI-compatible endpoint
```

**Credential precedence:** `--api-key` → `ARENA_API_KEY` → signed-in account → `apiKey` in project/global config files.

---

## Usage

The agent always treats **the current working directory as the project workspace**. Every filesystem tool is sandboxed to it.

### Interactive

```bash
arena                        # start a session
arena "task description"     # start a session seeded with an initial task
arena -c                     # continue the most recent session
arena --resume <id>          # resume a specific session (see `arena sessions`)
```

### One-shot (scripts & CI)

```bash
arena -p "fix the failing tests"                 # run, print result, exit
arena -p "explain src/auth.js" --plan            # read-only analysis
git diff | arena -p "review this diff"           # pipes work too
```

### Permission presets

```bash
arena --plan "how would you migrate this app to TypeScript?"
arena --auto-edit "refactor the payment module"     # edits auto-approved
arena --full-auto "get the test suite green"        # everything auto-approved
```

<details>
<summary><b>CLI Reference — full commands, options, and environment variables</b></summary>

### Commands

| Command | Description |
| :--- | :--- |
| `arena` | Start the interactive REPL |
| `arena login` · `logout` · `whoami` | Manage the connected Arena AI account |
| `arena init` | Create an `ARENA.md` project-memory file seeded from the project |
| `arena doctor` | Diagnose configuration, credentials and API reachability |
| `arena sessions` | List saved sessions for this project |

### Options

| Flag | Description |
| :--- | :--- |
| `-p`, `--print` | Non-interactive one-shot mode |
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume <id>` | Resume a specific session (`latest` works too) |
| `--plan` | Plan mode: read-only investigation + implementation plan |
| `--auto-edit` | Auto-approve file writes/edits; commands still prompt |
| `--full-auto` | Auto-approve everything (alias: `--dangerously-skip-permissions`) |
| `--mode <m>` | Permission mode: `plan` \| `default` \| `acceptEdits` \| `fullAuto` |
| `--model <name>` | Model to use (default `arena-agent`) |
| `--base-url <url>` | API base URL (default `https://api.arena.ai/v1`) |
| `--api-key <key>` | Use an API key instead of the signed-in account |
| `--mock` | Use the bundled offline mock model (no network) |
| `--max-turns <n>` | Tool-step limit per user turn (default `40`) |
| `--temperature <t>` | Sampling temperature (default `0.2`) |
| `--verbose` | Show full tool results and raw output |
| `--no-browser` | *(login)* don't auto-open the browser |
| `-v`, `--version` | Print version |
| `-h`, `--help` | Show help |

### Environment variables

| Variable | Purpose |
| :--- | :--- |
| `ARENA_API_KEY` | API key (CI / automation) |
| `ARENA_BASE_URL` | API endpoint override |
| `ARENA_MODEL` | Default model |
| `ARENA_PERMISSION_MODE` | Default permission mode |
| `ARENA_MAX_TURNS` | Default tool-step limit |
| `ARENA_SHELL` | Shell for `run_command` (default `/bin/bash`, fallback `/bin/sh`) |

</details>

---

## The Interactive REPL

### Input

| Input | Meaning |
| :--- | :--- |
| `text` | Talk to the agent |
| `text \` | Trailing backslash continues on the next line |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Input history |
| paste | Multi-line paste handled natively (bracketed paste) |
| <kbd>Esc</kbd> or <kbd>Ctrl</kbd>+<kbd>C</kbd> | Interrupt the running turn |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> *(empty prompt)* | Quit |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Quit (EOF) |
| `!command` | Run a shell command directly — output joins the conversation |
| `#note` | Append a note to `ARENA.md` project memory |

### Slash commands

| Command | Description |
| :--- | :--- |
| `/help` | List commands |
| `/clear` | Clear conversation context |
| `/compact` | Compress history into a handoff summary now |
| `/status` | Session, account, model, mode, token usage |
| `/model [name]` | Show or switch model |
| `/mode [name]` | Show or switch permission mode |
| `/plan` | Toggle plan mode |
| `/diff` | Show the uncommitted git diff |
| `/permissions` | Show mode + session allow-rules |
| `/init` | Create `ARENA.md` |
| `/sessions` | List saved sessions |
| `/exit` | Quit |

---

## Agent Tools

Nine built-in tools, orchestrated by Arena Agent in a loop of **explore → plan → implement → verify → iterate → summarize**:

| Tool | Purpose | Approval |
| :--- | :--- | :--- |
| `list_files` | Repo tree with depth/entry caps; respects `.gitignore` | none |
| `read_file` | File contents with `line_offset`/`line_limit`; binary-safe guards | none |
| `search_files` | Regex content search, `file:line: text` results, `include` filter | none |
| `write_file` | Create/overwrite files; parent dirs auto-created; diff rendered | per mode |
| `edit_file` | Exact-match replacement; unique match required unless `replace_all` | per mode |
| `delete_file` | Delete files/directories — only on explicit request | always asks¹ |
| `run_command` | Shell execution — 120 s default timeout (max 10 min), 30 KB output caps | per mode |
| `git` | `status` · `diff` · `log` · `show` · `branch` · `add` · `commit` | reads free; writes per mode |
| `update_plan` | Visible multi-step todo list, rendered live | none |

¹ *except in `--full-auto`*

> [!IMPORTANT]
> All file paths resolve against the workspace root. Absolute paths outside it and `..` escapes are **rejected**, not followed.

---

## Permission Model

| Mode | Reads & search | File writes/edits | Shell & git writes |
| :--- | :---: | :---: | :---: |
| `plan` | ✓ | ✗ | ✗ |
| `default` | ✓ | **ask** | **ask** |
| `acceptEdits` (`--auto-edit`) | ✓ | ✓ auto | **ask** |
| `fullAuto` (`--full-auto`) | ✓ | ✓ auto | ✓ auto |

When approval is needed, you get an inline prompt:

```text
╭─ Permission needed ─────────────────────────────────╮
│ Arena Agent wants to run a command:                 │
│ $ npm test                                          │
╰▸ (y)es  (n)o  (a)lways allow "npm *"
```

| Key | Effect |
| :---: | :--- |
| `y` | Approve once |
| `n` | Deny — the agent is told and adapts its approach |
| `a` | Always allow that command prefix for this session (`/permissions` lists active rules) |

> [!TIP]
> Non-interactive runs (`-p`, pipes) **never block**: anything not covered by the chosen mode is denied and the agent is informed — safe by construction in CI.

> [!WARNING]
> `--full-auto` does exactly what it says. Use it in disposable environments (containers, CI, scratch checkouts) — not on machines you care about.

---

## Project Memory

`ARENA.md` is injected into the agent's context at the start of **every** session. Use it for build/test commands, conventions, architecture decisions, and gotchas.

```bash
arena init          # create one, seeded from the project
```

- In the REPL, `# <note>` appends a line to it on the fly
- `~/.arena-agent/ARENA.md` applies to **all** of your projects

---

## Sessions

Every conversation is persisted per-project and survives crashes — saves happen after each step:

```text
~/.arena-agent/projects/<project-slug>/sessions/<id>.json
```

| Command | Description |
| :--- | :--- |
| `arena sessions` | List sessions, newest first, with the first user message |
| `arena --continue` | Pick up the most recent session |
| `arena --resume <id>` | Resume a specific session |

Sessions store messages, the current plan, model/mode, and token usage. Long conversations are **auto-compacted** into a structured handoff summary before hitting the model's context window — or on demand via `/compact`.

---

## Configuration

**Precedence:** CLI flags → environment → signed-in account → project `.arena/settings.json` → `~/.arena-agent/config.json` → defaults.

### Global — `~/.arena-agent/config.json`

```jsonc
{
  "baseUrl": "https://api.arena.ai/v1",
  "model": "arena-agent",
  "permissionMode": "default",   // plan | default | acceptEdits | fullAuto
  "maxTurns": 40,
  "temperature": 0.2
}
```

### Per-project — `<project>/.arena/settings.json`

```jsonc
{ "model": "arena-agent-fast", "permissionMode": "acceptEdits" }
```

### Models

| Model | Context | Notes |
| :--- | :--- | :--- |
| `arena-agent` | 200k | flagship — default |
| `arena-agent-fast` | 200k | lower latency |
| `arena-agent-mini` | 128k | lightweight tasks |

Any custom name or OpenAI-compatible model works via `--model` / `ARENA_MODEL`.

---

## VS Code Integration

Arena Agent needs **no extension** — run it in the integrated terminal (<code>Ctrl</code>+<code>`</code>); it detects VS Code automatically. For a one-keystroke setup, register it as a task:

```jsonc
// .vscode/tasks.json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Arena Agent",
      "type": "shell",
      "command": "arena",
      "args": ["${input:arenaTask}"],
      "presentation": { "reveal": "always", "focus": true, "panel": "dedicated" },
      "problemMatcher": []
    }
  ],
  "inputs": [
    { "id": "arenaTask", "type": "promptString", "description": "What should Arena Agent do?" }
  ]
}
```

…and bind it:

```jsonc
// keybindings.json
{ "key": "ctrl+alt+a", "command": "workbench.action.tasks.runTask", "args": "Arena Agent" }
```

> [!TIP]
> Review changes in VS Code's **Source Control** view before accepting them — or ask the agent to run `/diff` in-session. Full guide: [`docs/vscode.md`](docs/vscode.md).

---

## Architecture

```text
                          ┌──────────────────────────────────────────┐
   you (REPL / -p)        │               arena CLI                  │
 ────────────────────►    │                                          │
                          │  cli.js ── arg parsing, REPL, subcommands│
                          │     │                                    │
                          │     ▼                                    │
                          │  agent.js ── orchestration loop          │
                          │     │        stream → tool → verify …    │
                          │     │                                    │
               ┌──────────┼─────┼──────────────┬────────────────┐   │
               ▼          ▼     ▼              ▼                ▼   │
           llm.js     tools/  permissions.js  context.js   session.js
         (streaming   read/write/edit/       (modes +     (repo map, (persist &
          SSE client,  delete/list/search/    allow-rules) git facts,  resume)
          retries)     bash/git/plan                       ARENA.md)  │
               │                                                      │
               ▼                                                      │
       Arena Agent API                                                │
    (OpenAI-compatible)   ui/ ── renderer, spinner, raw-mode terminal
                          utils/ ── line diff, ignore matcher, exec capture
                          mock/ ── offline mock of the full API (incl. OAuth)
```

<details>
<summary><b>Source layout</b></summary>

```text
bin/arena.js        entrypoint (shebang)
src/cli.js          arg parsing, REPL, slash commands, subcommands
src/agent.js        orchestration loop: stream → tools → verify → repeat
src/auth.js         arena login — OAuth device flow + secure token store
src/llm.js          Arena Agent API client (SSE streaming, retries, fallbacks)
src/prompts.js      system prompt & compaction prompt construction
src/permissions.js  approval modes + session allow-rules
src/config.js       flags/env/account/config-file resolution
src/context.js      repo map, git facts, ARENA.md loading
src/session.js      per-project session persistence
src/tools/          read · write · edit · delete · list · search · bash · git · plan
src/ui/             ANSI renderer, spinner, raw-mode terminal input, prompts
src/utils/          line diff, gitignore matcher, fs guards, exec capture
mock/server.js      offline mock of the Arena Agent API (incl. OAuth)
test/smoke.js       zero-dependency smoke + e2e tests
```

</details>

### Design principles

1. **Zero dependencies.** SSE parsing, diffs, gitignore matching, and the terminal driver are all built on the Node standard library — no supply-chain surface, installs anywhere Node 18+ runs.
2. **Open protocol.** The client speaks OpenAI-compatible chat completions with tool calls, so any compatible endpoint — or the bundled mock — can power the agent.
3. **Safety by default.** Path sandboxing, unique-match edits, permission gates, output/time caps on shell execution, atomic writes, mode-`600` credential storage.

---

## Development

```bash
npm test                  # 11 smoke tests incl. a full e2e run vs the mock model
npm run demo              # scripted end-to-end demo in a temp project
node mock/server.js 8420  # run the mock Arena API standalone
arena --mock login        # exercise the full login flow offline
```

The **mock server** implements `/v1/chat/completions` (streaming + non-streaming), the OAuth device-flow endpoints, `/me`, and `/v1/models`. It scripts a small "brain" that plans, creates files, verifies with a shell command, and summarizes — so the entire runtime is testable with zero network access.

---

## Contributing

Contributions are welcome. Ground rules:

1. **Keep it dependency-free.** If you find yourself reaching for npm, you're probably solving it wrong here.
2. **Tests are required** for behavior changes — add a case to `test/smoke.js` and keep `npm test` green.
3. **Match the style** — CommonJS, `'use strict'`, small modules, comments for *why*.
4. **Safety is a feature** — anything that widens file/command access needs explicit review.

```bash
# suggested workflow
npm test && npm run demo
```

---

## Troubleshooting

<details>
<summary><b>Common issues</b></summary>

| Symptom | Fix |
| :--- | :--- |
| `Connect your Arena AI account` box | Run `arena login` — or set `ARENA_API_KEY`, or use `--mock`. |
| Login can't open a browser | `arena login --no-browser`, then open the printed URL manually — on any device. |
| `Could not reach …/oauth/device/code` | Check network/proxy; for custom endpoints verify `ARENA_BASE_URL`. |
| Commands denied in `-p` mode | One-shot runs can't prompt — pass `--auto-edit` or `--full-auto`. |
| Edits fail with `old_string not found` | The agent re-reads and retries automatically; in custom integrations, ensure exact whitespace. |
| Garbled colors | Set `NO_COLOR=1` to disable ANSI output. |
| Anything else | `arena doctor` — checks Node version, credentials, endpoint reachability, and git. |

</details>

---

## Security

> [!IMPORTANT]
> - Tokens live in `~/.arena-agent/auth.json` with file mode **`600`** and are sent only to the endpoint they were issued for.
> - File tools cannot escape the workspace; deletions always require approval outside `--full-auto`.
> - `--full-auto` is intended for disposable environments (containers, CI).
> - The agent is instructed never to print or commit secrets — still, keep `.env` files in `.gitignore` (they're excluded from the repo map by default).

---

## License

[MIT](LICENSE) © Arena Agent contributors.

---

<div align="center">

**Built for developers who live in the terminal.**

`npm link` · `arena login` · `arena` — and start shipping.

</div>
