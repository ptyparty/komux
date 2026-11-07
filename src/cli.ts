#!/usr/bin/env bun
import { constants } from "node:os";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AlreadyAnsweredError, answer, ask, askOwner, reopen } from "./ask/ask.ts";
import { HostLaunchError, hostNames, type HostName } from "./ask/hosts.ts";
import { AskStore, UnknownAskError } from "./ask/store.ts";
import { UnsafeDirectoryError } from "./private-dir.ts";
import { formSpec, parseFormSpec, type FormSpec } from "./form/schema.ts";
import { runHook, waitForAnswers } from "./hooks/hook.ts";
import { sendControl } from "./mux/control.ts";
import type { ReplyChoice } from "./mux/peek.ts";
import { ScriptLaunchError, UnknownScriptError } from "./script/store.ts";
import { defaultSessionName, listSessions, quitSession, SessionError } from "./mux/session/sessions.ts";

const usage = `komux: a terminal multiplexer agents can drive

Usage:
  komux [attach [NAME]]
      Attach to session NAME (default "main"), starting it if it is not running.
      Detach with Ctrl Space d; the session keeps running.
  komux ls
      List running sessions.
  komux kill NAME
      End a session and every program running in it.
  komux project NAME|PATH|--repo OWNER/REPO [--layout NAME] [--arg KEY=VALUE]...
      From inside a session, open a project in a new tab, or switch to its tab if it is open.
      --repo finds the repo's clone under the project roots. --layout picks a layout, and
      --arg fills in the args it declares.
  komux pane open [--right|--below|--tab|--popup] [--name NAME] [--no-focus] [--width PCT] [--height PCT] -- COMMAND...
      From inside a session, open a pane running COMMAND beside this one, or over this tab with --popup.
      A popup closes when COMMAND succeeds; --width and --height size it. Prints the new pane's id.
  komux claude compose --from-stdin --label LABEL
      From inside a pane, open the message box for this tab's Claude with stdin attached as context.
      The label names the context in the box; on send, the context goes ahead of the message.
  komux claude [--resume ID|--continue] [--mode MODE] [--prompt TEXT] [-- CLAUDE_ARGS...]
      Run a Claude Code session in this pane with komux drawing the conversation (experimental).
      From anywhere else in the tab, Alt+c sends it a message.
      --mode starts it in default, acceptEdits, plan or auto mode; /mode or Shift+Tab changes it later.
  komux job run [--name NAME] [--wait] -- COMMAND...
      From inside a session, run COMMAND out of sight as a job in this tab; a toast says when it is done.
      Prints the job's id. With --wait, print the job's output as it runs and exit with its exit code.
  komux script run FILE.ts|- [--input JSON] [--name NAME] [--show] [--dock] [--wait] [--timeout SECONDS]
      From inside a pane, run a TypeScript program as a job in a sandbox that can only draw komux panels,
      ask questions, toast, and set dock and tray text. It can't run commands, touch files or reach the network.
      Prints {"id", ...}; with --wait, also waits for its first replies or its end.
  komux script send ID JSON
      Deliver JSON to the script's komux.onMessage handler.
  komux script wait ID [--timeout SECONDS]
      Print the script's status and any replies not yet read, waiting for one if there are none.
  komux script stop ID
      End a running script.
  komux script ls
      List scripts and their status.
  komux script types
      Print the TypeScript declarations of what a script can use.
  komux ask [spec.json|-] [--wait] [--timeout SECONDS] [--host auto|komux|zellij|tmux|none]
      Open a form for the user and print {"id", "host", "message", "status", ...}.
      With --wait, block until the user answers (or the timeout passes); killing it withdraws the form.
  komux wait ID [--timeout SECONDS]
      Print the ask's result, waiting for it if necessary. Without --timeout, waits forever.
  komux open ID [--host ...]
      Show a pending ask's form, for example when no host was detected when it was asked.
  komux pending
      List asks that have not been answered.
  komux form spec.json
      Show a form in this terminal and print the result.
  komux form --ask ID [--asks-dir DIR]
      Show a stored ask's form in this terminal and record the answer.
      Closing the form records a cancel.
  komux schema
      Print the JSON Schema for form specs.
  komux mcp
      Run the MCP server on stdio.
  komux hook
      Claude Code hook: reads the hook's JSON on stdin and reports the agent's state to komux.
      Permission requests become a popup in the agent's tab. Does nothing outside komux.
  komux peek spec.json --pane ID [--list]
      Show an agent's reply (what Alt p opens); a typed reply is sent to pane ID.
      With --list, the file lists the agent's replies to pick one from.
  komux setup [--yes|--pick|--remove]
      List komux's Claude Code hooks, skill and rules and whether each is set up in Claude's config.
      --yes sets up what is missing, --pick chooses in a form, --remove takes them out again.
      Skills and rules are links into this checkout, so they follow it as it updates.
  komux hooks [--install]
      List the Claude Code hooks komux needs that are missing from your settings, or add them.
  komux hook --wake
      Claude Code Stop hook to run with asyncRewake: waits until a form this pane opened is answered
      or dismissed, then exits 2 with the answer so Claude wakes up and reads it.

Results are JSON: {"status":"submitted","values":{...}}, {"status":"cancelled"}, or {"status":"pending"}.`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "ask":
      return askCommand(rest);
    case "wait":
      return waitCommand(rest);
    case "open":
      return openCommand(rest);
    case "pending":
      return print(await new AskStore().pending());
    case "form":
      return formCommand(rest);
    case "schema":
      return print(z.toJSONSchema(formSpec));
    case "mcp":
      return (await import("./mcp/server.ts")).serveStdio();
    case "peek":
      return peekCommand(rest);
    case "hooks":
      return hooksCommand(rest);
    case "setup":
      return setupCommand(rest);
    case "hook":
      return rest[0] === "--wake" ? wakeCommand() : hookCommand();
    case undefined:
      return (await import("./mux/session/client.ts")).attachSession(defaultSessionName);
    case "attach":
      return (await import("./mux/session/client.ts")).attachSession(rest[0] ?? defaultSessionName);
    case "ls":
      return listCommand();
    case "kill":
      return quitSession(requireName(rest));
    case "project":
      return projectCommand(rest);
    case "pane":
      return paneCommand(rest);
    case "job":
      return jobCommand(rest);
    case "claude":
      return claudeCommand(rest);
    case "script":
      return scriptCommand(rest);
    case "server":
      return (await import("./mux/session/server.ts")).runServer(requireName(rest));
    case "help":
    case "--help":
    case "-h":
      console.log(usage);
      return;
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

