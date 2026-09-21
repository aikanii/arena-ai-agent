# ◆ Arena Agent — terminal-based AI coding agent

**Arena Agent** is a Claude Code–style coding agent that lives in your terminal — built to run right inside the **VS Code integrated terminal** (or any terminal you like). The AI intelligence is provided by the **Arena Agent API**; the CLI provides agent orchestration, filesystem access, terminal execution, Git integration, permissions, conversation handling, and the developer interface.

```
$ arena
◆ Arena Agent v0.1.0
model arena-agent · mode default · cwd ~/dev/myapp
git main ●  a1b2c3d fix login redirect

❯ add authentication to this application
● update_plan(update plan)
● write_file(src/auth.js)
   + const crypto = require('crypto'); …
● run_command($ npm test)
⎿  ✓ exit 0 · 14 passing
Done. Added session-based auth in src/auth.js; all tests pass.
```

One-shot works too:

```
arena "add authentication to this application"   # interactive, seeded with the task
arena -p "fix the failing tests"                 # script mode: run, print, exit
```

Zero runtime dependencies — plain Node.js ≥ 18.

---

## Install

From a clone of this repo:

```bash
cd arena-agent
npm link          # installs the `arena` command globally
arena --version
```

Or run it directly without installing:

```bash
node /path/to/arena-agent/bin/arena.js
```

Verify your setup:

```bash
arena doctor
```

## Connect the intelligence

Arena Agent talks to an OpenAI-compatible chat-completions endpoint — by default the **Arena Agent API**:

```bash
export ARENA_API_KEY="your-key"
# optional overrides
export ARENA_BASE_URL="https://api.arena.ai/v1"
export ARENA_MODEL="arena-agent"
```

Any OpenAI-compatible server works (set `ARENA_BASE_URL`). No key yet? Try the fully offline bundled mock model:

```bash
arena --mock "add authentication to this application"
```

## Usage

```
arena                       interactive session in the current directory
arena "task"                interactive session seeded with a task
arena -p "task"             one-shot (non-interactive) mode
arena -c                    continue the most recent session
arena --resume <id>         resume a specific session (arena sessions)
arena init                  create ARENA.md project memory
arena doctor                check configuration
arena sessions              list saved sessions for this project
```

Key flags: `--plan`, `--auto-edit`, `--full-auto`, `--model <m>`, `--mode <m>`, `--verbose`, `--max-turns <n>`. Pipe input in: `git diff | arena -p "review this diff"`.

The agent always treats **the current working directory as the project workspace** — every file tool is sandboxed to it.

### In the REPL

| Input | Meaning |
| --- | --- |
| text | talk to the agent |
| `text \` | trailing backslash continues on the next line |
| `↑ / ↓` | input history |
| `/help` | list slash commands |
| `/compact` | compress conversation history |
| `/clear` | start fresh context |
| `/model`, `/mode`, `/plan` | switch model / permission mode |
| `/diff`, `/status`, `/permissions` | inspect state |
| `!cmd` | run a shell command directly |
| `#note` | append a note to `ARENA.md` (project memory) |
| `esc` or `ctrl-c` | interrupt the running turn |
| `/exit` | quit |

## What the agent can do

Nine built-in tools, driven by Arena Agent:

| Tool | Purpose |
| --- | --- |
| `list_files` | orient: repo tree (respects `.gitignore`) |
| `read_file` | read source, with offsets for big files |
| `search_files` | regex content search (`file:line: text` results) |
| `write_file` | create / overwrite files (diffs rendered live) |
| `edit_file` | exact-match string replacement with unique-match safety |
| `delete_file` | deletion, only when explicitly requested |
| `run_command` | shell: tests, builds, installs, debugging — with timeouts |
| `git` | status / diff / log / show / branch / add / commit |
| `update_plan` | visible multi-step todo list, rendered live |

The orchestration loop: explore → plan → implement → verify (run tests/builds, read errors) → iterate until done → summarize. Long conversations are auto-compacted before hitting the context window.

## Permissions

Safety modes (`--mode`, or the shortcut flags):

| Mode | File reads | Edits/writes | Shell & git writes |
| --- | --- | --- | --- |
| `plan` | ✓ | ✗ | ✗ (investigate + plan only) |
| `default` | ✓ | ask | ask |
| `acceptEdits` (`--auto-edit`) | ✓ | ✓ auto | ask |
| `fullAuto` (`--full-auto`) | ✓ | ✓ auto | ✓ auto |

At a prompt: `y` approve once · `n` deny · `a` always allow this command prefix for the session. Non-interactive (`-p`) runs deny anything not covered by the chosen mode.

## Project memory — ARENA.md

Run `arena init` to create an `ARENA.md` describing your project (commands, conventions, gotchas). It's injected into the agent's context every session. Add to it any time with `# <note>`. A `~/.arena-agent/ARENA.md` applies to all projects.

## Sessions

Every conversation is saved per-project under `~/.arena-agent/projects/<project>/sessions/`. Use `arena sessions`, `arena --continue`, `arena --resume <id>`.

## VS Code integration

Just run `arena` in the integrated terminal (it detects VS Code and shows tips). For a one-keystroke setup, add it as a task — see [`docs/vscode.md`](docs/vscode.md).

## Configuration

Precedence: CLI flags → environment → `.arena/settings.json` (project) → `~/.arena-agent/config.json` (global) → defaults.

```jsonc
// ~/.arena-agent/config.json
{
  "baseUrl": "https://api.arena.ai/v1",
  "apiKey": "…",            // env ARENA_API_KEY preferred
  "model": "arena-agent",
  "permissionMode": "default",
  "maxTurns": 40
}
```

Environment: `ARENA_API_KEY`, `ARENA_BASE_URL`, `ARENA_MODEL`, `ARENA_PERMISSION_MODE`, `ARENA_MAX_TURNS`, `ARENA_SHELL`.

## Development

```bash
npm test        # smoke tests incl. full e2e vs the mock model
npm run demo    # scripted end-to-end demo in a temp project
node mock/server.js 8420   # run the mock API standalone
```

```
bin/arena.js        entrypoint
src/cli.js          arg parsing, REPL, slash commands, subcommands
src/agent.js        orchestration loop: stream → tools → verify → repeat
src/llm.js          Arena Agent API client (streaming, retries, fallbacks)
src/prompts.js      system prompt & compaction prompt construction
src/permissions.js  approval modes + session allow-rules
src/context.js      repo map, git facts, ARENA.md loading
src/session.js      per-project session persistence
src/tools/          read/write/edit/delete/list/search/bash/git/plan
src/ui/             ANSI renderer, spinner, raw-mode input, prompts
mock/server.js      offline mock of the Arena Agent API
```

## License

MIT
