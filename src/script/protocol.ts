import type { ScriptCall, ScriptRequest } from "./api.ts";
import type { Outcome } from "./sandbox.ts";

export type ToWorker =
  | { type: "start"; source: string; input: unknown }
  | { type: "deliver"; kind: "event" | "message"; value: unknown }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: string }
  | { type: "stop" };

export type FromWorker =
  | { type: "call"; call: ScriptCall }
  | { type: "request"; id: number; request: ScriptRequest }
  | { type: "log"; line: string }
  | { type: "heartbeat" }
  | { type: "done"; outcome: Outcome };

export const heartbeatMs = 250;