async function askCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    wait: { type: "boolean", default: false },
    timeout: { type: "string" },
    host: { type: "string", default: "auto" },
  });
  const spec = await readSpec(positionals[0] ?? "-");
  const waitMs = values.wait ? timeoutMs(values.timeout) : 0;
  const withdraw = new AbortController();
  let caught: "SIGTERM" | "SIGINT" | "SIGHUP" | undefined;
  if (values.wait) {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.on(signal, () => {
        caught = signal;
        withdraw.abort();
      });
    }
  }
  const outcome = await ask(new AskStore(), spec, hostOption(values.host), waitMs, { owner: askOwner(process.env), signal: withdraw.signal });
  print({ id: outcome.id, host: outcome.launch.host, message: outcome.launch.message, ...outcome.status });
  if (caught) process.exit(128 + constants.signals[caught]);
}

async function waitCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { timeout: { type: "string" } });
  const id = requireId(positionals);
  print({ id, ...(await new AskStore().wait(id, timeoutMs(values.timeout))) });
}

async function openCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { host: { type: "string", default: "auto" } });
  const id = requireId(positionals);
  const launch = await reopen(new AskStore(), id, hostOption(values.host));
  print({ id, host: launch.host, message: launch.message });
}

async function formCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { ask: { type: "string" }, "asks-dir": { type: "string" } });
  if (values.ask !== undefined) {
    await answer(new AskStore(values["asks-dir"]), values.ask);
    return;
  }
  const [source] = positionals;
  if (source === undefined || source === "-") {
    throw new UsageError("komux form needs a spec file; stdin is reserved for the keyboard");
  }
  print(await (await import("./form/show.ts")).showForm(await readSpec(source), async () => {}));
}

function parse<T extends NonNullable<Parameters<typeof parseArgs>[0]>["options"]>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function readSpec(source: string): Promise<FormSpec> {
  const text = source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`form spec is not valid JSON: ${(error as Error).message}`);
  }
  return parseFormSpec(json);
}

function timeoutMs(seconds: string | undefined): number {
  if (seconds === undefined) return Number.POSITIVE_INFINITY;
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`--timeout must be a number of seconds, got ${seconds}`);
  return parsed * 1000;
}

function hostOption(host: string | boolean | undefined): HostName {
  if (!hostNames.includes(host as HostName)) throw new UsageError(`--host must be one of ${hostNames.join(", ")}`);
  return host as HostName;
}

