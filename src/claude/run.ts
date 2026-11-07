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
import { deliver, draftSocketPath } from "./inbox.ts";
import type { Attachment } from "../mux/context.ts";
import { styled } from "../ui/styled.ts";
import { DraftWatch } from "./draft.ts";

export async function runClaude(args: string[], options: { pick: boolean; prompt?: string }): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  const queued: string[] = options.prompt ? [options.prompt] : [];
  let deliverTo: ((text: string) => void) | undefined;
  let session: ClaudeSession | undefined;
  let inbox: Inbox | undefined;
  let choice: Choice | undefined = { kind: "new" };
  let started: Start | undefined;
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
        session: () => session?.transcript.sessionId,
        cycleMode: () => {
          session?.cycleMode();
          return session?.transcript.mode;
        },
        wokenAgain: () => void (session ? undefined : showIfJob()),
        onStart: (start) => {
          if (started || session) return false;
          started = start;
          return true;
        },
      });
    }
    if (inbox) choice = await wakeAndChoose(renderer, inbox, () => started);
    if (started?.prompt) queued.push(started.prompt);
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
      session: () => session?.transcript.sessionId,
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
        if (!started?.prompt) await requestCompose();
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
  const closing = Number.isInteger(own) && !runningAsJob() && !startedFromShell() ? own : undefined;
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

type Start = { resume?: string; prompt?: string };

async function wakeAndChoose(renderer: CliRenderer, inbox: Inbox, preset: () => Start | undefined): Promise<Choice | undefined> {
  let setupOffered = false;
  for (;;) {
    await dormant(renderer, inbox);
    const start = preset();
    if (start) return start.resume ? { kind: "resume", sessionId: start.resume } : { kind: "new" };
    if (!setupOffered) {
      await offerSetup(renderer);
      setupOffered = true;
    }
    const choice = await chooseSession(renderer);
    if (choice?.kind !== "focus") {
      if (choice) return choice;
      await hideOwnJob();
      continue;
    }
    if (!(await focusPane(choice.paneId))) return { kind: "resume", sessionId: choice.sessionId };
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
  options: {
    dormant?: boolean;
    commands?: () => SlashCommand[];
    mode?: () => string | undefined;
    session?: () => string | undefined;
    cycleMode?: () => string | undefined;
    wokenAgain?: () => void;
    onStart?: (start: Start) => boolean;
  } = {},
): Promise<Inbox | undefined> {
  const { KOMUX_SOCKET: control, KOMUX_PANE_ID: pane, KOMUX_TAB_DIR: dir } = process.env;
  const paneId = Number(pane);
  if (!control || !dir || !Number.isInteger(paneId)) return undefined;
  const path = join(dir, `claude-${paneId}.sock`);
  rmSync(path, { force: true });
  const buffers = new WeakMap<object, string>();
  let wake: (() => void) | undefined;
  let startWaiting = false;
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        const lines = ((buffers.get(socket) ?? "") + data.toString()).split("\n");
        buffers.set(socket, lines.pop()!);
        for (const line of lines) {
          try {
            const { text, wake: woken, commands, cycleMode, start } = JSON.parse(line) as { text?: unknown; wake?: unknown; commands?: unknown; cycleMode?: unknown; start?: { resume?: unknown; prompt?: unknown } };
            if (start && typeof start === "object" && options.onStart) {
              const taken = options.onStart({ ...(typeof start.resume === "string" ? { resume: start.resume } : {}), ...(typeof start.prompt === "string" && start.prompt.trim() ? { prompt: start.prompt } : {}) });
              if (taken && wake) wake();
              else if (taken) startWaiting = true;
            } else if (cycleMode === true) socket.write(`${JSON.stringify({ mode: options.cycleMode?.() })}\n`);
            else if (commands === true) socket.write(`${JSON.stringify({ commands: options.commands?.() ?? [], mode: options.mode?.(), session: options.session?.() })}\n`);
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
      if (startWaiting) {
        startWaiting = false;
        resolve();
        return;
      }
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
  await composeMessage(renderer, name, {
    load: () => askInbox(socket, { commands: true }),
    cycleMode: () => askInbox(socket, { cycleMode: true }),
    send: (message) => deliver(socket, withContext(message.attachments, message.text)),
    hide: hideOwnPopup,
    listen: listenForAttachments,
    attached: attachments,
  });
  renderer.destroy();
  await renderer.closed;
}

async function hideOwnPopup(): Promise<boolean> {
  const { KOMUX_SOCKET: control, KOMUX_PANE_ID: pane } = process.env;
  if (!control || !Number.isInteger(Number(pane))) return false;
  try {
    return (await sendControl(control, { method: "popup.hide", params: { paneId: Number(pane) } }, 1000)).ok;
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return false;
  }
}

function listenForAttachments(attach: (attachments: Attachment[]) => void): () => void {
  const { KOMUX_TAB_DIR: dir, KOMUX_PANE_ID: pane } = process.env;
  const paneId = Number(pane);
  if (!dir || !Number.isInteger(paneId)) return () => {};
  const path = draftSocketPath(dir, paneId);
  rmSync(path, { force: true });
  const buffers = new WeakMap<object, string>();
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        const lines = ((buffers.get(socket) ?? "") + data.toString()).split("\n");
        buffers.set(socket, lines.pop()!);
        for (const line of lines) {
          try {
            const { attach: sent } = JSON.parse(line) as { attach?: unknown };
            if (Array.isArray(sent)) attach(sent.filter((item): item is Attachment => typeof item?.label === "string" && typeof item?.text === "string"));
          } catch {}
        }
      },
    },
  });
  return () => {
    server.stop(true);
    rmSync(path, { force: true });
  };
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

