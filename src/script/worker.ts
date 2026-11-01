import { maxRenderBytes, maxReplyBytes, parseCall, parseRequest, ScriptCallError } from "./api.ts";
import { heartbeatMs, type FromWorker, type ToWorker } from "./protocol.ts";
import { Sandbox } from "./sandbox.ts";

declare const self: Worker;

let sandbox: Sandbox | undefined;
const early: { kind: "event" | "message"; value: unknown }[] = [];
let nextRequest = 1;
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

const post = (message: FromWorker) => self.postMessage(message);

setInterval(() => post({ type: "heartbeat" }), heartbeatMs);

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case "start": {
      sandbox = await Sandbox.start(message.source, message.input, {
        call: (name, args) => {
          const call = parseCall(name, args);
          if (call.name === "render" && JSON.stringify(call.args[0]).length > maxRenderBytes) throw new ScriptCallError(`qmux.render: a panel may hold at most ${maxRenderBytes} bytes`);
          if (call.name === "reply" && (JSON.stringify(call.args[0]) ?? "").length > maxReplyBytes) throw new ScriptCallError(`qmux.reply: a reply may hold at most ${maxReplyBytes} bytes`);
          post({ type: "call", call });
        },
        request: (name, args) => {
          const request = parseRequest(name, args);
          const id = nextRequest++;
          post({ type: "request", id, request });
          return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
        },
        log: (line) => post({ type: "log", line }),
      });
      for (const { kind, value } of early.splice(0)) sandbox.send(kind, value);
      post({ type: "done", outcome: await sandbox.done });
      return;
    }
    case "deliver":
      if (sandbox) sandbox.send(message.kind, message.value);
      else early.push({ kind: message.kind, value: message.value });
      return;
    case "result": {
      const entry = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.ok) entry?.resolve(message.value);
      else entry?.reject(new Error(message.error));
      return;
    }
    case "stop":
      sandbox?.stop();
      return;
  }
};
