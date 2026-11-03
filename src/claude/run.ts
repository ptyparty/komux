import { BoxRenderable, TextareaRenderable, TextRenderable, bg, createCliRenderer, fg, type CliRenderer, type KeyEvent, type StyledText } from "@opentui/core";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ControlError, sendControl } from "../mux/control.ts";
import { theme } from "../mux/theme.ts";
import { decidePermission } from "./permissions.ts";
import { declineItems, declinedItems, setupItems } from "./setup.ts";
import { pick } from "./picker.ts";
import { claudeConfigDir, pastSessions, pickerItems, projectDir, readHistory, runningSessions, sessionIds, type Choice, type LiveSession } from "./sessions.ts";
import { ClaudeSession } from "./session.ts";
import { reportState } from "../hooks/hook.ts";
import { askOwner } from "../ask/ask.ts";
import type { Entry } from "./transcript.ts";
import { ClaudeView, composeKeyBindings } from "./view.ts";
import { leaveCommand, parseCommands, type Leave, type SlashCommand } from "./commands.ts";
import { freshArgs } from "./options.ts";
import { SlashCompletion } from "./completion.ts";
import { deliver } from "./inbox.ts";
import type { Attachment } from "../mux/context.ts";
import { styled } from "../ui/styled.ts";

export async function runClaude(args: string[], options: { pick: boolean }): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  const queued: string[] = [];
  let deliverTo: ((text: string) => void) | undefined;
  let session: ClaudeSession | undefined;
  let inbox: Inbox | undefined;
  let choice: Choice | undefined = { kind: "new" };
  const leave = () => {
    void (inbox?.stop() ?? Promise.resolve()).finally(() => {
      renderer.destroy();
      process.exit(0);
    });
  };
  const signals = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
  for (const signal of signals) process.on(signal, leave);
  try {
    if (options.pick && runningAsJob()) {
      inbox = await openInbox((text) => (deliverTo ? deliverTo(text) : queued.push(text)), {
        dormant: true,
        commands: () => session?.commands ?? [],
        mode: () => session?.transcript.mode,
        cycleMode: () => {
          session?.cycleMode();
          return session?.transcript.mode;
        },
        wokenAgain: () => void (session ? undefined : showIfJob()),
      });
    }
    if (inbox) choice = await wakeAndChoose(renderer, inbox);
    else {
      if (process.env.KOMUX_SOCKET) await offerSetup(renderer);
      if (options.pick) choice = await chooseSession(renderer);
    }
    if (choice?.kind === "focus" && !(await focusPane(choice.paneId))) choice = { kind: "resume", sessionId: choice.sessionId };
  } catch (error) {
    await inbox?.stop().catch(() => {});
    renderer.destroy();
    throw error;
  } finally {
    for (const signal of signals) process.off(signal, leave);
  }
  if (choice?.kind !== "new" && choice?.kind !== "resume") {
    await inbox?.stop();
    renderer.destroy();
    await renderer.closed;
    return;
  }
  if (inbox) await hideOwnJob();
  const awaken = Boolean(inbox);
  let view: ClaudeView | undefined;
  let failure: string | undefined;
  let quit: () => void = () => {};
  const quitting = new Promise<"quit">((resolve) => (quit = () => resolve("quit")));
  for (const signal of signals) process.on(signal, quit);
  try {
    const report = activityReporter();
    const reportMode = modeReporter();
    inbox ??= await openInbox((text) => (deliverTo ? deliverTo(text) : queued.push(text)), {
      commands: () => session?.commands ?? [],
      mode: () => session?.transcript.mode,
      cycleMode: () => {
        session?.cycleMode();
        return session?.transcript.mode;
      },
    });
    let sessionArgs = args;
    let cleared = false;
    for (let first = true; ; first = false) {
      const history = choice.kind === "resume" ? await readHistory(projectDir(process.cwd()), choice.sessionId) : [];
      let leave: (how: Leave) => void = () => {};
      const leaving = new Promise<Leave>((resolve) => (leave = resolve));
      const target = new ClaudeSession({
        cwd: process.cwd(),
        args: choice.kind === "resume" ? ["--resume", choice.sessionId, ...sessionArgs] : sessionArgs,
        env: process.env,
        decide: (request, signal) => decidePermission(request, process.env, signal),
        onInterrupted: () => {
          const owner = askOwner(process.env);
          if (owner) void reportState(owner, "done").catch(() => {});
        },
        onChange: () => {
          if (session !== target) return;
          view?.render();
          report(target.transcript.entries);
          reportMode(target.transcript.mode);
        },
      });
      session = target;
      reportMode(target.transcript.mode);
      target.transcript.replay(history);
      if (cleared) target.transcript.notice("New conversation · /resume goes back to the last one");
      view = new ClaudeView(renderer, target, leave);
      view.render();
      deliverTo = (text) => {
        const how = leaveCommand(text);
        if (how === "clear" || how === "resume") leave(how);
        else target.send(text);
      };
      for (const text of queued.splice(0)) deliverTo(text);
      if (first && awaken && inbox) {
        await inbox.awaken();
        await requestCompose();
      }
      const ended = target.exited.then((code) => ({ how: "quit" as const, code }));
      const outcome = await Promise.race([quitting.then((how) => ({ how, code: 0 })), leaving.then((how) => ({ how, code: 0 })), ended]);
      if (outcome.how === "quit") {
        const last = target.transcript.entries.at(-1);
        if (outcome.code !== 0 && last?.kind === "notice") failure = last.text;
        break;
      }
      deliverTo = undefined;
      view.destroy();
      view = undefined;
      const left = target.transcript.sessionId;
      const mode = target.transcript.mode;
      target.stop();
      await Promise.race([target.exited, Bun.sleep(2000)]);
      const owner = askOwner(process.env);
      if (owner) await reportState(owner, "clear");
      sessionArgs = freshArgs(args, mode);
      cleared = outcome.how === "clear" && left !== undefined;
      if (outcome.how === "clear") choice = { kind: "new" };
      else choice = (await chooseSession(renderer, { resuming: true })) ?? (left ? { kind: "resume", sessionId: left } : { kind: "new" });
    }
  } finally {
    for (const signal of signals) process.off(signal, quit);
    view?.destroy();
    view = undefined;
    await inbox?.stop().catch(() => {});
    session?.stop();
    renderer.destroy();
    await renderer.closed;
  }
  if (failure) console.error(failure);
  const id = session?.transcript.sessionId;
  if (id) console.log(`Continue this conversation with: claude --resume ${id}`);
}