export type InboxInfo = { commands: SlashCommand[]; mode?: string; reached: boolean; session?: string };

type Message = { text: string; attachments: Attachment[] };

export type ComposeIO = {
  load: () => Promise<InboxInfo>;
  cycleMode: () => Promise<InboxInfo>;
  send: (message: Message) => Promise<void>;
  hide: () => Promise<boolean>;
  listen: (attach: (attachments: Attachment[]) => void) => () => void;
  attached: Attachment[];
};

export function composeMessage(renderer: CliRenderer, name: string, io: ComposeIO): Promise<void> {
  return new Promise((resolve) => {
    let commands: SlashCommand[] = [];
    let mode: string | undefined;
    let problem: string | undefined;
    let sending = false;
    const draft = new DraftWatch(Date.now());
    const box = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.raised, paddingRight: 1, paddingTop: 1 });
    const header = new TextRenderable(renderer, { content: composeFooter(undefined), height: 1, flexShrink: 0, wrapMode: "none" });
    const attachments = [...io.attached];
    const chips = new TextRenderable(renderer, { content: chipText(attachments), flexShrink: 0, wrapMode: "word", marginBottom: 1 });
    const empty = () => input.plainText.trim() === "" && attachments.length === 0;
    const showStatus = () => {
      header.content = composeFooter(mode, problem ?? draft.status(empty(), Date.now()));
    };
    const showChips = () => {
      const shown = box.getChildren().includes(chips);
      chips.content = chipText(attachments);
      if (attachments.length === 0 && shown) box.remove(chips);
      if (attachments.length > 0 && !shown) box.insertBefore(chips, completion.list);
    };
    const learn = (found: InboxInfo) => {
      if (found.commands.length > 0) commands = found.commands;
      if (found.mode) mode = found.mode;
      if (found.reached) draft.observe(found.session);
      completion.update();
      showStatus();
    };
    const poll = () => void io.load().then(learn);
    const timer = setInterval(poll, 2000);
    const stopListening = io.listen((sent) => {
      attachments.push(...sent);
      draft.edit(Date.now());
      showChips();
      showStatus();
    });
    const finish = () => {
      clearInterval(timer);
      stopListening();
      resolve();
    };
    const send = () => {
      if (sending) return;
      const text = input.plainText.trim();
      if (!text) return;
      sending = true;
      io.send({ text, attachments }).then(finish, (error: Error) => {
        sending = false;
        problem = `Couldn't send: ${error.message}`;
        showStatus();
      });
    };
    const input: TextareaRenderable = new TextareaRenderable(renderer, {
      flexGrow: 1,
      wrapMode: "word",
      placeholder: `Message ${name}`,
      placeholderColor: theme.faint,
      textColor: theme.text,
      focusedTextColor: theme.text,
      keyBindings: composeKeyBindings,
      onSubmit: send,
      onContentChange: () => {
        if (commands.length === 0 && input.plainText.startsWith("/")) poll();
        draft.edit(Date.now());
        problem = undefined;
        completion.update();
        showStatus();
      },
    });
    const completion = new SlashCompletion(renderer, input, { commands: () => commands, submit: send, quit: false });
    if (attachments.length > 0) box.add(chips);
    box.add(completion.list);
    box.add(input);
    box.add(header);
    renderer.root.add(box);
    input.focus();
    poll();
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (key.name === "tab" && key.shift) {
        key.preventDefault();
        void io.cycleMode().then(learn);
      } else if (key.ctrl && key.name === "c") {
        key.preventDefault();
        finish();
      } else if (key.name === "backspace" && input.plainText === "" && attachments.length > 0) {
        key.preventDefault();
        attachments.pop();
        showChips();
        showStatus();
      } else if (completion.handleKey(key)) key.preventDefault();
      else if (key.name === "escape") {
        if (empty()) return finish();
        void io.hide().then((hidden) => {
          if (!hidden) finish();
        });
      }
    });
  });
}

function chipText(attachments: Attachment[]): StyledText {
  return styled(attachments.flatMap((attachment, index) => [...(index > 0 ? ["  "] : []), bg(theme.surface2)(fg(theme.accent)(` ⌗ ${attachment.label} `))]));
}

const composeHints: [string, string][] = [
  ["/", "commands"],
  ["⏎", "send"],
  ["Alt ⏎", "newline"],
  ["⇧Tab", "mode"],
  ["Esc", "hide"],
  ["Ctrl c", "discard"],
];

function composeFooter(mode: string | undefined, status?: string): StyledText {
  const hints = composeHints.flatMap(([key, label], index) => [...(index > 0 ? ["  "] : []), fg(theme.text)(key), fg(theme.muted)(` ${label}`)]);
  return styled([...(status ? [fg(theme.warning)(status), "    "] : []), ...(mode ? [fg(theme.accent)(`${mode} mode`), "    "] : []), ...hints]);
}

function askInbox(socket: string, request: { commands: true } | { cycleMode: true }, timeoutMs = 1000): Promise<InboxInfo> {
  const unreached: InboxInfo = { commands: [], reached: false };
  return new Promise((resolve) => {
    let buffer = "";
    const timer = setTimeout(() => resolve(unreached), timeoutMs);
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
            const reply = JSON.parse(buffer.slice(0, newline)) as { commands?: unknown; mode?: unknown; session?: unknown };
            done({
              commands: parseCommands(reply.commands),
              mode: typeof reply.mode === "string" ? reply.mode : undefined,
              reached: "commands" in reply,
              session: typeof reply.session === "string" ? reply.session : undefined,
            });
          } catch {
            done(unreached);
          }
        },
        error: () => done(unreached),
      },
    }).catch(() => done(unreached));
  });
}