function requireId(positionals: string[]): string {
  const [id] = positionals;
  if (!id) throw new UsageError("missing id");
  return id;
}

async function hookCommand(): Promise<void> {
  try {
    const output = await runHook(await Bun.stdin.text(), process.env);
    if (output) console.log(output);
  } catch (error) {
    console.error(`komux hook: ${(error as Error).message}`);
  }
  process.exit(0);
}

async function peekCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { pane: { type: "string" }, list: { type: "boolean" } });
  const [source] = positionals;
  if (!source) throw new UsageError("komux peek needs a spec file");
  const { showForm } = await import("./form/show.ts");
  const { peekSpec, pickSpec } = await import("./mux/peek.ts");
  const list = values.list || (await holdsReplyList(source)) ? await readReplyList(source) : undefined;
  let text = "";
  if (list) {
    for (;;) {
      const picked = await showForm(pickSpec(list.title, list.replies), async () => {});
      const choice = picked.status === "submitted" ? list.replies[Number(picked.values.pick)] : undefined;
      if (!choice) return;
      const result = await showForm(peekSpec(list.title, choice.text), async () => {});
      if (result.status !== "submitted") continue;
      text = typeof result.values.reply === "string" ? result.values.reply.trim() : "";
      break;
    }
  } else {
    const result = await showForm(await readSpec(source), async () => {});
    text = result.status === "submitted" && typeof result.values.reply === "string" ? result.values.reply.trim() : "";
  }
  const paneId = Number(values.pane);
  const socket = process.env.KOMUX_SOCKET;
  if (!text || !socket || !Number.isInteger(paneId)) return;
  await sendControl(socket, { method: "agent.prompt", params: { paneId, text } }).catch(() => undefined);
}

async function holdsReplyList(source: string): Promise<boolean> {
  if (source === "-") return false;
  const json: unknown = await Bun.file(source).json().catch(() => undefined);
  return typeof json === "object" && json !== null && "replies" in json && !("elements" in json);
}

async function readReplyList(source: string): Promise<{ title: string; replies: ReplyChoice[] }> {
  const json: unknown = await (source === "-" ? Bun.stdin.json() : Bun.file(source).json()).catch(() => undefined);
  if (typeof json !== "object" || json === null || !("replies" in json) || !Array.isArray(json.replies)) throw new UsageError(`${source} is not a list of replies`);
  const replies: unknown[] = json.replies;
  const valid = (entry: unknown): entry is ReplyChoice =>
    typeof entry === "object" && entry !== null && "label" in entry && typeof entry.label === "string" && "text" in entry && typeof entry.text === "string";
  if (replies.length === 0 || !replies.every(valid)) throw new UsageError(`${source} lists replies that each need a label and text`);
  const title = "title" in json && typeof json.title === "string" ? json.title : "Replies";
  return { title, replies };
}

async function setupCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { yes: { type: "boolean" }, pick: { type: "boolean" }, remove: { type: "boolean" } });
  if (positionals.length > 0) throw new UsageError(`unexpected ${positionals[0]}`);
  if ([values.yes, values.pick, values.remove].filter(Boolean).length > 1) throw new UsageError("give one of --yes, --pick and --remove");
  const { setupItems, stateMarks } = await import("./claude/setup.ts");
  const { claudeConfigDir } = await import("./claude/sessions.ts");
  const items = await setupItems();
  const width = Math.max(...items.map((item) => item.label.length));
  const line = (item: (typeof items)[number], text: string) => `  ${stateMarks[item.state]} ${item.label.padEnd(width)}  ${text}`;
  if (values.remove) {
    for (const item of items) {
      const outcome = await item.remove();
      if (outcome) console.log(`  ${item.label.padEnd(width)}  ${outcome}`);
    }
    return;
  }
  const needed = items.filter((item) => item.state !== "installed");
  let chosen = values.yes ? needed : [];
  if (values.pick) {
    const result = await (await import("./form/show.ts")).showForm(
      {
        title: "komux setup",
        description: `Claude Code's config in ${claudeConfigDir()}`,
        elements: [
          {
            type: "choice",
            id: "items",
            label: "Set up",
            multi: true,
            other: false,
            options: items.map((item) => ({ value: item.id, label: `${stateMarks[item.state]} ${item.label}`, description: item.detail })),
            default: needed.map((item) => item.id),
          },
        ],
        submitLabel: "Set up",
      },
      async () => {},
    );
    if (result.status !== "submitted") return;
    const picked = new Set(Array.isArray(result.values.items) ? result.values.items : []);
    chosen = items.filter((item) => picked.has(item.id) && item.state !== "installed");
  }
  if (!values.yes && !values.pick) {
    console.log(`Claude Code setup for komux, in ${claudeConfigDir()}:\n`);
    for (const item of items) console.log(line(item, item.detail));
    if (needed.length > 0) console.log(`\nRun \`komux setup --yes\` to set up the ${needed.length} not marked ✓, or \`komux setup --pick\` to choose.`);
    return;
  }
  if (chosen.length === 0) return console.log("Nothing to set up.");
  let failed = false;
  for (const item of chosen) {
    const outcome = await item.apply().then(
      (done) => `${stateMarks.installed} ${item.label.padEnd(width)}  ${done}`,
      (error: Error) => ((failed = true), `${stateMarks.missing} ${item.label.padEnd(width)}  ${error.message}`),
    );
    console.log(`  ${outcome}`);
  }
  if (failed) process.exitCode = 1;
}