async function offerSetup(renderer: CliRenderer): Promise<void> {
  let items;
  try {
    const declined = await declinedItems();
    items = (await setupItems()).filter((item) => (item.id === "hooks" ? item.state === "missing" || item.state === "outdated" : item.state === "missing") && !declined.has(item.id));
  } catch {
    return;
  }
  if (items.length === 0) return;
  await showIfJob();
  const answer = await pick(renderer, "komux setup", `${items.length} missing or out of date in ${claudeConfigDir()}`, [
    { label: "Set them up", detail: items.map((item) => item.label).join(" · "), value: "install" },
    { label: "Not now", detail: "ask again next time", value: "later" },
    { label: "Don't ask again", detail: "`komux setup` lists them, and `komux setup --pick` chooses", value: "never" },
  ]);
  if (answer === "install") for (const item of items) await item.apply().catch(() => undefined);
  if (answer === "never") await declineItems(items.map((item) => item.id)).catch(() => undefined);
}

async function chooseSession(renderer: CliRenderer, { resuming = false } = {}): Promise<Choice | undefined> {
  const cwd = process.cwd();
  const dir = projectDir(cwd);
  const known = sessionIds(dir);
  if (known.length === 0) return { kind: "new" };
  const [past, running, live] = await Promise.all([pastSessions(dir, 8), runningSessions(cwd), resuming ? [] : liveSessions()]);
  const items = pickerItems({ live, running, past, known, now: Date.now() });
  if (items.length === 1) return items[0]!.choice;
  await showIfJob();
  return pick(renderer, "Claude", cwd, items.map((item) => ({ label: item.label, detail: item.detail, value: item.choice })), resuming ? "go back" : "quit");
}

