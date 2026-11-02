---
name: komux-script
description: Runs a small TypeScript program inside the user's komux that draws a live panel, dock row, tray chip or toasts, asks questions, and talks back to you, via the komux `script_run`/`script_send`/`script_wait`/`script_stop` MCP tools or the `komux script` CLI. Use for UI a single form can't give, such as a checklist or progress panel you update as you work, a multi-step wizard with computed steps, or a table the user picks rows from. For one round of questions use `komux-ask` instead.
---

# komux scripts

A script runs as a job in your tab, inside a sandbox that can only touch komux's screen. It has no `fetch`, files, processes, `import`, or Node/Bun APIs, so any data it shows must come from you: pass it as `input` when starting, or send it later.

## Running one

MCP, preferred inside komux:

1. `script_run` with `{ "source": "<ts>", "input": {...}, "name": "migrate", "show": true }`. Returns `{id, status, replies}`. Keep `name` to about 16 characters; it labels the job chip, dock row, toasts and popup.
2. `script_send` with `{ "id", "message" }` delivers to `komux.onMessage`.
3. `script_wait` with `{ "id", "timeout_seconds" }` returns replies you haven't read yet, waiting for one if there are none. Each reply is returned once.
4. `script_stop` ends it.

CLI equivalents, from a shell in a komux pane: `komux script run file.ts --input '{...}' --name NAME [--show] [--dock] [--wait]`, `komux script send ID JSON`, `komux script wait ID --timeout 50`, `komux script stop ID`, `komux script ls`. `komux script types` prints the full TypeScript declarations.

Status is `starting`, `running`, `exited` (with `value`), `error` (with `error`), `stopped`, or `lost` (its host died).

## What a script can use

```ts
const steps: string[] = input.steps;
let done = 0;

function render() {
  komux.render([
    { type: "progress", value: done, max: steps.length, label: "migration" },
    { type: "list", id: "steps", items: steps.map((s, i) => ({ value: String(i), text: s, mark: i < done ? "✓" : "·" })) },
    { type: "buttons", id: "act", options: ["Pause", "Stop"] },
  ]);
  komux.dock(`${done}/${steps.length} · ${steps[done] ?? "finished"}`);
}

komux.onMessage((m) => { done = m.done; render(); });
komux.onEvent((e) => { if (e.type === "select" && e.id === "act") komux.reply({ action: e.value, at: done }); });
render();
```

| Call | Effect |
|------|--------|
| `komux.render(elements)` | Replace the panel's content |
| `komux.show()` / `komux.hide()` | Pop the panel over the tab, or tuck it away; the user toggles it with Alt j |
| `komux.dock(text \| null)` | A row in the dock strip at the bottom of the tab |
| `komux.tray(text \| null)` | A chip beside the tray; clicking it opens the panel |
| `komux.toast(text)` | A five-second toast; at most one a second |
| `await komux.ask(form)` | A `komux-ask` form (no `image` or `slides`); resolves to `{status, values}` |
| `await komux.state()` | Tab, pane and job names, agent and job states in komux |
| `komux.onEvent(fn)` | `{type:"select", id, value}` on Enter over a list item, table row (value is the row index) or button; `{type:"key", key}` for other keys |
| `komux.onMessage(fn)` | What you send with `script_send` |
| `komux.reply(json)` | A reply for `script_wait` |
| `komux.exit(json?)` | End the script with a value |

Panel elements: `text` (`style`: plain, bold, muted, accent, success, warning, error), `markdown`, `progress`, `list`, `table` (`id` makes rows selectable), `buttons`, `divider`. Also `setTimeout`, `setInterval`, their clears, and `console.log` (kept in a log, not shown).

## Gotchas

- A turn that runs over 100 ms, a script stuck for 2 s, 64 MB of memory, or an uncaught exception stops the script. Do heavy work yourself and send the results.
- Top-level `await` works. `import` and `export` do not.
- Nothing is shared between scripts, and a script keeps no state after it ends.
- A script outlives your turn and session. It runs until it exits, you stop it, or the user closes it or its tab. Stop scripts you no longer need.