async function hooksCommand(args: string[]): Promise<void> {
  const { values } = parse(args, { install: { type: "boolean" } });
  const setup = await import("./claude/hooks-setup.ts");
  const { user: path, local: localPath } = setup.settingsPaths();
  const [settings, local] = await Promise.all([setup.readSettings(path), setup.readSettings(localPath)]);
  const missing = setup.missingHooks([settings, local]);
  if (missing.length === 0) return console.log(`komux hooks are up to date in ${path}`);
  if (!values.install) {
    console.log(`Missing or out of date in ${path}:`);
    for (const hook of missing) console.log(`  ${hook.label}: ${hook.why}`);
    return console.log("Run `komux hooks --install` to add them.");
  }
  const backup = await setup.writeSettings(path, setup.installHooks(settings, [local], setup.defaultHookCommand()));
  console.log(`Installed ${missing.length} komux hooks in ${path}${backup ? `; the old file is at ${backup}` : ""}`);
}

async function wakeCommand(): Promise<void> {
  let input = {};
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {}
  const notice = await waitForAnswers(process.env, input).catch(() => undefined);
  if (!notice) process.exit(0);
  console.error(notice);
  process.exit(2);
}

async function projectCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { repo: { type: "string" }, layout: { type: "string" }, arg: { type: "string", multiple: true } });
  const [target, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`unexpected ${extra[0]}`);
  if (target && values.repo) throw new UsageError("give a project name or --repo, not both");
  if (!target && !values.repo) throw new UsageError("missing project name or path");
  if (values.repo && !/^[^/\s]+\/[^/\s]+$/.test(values.repo)) throw new UsageError(`--repo must look like OWNER/REPO, got ${values.repo}`);
  const layoutArgs = Object.fromEntries((values.arg ?? []).map(layoutArg));
  const socket = process.env.KOMUX_SOCKET;
  if (!socket) throw new UsageError("komux project works from inside a komux session");
  const choice = { ...(values.layout ? { layout: values.layout } : {}), args: layoutArgs };
  const params = target ? { target, ...choice } : { repo: values.repo!, ...choice };
  const response = await sendControl(socket, { method: "project.open", params }).catch((error: Error) => {
    throw new SessionError(error.message);
  });
  if (!response.ok) throw new SessionError(response.error);
}

async function composeFromStdin(label: string | undefined): Promise<void> {
  if (!label) throw new UsageError("--from-stdin needs --label");
  const socket = process.env.KOMUX_SOCKET;
  const paneId = Number(process.env.KOMUX_PANE_ID);
  if (!socket || !Number.isInteger(paneId)) throw new UsageError("komux claude compose --from-stdin works from inside a komux pane");
  const text = (await Bun.stdin.text()).trim();
  if (!text) throw new UsageError("nothing on stdin to attach");
  const response = await sendControl(socket, { method: "claude.compose", params: { paneId, context: { text, label } } }).catch((error: Error) => {
    throw new SessionError(error.message);
  });
  if (!response.ok) throw new SessionError(response.error);
}

function layoutArg(arg: string): [string, string] {
  const split = arg.indexOf("=");
  if (split <= 0) throw new UsageError(`--arg must look like KEY=VALUE, got ${arg}`);
  return [arg.slice(0, split), arg.slice(split + 1)];
}