async function liveSessions(): Promise<LiveSession[]> {
  const { KOMUX_SOCKET: control, KOMUX_PANE_ID: pane } = process.env;
  if (!control) return [];
  try {
    const response = await sendControl(control, { method: "claude.sessions" }, 1000);
    return response.ok ? (response.result as LiveSession[]).filter((session) => String(session.paneId) !== pane) : [];
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return [];
  }
}

export function latestActivity(entries: readonly Entry[]): string | undefined {
  const last = entries.at(-1);
  if (last?.kind === "tool") return `▸ ${last.name}  ${last.summary}`;
  if (last?.kind === "text") return last.text.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
  return undefined;
}

function activityReporter(intervalMs = 250): (entries: readonly Entry[]) => void {
  const { KOMUX_SOCKET: control, KOMUX_PANE_ID: pane } = process.env;
  const paneId = Number(pane);
  let sent: string | undefined;
  let pending: string | undefined;
  let timer: Timer | undefined;
  const flush = () => {
    timer = undefined;
    if (pending === undefined || pending === sent) return;
    sent = pending;
    void sendControl(control!, { method: "agent.activity", params: { paneId, text: pending } }, 1000).catch(() => undefined);
  };
  return (entries) => {
    if (!control || !Number.isInteger(paneId)) return;
    pending = latestActivity(entries);
    timer ??= setTimeout(flush, intervalMs);
  };
}

function modeReporter(): (mode: string | undefined) => void {
  let sent: string | undefined;
  return (mode) => {
    if (mode === undefined || mode === sent) return;
    sent = mode;
    void ownPaneControl((paneId) => ({ method: "agent.mode", params: { paneId, mode } }));
  };
}

function showIfJob(): Promise<void> {
  return ownPaneControl((paneId) => ({ method: "pane.focus", params: { paneId, onlyJob: true } }));
}

async function focusPane(paneId: number): Promise<boolean> {
  const { KOMUX_SOCKET: control, KOMUX_PANE_ID: pane } = process.env;
  if (!control) return false;
  const own = Number(pane);
  const closing = Number.isInteger(own) && !startedFromShell() ? own : undefined;
  try {
    return (await sendControl(control, { method: "pane.focus", params: { paneId, closing } }, 1000)).ok;
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return false;
  }
}

const shells = new Set(["bash", "fish", "zsh", "sh", "dash", "nu", "ksh", "tcsh"]);

function startedFromShell(): boolean {
  try {
    return shells.has(readFileSync(`/proc/${process.ppid}/comm`, "utf8").trim());
  } catch {
    return false;
  }
}

type Inbox = { stop: () => Promise<void>; awaken: () => Promise<void>; nextWake: () => Promise<void>; forgetWake: () => void };

function runningAsJob(): boolean {
  const { KOMUX_JOB: job, KOMUX_PANE_ID: pane, KOMUX_SOCKET: control } = process.env;
  return Boolean(control) && job !== undefined && job === pane;
}

async function wakeAndChoose(renderer: CliRenderer, inbox: Inbox): Promise<Choice | undefined> {
  let setupOffered = false;
  for (;;) {
    await dormant(renderer, inbox);
    if (!setupOffered) {
      await offerSetup(renderer);
      setupOffered = true;
    }
    const choice = await chooseSession(renderer);
    if (choice) return choice;
    await hideOwnJob();
  }
}

function dormant(renderer: CliRenderer, inbox: Inbox): Promise<void> {
  const box = new BoxRenderable(renderer, { width: "100%", height: "100%", backgroundColor: theme.background, padding: 1 });
  box.add(new TextRenderable(renderer, { content: "Claude isn't running in this tab · Alt c starts it · Enter starts it here", fg: theme.muted }));
  renderer.root.add(box);
  renderer.requestRender();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      renderer.keyInput.off("keypress", onKey);
      inbox.forgetWake();
      renderer.root.remove(box);
      box.destroyRecursively();
      resolve();
    };
    const onKey = (key: KeyEvent) => {
      if (key.name === "return") finish();
    };
    renderer.keyInput.on("keypress", onKey);
    void inbox.nextWake().then(finish);
  });
}

