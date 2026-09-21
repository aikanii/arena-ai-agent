# Arena Agent in VS Code

Arena Agent is designed to run in the **VS Code integrated terminal**. It detects
`TERM_PROGRAM=vscode`, keeps all paths relative to the workspace you launched it
from, and needs no extension.

## Option 1 — just run it

1. Open the integrated terminal (`Ctrl+`` ` ``).
2. `cd` to your project (or use *Terminal → New Terminal*, which already starts in the workspace root).
3. Run:

   ```bash
   arena
   ```

## Option 2 — one-keystroke task

Add this to `.vscode/tasks.json` to get a prompt for the task and a dedicated
terminal panel:

```jsonc
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Arena Agent",
      "type": "shell",
      "command": "arena",
      "args": ["${input:arenaTask}"],
      "presentation": {
        "echo": true,
        "reveal": "always",
        "focus": true,
        "panel": "dedicated",
        "showReuseMessage": false,
        "clear": true
      },
      "problemMatcher": []
    },
    {
      "label": "Arena Agent (full auto)",
      "type": "shell",
      "command": "arena",
      "args": ["--full-auto", "${input:arenaTask}"],
      "presentation": { "reveal": "always", "focus": true, "panel": "dedicated" },
      "problemMatcher": []
    }
  ],
  "inputs": [
    {
      "id": "arenaTask",
      "type": "promptString",
      "description": "What should Arena Agent do?",
      "default": "add authentication to this application"
    }
  ]
}
```

Run it with **Terminal → Run Task… → Arena Agent**, or bind a key:

```jsonc
// keybindings.json
{
  "key": "ctrl+alt+a",
  "command": "workbench.action.tasks.runTask",
  "args": "Arena Agent"
}
```

## Tips

- **Workspace = cwd.** Launch `arena` from the folder you want it to treat as the
  project root; all file tools are sandboxed there.
- **Keep the tab alive.** The agent works iteratively; interrupt any turn with
  `esc`, redirect it with your next message.
- **Approve once, run often.** At a permission prompt choose `a` to always allow
  a command prefix (e.g. `npm *`) for the session.
- **Review before committing.** Ask `arena` to run `/diff` (or just use VS Code's
  Source Control view) before accepting changes.
- **Project memory.** `arena init` creates `ARENA.md` — put your build/test
  commands and conventions there so every session starts informed.