async function paneCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "open") throw new UsageError(`unknown pane command ${subcommand ?? ""}`.trim());
  const { values, positionals } = parse(rest, {
    right: { type: "boolean" },
    below: { type: "boolean" },
    tab: { type: "boolean" },
    popup: { type: "boolean" },
    width: { type: "string" },
    height: { type: "string" },
    name: { type: "string" },
    "no-focus": { type: "boolean" },
  });
  const placements = (["right", "below", "tab", "popup"] as const).filter((placement) => values[placement]);
  if (placements.length > 1) throw new UsageError("pick one of --right, --below, --tab, and --popup");
  const width = percent(values.width, "--width");
  const height = percent(values.height, "--height");
  if (positionals.length === 0) throw new UsageError("missing the command to run in the pane");
  const socket = process.env.KOMUX_SOCKET;
  const near = Number(process.env.KOMUX_PANE_ID);
  if (!socket || !Number.isInteger(near)) throw new UsageError("komux pane open works from inside a komux pane");
  const response = await sendControl(socket, {
    method: "pane.open",
    params: { command: positionals, near, placement: placements[0] ?? "right", name: values.name, focus: !values["no-focus"], width, height },
  }).catch((error: Error) => {
    throw new SessionError(error.message);
  });
  if (!response.ok) throw new SessionError(response.error);
  console.log((response.result as { paneId: number }).paneId);
}

async function claudeCommand(args: string[]): Promise<void> {
  const { runClaude, runCompose } = await import("./claude/run.ts");
  if (args[0] === "compose") {
    const { values } = parse(args.slice(1), {
      socket: { type: "string" },
      name: { type: "string" },
      "from-stdin": { type: "boolean" },
      "context-file": { type: "string" },
      attachments: { type: "string" },
      label: { type: "string" },
    });
    if (values["from-stdin"]) return composeFromStdin(values.label);
    if (!values.socket) throw new UsageError("missing --socket");
    const attachments = values.attachments ? { file: values.attachments } : values["context-file"] ? { file: values["context-file"], label: values.label ?? "context" } : undefined;
    return runCompose(values.socket, values.name ?? "Claude", attachments);
  }
  const { values, positionals } = parse(args, { resume: { type: "string" }, continue: { type: "boolean" }, mode: { type: "string" }, prompt: { type: "string" } });
  if (values.resume && values.continue) throw new UsageError("pick one of --resume and --continue");
  const { parseMode, permissionModes } = await import("./claude/commands.ts");
  const mode = values.mode === undefined ? undefined : parseMode(values.mode);
  if (values.mode !== undefined && !mode) throw new UsageError(`--mode must be one of ${permissionModes.join(", ")}`);
  const picksItself = ["--resume", "-r", "--continue", "-c", "--session-id", "--fork-session", "--from-pr"];
  const pick = !values.resume && !values.continue && values.prompt === undefined && !positionals.some((arg) => picksItself.includes(arg.split("=")[0]!));
  const claudeArgs = [...(values.resume ? ["--resume", values.resume] : []), ...(values.continue ? ["--continue"] : []), ...(mode ? ["--permission-mode", mode] : []), ...positionals];
  const { claudeOptions } = await import("./claude/options.ts");
  try {
    claudeOptions(claudeArgs);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  return runClaude(claudeArgs, { pick, ...(values.prompt !== undefined ? { prompt: values.prompt } : {}) });
}

async function scriptCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const { ScriptStore } = await import("./script/store.ts");
  switch (subcommand) {
    case "run": {
      const { values, positionals } = parse(rest, {
        input: { type: "string" },
        name: { type: "string" },
        show: { type: "boolean", default: false },
        dock: { type: "boolean", default: false },
        wait: { type: "boolean", default: false },
        timeout: { type: "string" },
      });
      const source = positionals[0] === undefined || positionals[0] === "-" ? await Bun.stdin.text() : await Bun.file(positionals[0]).text();
      const input = values.input === undefined ? null : jsonArg(values.input, "--input");
      const store = new ScriptStore();
      const { startScript } = await import("./script/run.ts");
      const meta = await startScript(store, source, input, { name: values.name, show: values.show, dock: values.dock });
      return print(values.wait ? await store.wait(meta.id, timeoutMs(values.timeout ?? "50")) : { id: meta.id, name: meta.name, status: "starting" });
    }
    case "send": {
      const [id, message] = rest;
      if (!id || message === undefined) throw new UsageError("komux script send takes an id and a JSON message");
      new ScriptStore().send(id, jsonArg(message, "the message"));
      return;
    }
    case "wait": {
      const { values, positionals } = parse(rest, { timeout: { type: "string" } });
      return print(await new ScriptStore().wait(requireId(positionals), timeoutMs(values.timeout)));
    }
    case "stop": {
      const store = new ScriptStore();
      const [id] = rest;
      if (!id) throw new UsageError("missing script id");
      const { stopScript } = await import("./script/run.ts");
      await stopScript(store, id);
      return print(store.take(id));
    }
    case "ls":
      return print(new ScriptStore().list().map(({ meta, status }) => ({ id: meta.id, name: meta.name, createdAt: meta.createdAt, status })));
    case "types":
      process.stdout.write(await Bun.file(new URL("./script/komux-script.d.ts", import.meta.url)).text());
      return;
    case "host":
      if (!rest[0]) throw new UsageError("missing script id");
      return (await import("./script/host.ts")).runScriptHost(rest[0]);
    default:
      throw new UsageError(`unknown script command ${subcommand ?? ""}`.trim());
  }
}

