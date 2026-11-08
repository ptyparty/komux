import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ask } from "../ask/ask.ts";
import { hostNames } from "../ask/hosts.ts";
import { AskStore } from "../ask/store.ts";
import { formSpec } from "../form/schema.ts";
import { startScript, stopScript } from "../script/run.ts";
import { ScriptStore } from "../script/store.ts";

const defaultWaitSeconds = 50;

const askDescription = `Ask the user questions in a form that pops up in their terminal (a popup in komux, a floating pane in zellij, or a popup in tmux), and get their answers back as JSON.

Use it when you need a decision, a choice between options, or several answers at once. It is quicker for the user than typing replies in chat. Element types: text, confirm (yes/no), choice (single or multi, with an automatic "Other" free-text option), number (bounded), note (display-only text), markdown (display-only, rendered markdown for longer content), image (display-only, a picture such as a screenshot shown from a file path), and slides (several images the user pages through one at a time, leaving an optional note on each; the answer is one note per slide). Use \`when\` to show an element only when an earlier answer calls for it.

The result is {"status":"submitted","values":{...}} with one entry per visible element, {"status":"cancelled"} if the user dismissed the form, {"status":"deferred","reason"?:"..."} if they chose "Not right now" (set "deferrable": false on a form that can't wait to leave that button off), or {"status":"pending"} if they have not answered within wait_seconds. When it is pending, call the wait tool with the returned id.`;

const scriptDescription = `Run a TypeScript program in a sandbox inside the user's komux, as a job in your tab. Use it for UI a single form can't do: a live checklist or progress panel you update as you work, a multi-step wizard, a table the user picks rows from.

The sandbox can only draw komux things. It has no fetch, files, processes, modules or Node/Bun APIs; it sees the JSON \`input\` you pass and a \`komux\` object:
- komux.render(elements): the panel's content. Elements: {type:"text", text, style?}, {type:"markdown", text}, {type:"progress", value, max, label?}, {type:"list", id, items:[{value, text, mark?, detail?}]}, {type:"table", id?, columns, rows}, {type:"buttons", id, options}, {type:"divider"}.
- komux.show() / komux.hide(): pop the panel up over the tab, or tuck it away (Alt j toggles it too).
- komux.dock(text|null), komux.tray(text|null), komux.toast(text): a dock row, a chip by the tray, a brief toast.
- await komux.ask(form): a komux form (no image or slides elements); resolves to {status, values}.
- await komux.state(): tab, pane and job names and agent and job states. No screen text.
- komux.onEvent(fn): {type:"select", id, value} when the user presses Enter on a list item, table row or button; {type:"key", key} for other keys.
- komux.onMessage(fn): messages you send with script_send.
- komux.reply(json): a reply you read with script_wait. komux.exit(json?): end the script.
- setTimeout, setInterval, clearTimeout, clearInterval, console.log (kept in a log).

Top-level await works; import does not. A script that throws, hogs the CPU or uses over 64 MB is stopped. It lives until it exits, is stopped, or its tab closes. \`komux script types\` prints full TypeScript declarations.`;

export function createServer(store: AskStore = new AskStore()): McpServer {
  const server = new McpServer({ name: "komux", version: "0.1.0" });

  server.registerTool(
    "ask",
    {
      title: "Ask the user",
      description: askDescription,
      inputSchema: {
        form: formSpec,
        wait_seconds: z.number().min(0).max(600).default(defaultWaitSeconds).describe("How long to wait for an answer before returning pending"),
        host: z.enum(hostNames).default("auto").describe("Where to show the form; auto detects komux, zellij, or tmux"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ form, wait_seconds, host }) => {
      const outcome = await ask(store, { ...form, deferrable: form.deferrable ?? true }, host, wait_seconds * 1000);
      return reply({ id: outcome.id, host: outcome.launch.host, message: outcome.launch.message, ...outcome.status });
    },
  );

  server.registerTool(
    "wait",
    {
      title: "Wait for an answer",
      description: "Wait for the user to answer a form opened by the ask tool. Returns the same result shapes as ask.",
      inputSchema: {
        id: z.string().describe("The id returned by ask"),
        timeout_seconds: z.number().min(0).max(600).default(defaultWaitSeconds),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, timeout_seconds }) => reply({ id, ...(await store.wait(id, timeout_seconds * 1000)) }),
  );

  server.registerTool(
    "script_run",
    {
      title: "Run a komux script",
      description: scriptDescription,
      inputSchema: {
        source: z.string().describe("The TypeScript program"),
        input: z.unknown().optional().describe("JSON the script reads as the global `input`"),
        name: z.string().optional().describe("Shown on the job chip, dock row, panel title and toasts; keep it to about 16 characters"),
        show: z.boolean().default(false).describe("Pop the panel up over the tab straight away"),
        dock: z.boolean().default(false).describe("Give the script a dock row from the start"),
        wait_seconds: z.number().min(0).max(600).default(0).describe("How long to wait for the script's first replies or its end"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ source, input, name, show, dock, wait_seconds }) => {
      const scripts = new ScriptStore();
      const meta = await startScript(scripts, source, input ?? null, { name, show, dock });
      return reply({ ...(await scripts.wait(meta.id, wait_seconds * 1000)) });
    },
  );

  server.registerTool(
    "script_send",
    {
      title: "Send a running script a message",
      description: "Deliver a JSON message to a running script's komux.onMessage handler.",
      inputSchema: { id: z.string(), message: z.unknown() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, message }) => {
      new ScriptStore().send(id, message ?? null);
      return reply({ id, sent: true });
    },
  );

  server.registerTool(
    "script_wait",
    {
      title: "Read a script's replies",
      description: "Return the script's status and any replies not read yet, waiting up to timeout_seconds for one when there are none. Status is starting, running, exited (with value), error (with error), stopped, or lost.",
      inputSchema: { id: z.string(), timeout_seconds: z.number().min(0).max(600).default(defaultWaitSeconds) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, timeout_seconds }) => reply({ ...(await new ScriptStore().wait(id, timeout_seconds * 1000)) }),
  );

  server.registerTool(
    "script_stop",
    {
      title: "Stop a script",
      description: "End a running script and close its panel.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const scripts = new ScriptStore();
      await stopScript(scripts, id);
      return reply({ ...scripts.take(id) });
    },
  );

  return server;
}

export async function serveStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

function reply(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}