async function ownPaneControl(request: (paneId: number) => Parameters<typeof sendControl>[1]): Promise<void> {
  const { KOMUX_SOCKET: control, KOMUX_PANE_ID: pane } = process.env;
  const paneId = Number(pane);
  if (!control || !Number.isInteger(paneId)) return;
  await sendControl(control, request(paneId), 1000).catch(() => undefined);
}

function hideOwnJob(): Promise<void> {
  return ownPaneControl((jobId) => ({ method: "job.hide", params: { jobId } }));
}

function requestCompose(): Promise<void> {
  return ownPaneControl((paneId) => ({ method: "claude.compose", params: { paneId } }));
}

async function openInbox(
  onText: (text: string) => void,
  options: { dormant?: boolean; commands?: () => SlashCommand[]; mode?: () => string | undefined; cycleMode?: () => string | undefined; wokenAgain?: () => void } = {},
): Promise<Inbox | undefined> {
  const { KOMUX_SOCKET: control, KOMUX_PANE_ID: pane, KOMUX_TAB_DIR: dir } = process.env;
  const paneId = Number(pane);
  if (!control || !dir || !Number.isInteger(paneId)) return undefined;
  const path = join(dir, `claude-${paneId}.sock`);
  rmSync(path, { force: true });
  const buffers = new WeakMap<object, string>();
  let wake: (() => void) | undefined;
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        const lines = ((buffers.get(socket) ?? "") + data.toString()).split("\n");
        buffers.set(socket, lines.pop()!);
        for (const line of lines) {
          try {
            const { text, wake: woken, commands, cycleMode } = JSON.parse(line) as { text?: unknown; wake?: unknown; commands?: unknown; cycleMode?: unknown };
            if (cycleMode === true) socket.write(`${JSON.stringify({ mode: options.cycleMode?.() })}\n`);
            else if (commands === true) socket.write(`${JSON.stringify({ commands: options.commands?.() ?? [], mode: options.mode?.() })}\n`);
            else if (woken === true) (wake ?? options.wokenAgain)?.();
            else if (typeof text === "string" && text.trim()) onText(text.trim());
          } catch {}
        }
      },
    },
  });
  const register = async (socket: string | null, dormant = false): Promise<boolean> => {
    try {
      return (await sendControl(control, { method: "claude.register", params: { paneId, socket, dormant } }, 1000)).ok;
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      return false;
    }
  };
  const stop = async () => {
    server.stop(true);
    rmSync(path, { force: true });
    await register(null);
  };
  try {
    if (!(await register(path, options.dormant)) && options.dormant) {
      await stop();
      return undefined;
    }
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
  const nextWake = () =>
    new Promise<void>((resolve) => {
      wake = () => {
        wake = undefined;
        resolve();
      };
    });
  return { stop, awaken: async () => void (await register(path)), nextWake, forgetWake: () => (wake = undefined) };
}

export async function runCompose(socket: string, name: string, source?: { file: string; label?: string }): Promise<void> {
  const attachments = source ? await readAttachments(source) : [];
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  const message = await composeMessage(renderer, name, () => fetchInbox(socket), () => askInbox(socket, { cycleMode: true }), attachments);
  renderer.destroy();
  await renderer.closed;
  if (message) await deliver(socket, withContext(message.attachments, message.text));
}

async function readAttachments(source: { file: string; label?: string }): Promise<Attachment[]> {
  try {
    const text = await Bun.file(source.file).text();
    if (source.label !== undefined) return [{ label: source.label, text }];
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is Attachment => typeof item?.label === "string" && typeof item?.text === "string") : [];
  } finally {
    rmSync(source.file, { force: true });
  }
}