function jsonArg(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${what} is not valid JSON: ${(error as Error).message}`);
  }
}

async function jobCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "run") throw new UsageError(`unknown job command ${subcommand ?? ""}`.trim());
  const { values, positionals } = parse(rest, { name: { type: "string" }, wait: { type: "boolean" } });
  if (positionals.length === 0) throw new UsageError("missing the command to run as a job");
  const socket = process.env.KOMUX_SOCKET;
  const near = Number(process.env.KOMUX_PANE_ID);
  if (!socket || !Number.isInteger(near)) throw new UsageError("komux job run works from inside a komux pane");
  const control = async (request: Parameters<typeof sendControl>[1]) => {
    const response = await sendControl(socket, request).catch((error: Error) => {
      throw new SessionError(error.message);
    });
    if (!response.ok) throw new SessionError(response.error);
    return response.result;
  };
  const { jobId, log } = (await control({ method: "job.run", params: { command: positionals, near, name: values.name, cwd: process.cwd(), env: definedEnv(), awaited: values.wait === true } })) as { jobId: number; log: string };
  if (!values.wait) {
    console.log(jobId);
    return;
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      void sendControl(socket, { method: "job.stop", params: { jobId } }).finally(() => process.exit(128 + constants.signals[signal]));
    });
  }
  const output = new JobOutput(log);
  for (;;) {
    const status = (await control({ method: "job.status", params: { jobId } })) as { state: string; code: number | null };
    const finished = status.state !== "running";
    if (finished) await Bun.sleep(300);
    await output.drain(finished);
    if (finished) process.exit(status.code ?? 1);
    await Bun.sleep(300);
  }
}

function definedEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

class JobOutput {
  private offset = 0;
  private pending = "";
  private readonly decoder = new TextDecoder();

  constructor(private readonly path: string) {}

  async drain(final: boolean): Promise<void> {
    const file = Bun.file(this.path);
    const bytes = await file.slice(this.offset).bytes();
    this.offset += bytes.length;
    const text = this.pending + this.decoder.decode(bytes, { stream: !final });
    const end = final ? text.length : text.lastIndexOf("\n") + 1;
    this.pending = text.slice(end);
    const lines = Bun.stripANSI(text.slice(0, end)).replace(/\r\n/g, "\n").split("\n").map((line) => line.slice(line.lastIndexOf("\r") + 1));
    const printable = lines.join("\n");
    if (printable !== "") process.stdout.write(final && !printable.endsWith("\n") ? `${printable}\n` : printable);
  }
}

function percent(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value.replace(/%$/, ""));
  if (!Number.isFinite(number) || number < 10 || number > 100) throw new UsageError(`${flag} takes a percentage from 10 to 100`);
  return number;
}

async function listCommand(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    console.log("No running sessions. Start one with: komux attach NAME");
    return;
  }
  for (const session of sessions) {
    console.log(`${session.session}  ${session.tabs} tab(s), ${session.panes} pane(s)${session.attached > 0 ? `  (${session.attached} attached)` : ""}`);
  }
}

function requireName(args: string[]): string {
  const [name] = args;
  if (!name) throw new UsageError("missing session name");
  return name;
}

function isReportable(error: unknown): error is Error {
  return [UnknownAskError, HostLaunchError, AlreadyAnsweredError, UnsafeDirectoryError, SessionError, UnknownScriptError, ScriptLaunchError].some((type) => error instanceof type);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof z.ZodError) console.error(`invalid form spec:\n${z.prettifyError(error)}`);
  else if (error instanceof UsageError) console.error(`${error.message}\n\n${usage}`);
  else if (isReportable(error)) console.error(error.message);
  else throw error;
  process.exit(1);
}
