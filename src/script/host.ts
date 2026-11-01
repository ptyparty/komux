import { createCliRenderer } from "@opentui/core";
import { ask, askOwner } from "../ask/ask.ts";
import { AskStore } from "../ask/store.ts";
import { sendControl, type ControlRequest } from "../mux/control.ts";
import { oneLine, scriptForm, type ScriptCall, type ScriptRequest } from "./api.ts";
import { PanelView } from "./panel-view.ts";
import type { Outcome } from "./sandbox.ts";
import { ScriptStore } from "./store.ts";
import { heartbeatMs, type FromWorker, type ToWorker } from "./protocol.ts";

const stallMs = 2000;
const inboxPollMs = 100;
const toastGapMs = 1000;

export async function runScriptHost(id: string): Promise<void> {
  const store = new ScriptStore();
  const meta = store.meta(id);
  const { source, input } = store.program(id);
  const socket = process.env.QMUX_SOCKET;
  const jobId = Number(process.env.QMUX_JOB);
  if (!socket || !Number.isInteger(jobId)) throw new Error("qmux script host runs as a qmux job; use qmux script run");
  store.markRunning(id, process.pid);

  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
  const send = (message: ToWorker) => worker.postMessage(message);
  const view = new PanelView(renderer, (event) => send({ type: "deliver", kind: "event", value: event }));
  const asks = new AbortController();
  let lastBeat = Date.now();
  let lastToast = Number.NEGATIVE_INFINITY;
  let inboxOffset = store.inbox(id, 0).offset;
  let finished = false;

  const control = async (request: ControlRequest): Promise<unknown> => {
    const response = await sendControl(socket, request);
    if (!response.ok) throw new Error(response.error.includes("Invalid input") ? "this qmux session is older than qmux script; restart it to use scripts" : response.error);
    return response.result;
  };
  const report = (error: Error) => {
    store.log(id, `qmux: ${error.message}`);
    view.status(error.message);
  };

  const finish = async (outcome: Outcome) => {
    if (finished) return;
    finished = true;
    clearInterval(watchdog);
    clearInterval(inbox);
    asks.abort();
    worker.terminate();
    store.finish(id, outcome);
    view.destroy();
    renderer.destroy();
    await Promise.allSettled([control({ method: "script.tray", params: { paneId: jobId, text: null } }), control({ method: "job.dock", params: { jobId, text: null } })]);
    if (outcome.status === "error") console.error(`${meta.name} failed:\n${outcome.error}`);
    else console.log(`${meta.name} ${outcome.status}`);
    process.exit(outcome.status === "error" ? 1 : 0);
  };

  const call = (request: ScriptCall) => {
    switch (request.name) {
      case "render":
        view.render(request.args[0]);
        return;
      case "show":
        void control({ method: "pane.focus", params: { paneId: jobId, onlyJob: true } }).catch(report);
        return;
      case "hide":
        void control({ method: "job.hide", params: { jobId } }).catch(report);
        return;
      case "dock":
        void control({ method: "job.dock", params: { jobId, text: request.args[0] === null ? null : oneLine(request.args[0]) } }).catch(report);
        return;
      case "tray":
        void control({ method: "script.tray", params: { paneId: jobId, text: request.args[0] === null ? null : oneLine(request.args[0]) } }).catch(report);
        return;
      case "toast": {
        const now = Date.now();
        if (now - lastToast < toastGapMs) return;
        lastToast = now;
        void control({ method: "script.toast", params: { paneId: jobId, text: oneLine(request.args[0]) } }).catch(report);
        return;
      }
      case "reply":
        store.reply(id, request.args[0]);
        return;
    }
  };

  const answer = async (request: ScriptRequest): Promise<unknown> => {
    switch (request.name) {
      case "ask": {
        const form = scriptForm(request.args[0]);
        const { shown } = (await control({ method: "script.state", params: { paneId: jobId } })) as { shown?: boolean };
        if (shown) await control({ method: "job.hide", params: { jobId } });
        try {
          const askStore = new AskStore();
          const outcome = await ask(askStore, form, "qmux", 0, { owner: askOwner(process.env), signal: asks.signal });
          if (outcome.status.status !== "pending") return outcome.status;
          return await askStore.settled(outcome.id, { signal: asks.signal });
        } finally {
          if (shown && !finished) await control({ method: "pane.focus", params: { paneId: jobId, onlyJob: true } }).catch(report);
        }
      }
      case "state":
        return control({ method: "script.state", params: { paneId: jobId } });
    }
  };

  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    switch (message.type) {
      case "heartbeat":
        lastBeat = Date.now();
        return;
      case "call":
        call(message.call);
        return;
      case "request":
        answer(message.request).then(
          (value) => send({ type: "result", id: message.id, ok: true, value }),
          (error: Error) => send({ type: "result", id: message.id, ok: false, error: error.message }),
        );
        return;
      case "log":
        store.log(id, message.line);
        return;
      case "done":
        void finish(message.outcome);
        return;
    }
  };
  worker.onerror = (event) => void finish({ status: "error", error: `script host failed: ${event.message}` });

  const watchdog = setInterval(() => {
    if (Date.now() - lastBeat > stallMs) void finish({ status: "error", error: `stopped: the script ran for over ${stallMs / 1000}s without yielding` });
  }, heartbeatMs);
  const inbox = setInterval(() => {
    const { messages, offset } = store.inbox(id, inboxOffset);
    inboxOffset = offset;
    for (const value of messages) send({ type: "deliver", kind: "message", value });
  }, inboxPollMs);
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(signal, () => void finish({ status: "stopped" }));

  if (meta.dock) await control({ method: "job.dock", params: { jobId, text: "starting…" } }).catch(report);
  if (meta.show) await control({ method: "pane.focus", params: { paneId: jobId, onlyJob: true } }).catch(report);
  send({ type: "start", source, input });
}