export function withContext(attachments: Attachment[], text: string): string {
  return [...attachments.map((attachment) => attachment.text.trimEnd()), text].join("\n\n");
}

type InboxInfo = { commands: SlashCommand[]; mode?: string };

function composeMessage(
  renderer: CliRenderer,
  name: string,
  load: () => Promise<InboxInfo>,
  cycleMode: () => Promise<InboxInfo>,
  attached: Attachment[],
): Promise<{ text: string; attachments: Attachment[] } | undefined> {
  return new Promise((resolve) => {
    let commands: SlashCommand[] = [];
    let loading: Promise<void> | undefined;
    const title = (mode?: string) => `To ${name}${mode ? ` (${mode} mode)` : ""} · / commands · Enter send · Alt+Enter newline · Shift+Tab mode · Esc cancel`;
    const fetch = () => {
      loading ??= load().then((found) => {
        commands = found.commands;
        if (found.mode) header.content = title(found.mode);
        if (found.commands.length === 0) loading = undefined;
        completion.update();
      });
    };
    const box = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.background, paddingLeft: 1, paddingRight: 1 });
    const header = new TextRenderable(renderer, { content: title(), fg: theme.muted, height: 1, flexShrink: 0 });
    box.add(header);
    const attachments = [...attached];
    const chips = new TextRenderable(renderer, { content: chipText(attachments), flexShrink: 0, wrapMode: "word" });
    if (attachments.length > 0) box.add(chips);
    const send = () => {
      const text = input.plainText.trim();
      resolve(text ? { text, attachments } : undefined);
    };
    const input: TextareaRenderable = new TextareaRenderable(renderer, {
      flexGrow: 1,
      wrapMode: "word",
      textColor: theme.text,
      focusedTextColor: theme.text,
      keyBindings: composeKeyBindings,
      onSubmit: send,
      onContentChange: () => {
        if (commands.length === 0 && input.plainText.startsWith("/")) fetch();
        completion.update();
      },
    });
    const completion = new SlashCompletion(renderer, input, { commands: () => commands, submit: send, quit: false });
    box.add(completion.list);
    box.add(input);
    renderer.root.add(box);
    input.focus();
    fetch();
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (key.name === "tab" && key.shift) {
        key.preventDefault();
        void cycleMode().then((found) => {
          if (found.mode) header.content = title(found.mode);
        });
      } else if (key.name === "backspace" && input.plainText === "" && attachments.length > 0) {
        key.preventDefault();
        attachments.pop();
        if (attachments.length === 0) box.remove(chips);
        else chips.content = chipText(attachments);
      } else if (completion.handleKey(key)) key.preventDefault();
      else if (key.name === "escape") resolve(undefined);
    });
  });
}

function chipText(attachments: Attachment[]): StyledText {
  return styled(attachments.flatMap((attachment, index) => [...(index > 0 ? [" "] : []), bg(theme.accent)(fg(theme.background)(` ${attachment.label} `))]));
}

function fetchInbox(socket: string): Promise<InboxInfo> {
  return askInbox(socket, { commands: true });
}

function askInbox(socket: string, request: { commands: true } | { cycleMode: true }, timeoutMs = 1000): Promise<InboxInfo> {
  return new Promise((resolve) => {
    let buffer = "";
    const timer = setTimeout(() => resolve({ commands: [] }), timeoutMs);
    const done = (info: InboxInfo) => {
      clearTimeout(timer);
      resolve(info);
    };
    Bun.connect({
      unix: socket,
      socket: {
        open: (connection) => void connection.write(`${JSON.stringify(request)}\n`),
        data: (connection, data) => {
          buffer += data.toString();
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          connection.end();
          try {
            const reply = JSON.parse(buffer.slice(0, newline)) as { commands?: unknown; mode?: unknown };
            done({ commands: parseCommands(reply.commands), mode: typeof reply.mode === "string" ? reply.mode : undefined });
          } catch {
            done({ commands: [] });
          }
        },
        error: () => done({ commands: [] }),
      },
    }).catch(() => done({ commands: [] }));
  });
}
