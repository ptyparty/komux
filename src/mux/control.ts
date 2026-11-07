import { rmSync } from "node:fs";
import { z } from "zod";

export const controlRequest = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("popup.open"),
    params: z.object({ title: z.string(), command: z.array(z.string()).min(1), paneId: z.number().int().optional() }),
  }),
  z.object({
    method: z.literal("project.open"),
    params: z.union([
      z.object({ target: z.string().min(1), layout: z.string().min(1).optional(), args: z.record(z.string(), z.string()).default({}) }),
      z.object({ repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/), layout: z.string().min(1).optional(), args: z.record(z.string(), z.string()).default({}) }),
    ]),
  }),
  z.object({
    method: z.literal("agent.state"),
    params: z.object({ paneId: z.number().int(), state: z.enum(["working", "waiting", "done", "clear"]), detail: z.string().optional(), sessionId: z.string().min(1).optional(), reply: z.string().optional(), toast: z.enum(["brief", "none"]).optional(), wakeup: z.boolean().optional() }),
  }),
  z.object({
    method: z.literal("pane.open"),
    params: z.object({
      command: z.array(z.string()).min(1),
      near: z.number().int().optional().describe("The pane to open beside; the focused pane when left out"),
      cwd: z.string().optional().describe("Directory to run the command in; the near pane's when left out"),
      placement: z.enum(["right", "below", "tab", "popup"]).default("right"),
      name: z.string().optional(),
      focus: z.boolean().default(true),
      width: z.number().min(10).max(100).optional().describe("Popup width, percent of the screen"),
      height: z.number().min(10).max(100).optional().describe("Popup height, percent of the screen"),
    }),
  }),
  z.object({
    method: z.literal("job.run"),
    params: z.object({ command: z.array(z.string()).min(1), near: z.number().int(), name: z.string().optional(), cwd: z.string().optional(), env: z.record(z.string(), z.string()).optional(), awaited: z.boolean().optional() }),
  }),
  z.object({ method: z.literal("job.status"), params: z.object({ jobId: z.number().int() }) }),
  z.object({ method: z.literal("job.stop"), params: z.object({ jobId: z.number().int() }) }),
  z.object({ method: z.literal("agent.session"), params: z.object({ paneId: z.number().int(), sessionId: z.string().min(1) }) }),
  z.object({ method: z.literal("claude.sessions") }),
  z.object({ method: z.literal("agent.activity"), params: z.object({ paneId: z.number().int(), text: z.string() }) }),
  z.object({ method: z.literal("agent.mode"), params: z.object({ paneId: z.number().int(), mode: z.string() }) }),
  z.object({ method: z.literal("agent.command"), params: z.object({ paneId: z.number().int(), command: z.string(), background: z.boolean() }) }),
  z.object({ method: z.literal("pane.focus"), params: z.object({ paneId: z.number().int(), closing: z.number().int().optional(), onlyJob: z.boolean().optional() }) }),
  z.object({ method: z.literal("tab.focus"), params: z.object({ tabId: z.number().int() }) }),
  z.object({ method: z.literal("pane.zoom"), params: z.object({ paneId: z.number().int(), zoomed: z.boolean() }) }),
  z.object({ method: z.literal("claude.register"), params: z.object({ paneId: z.number().int(), socket: z.string().min(1).nullable(), dormant: z.boolean().optional() }) }),
  z.object({
    method: z.literal("claude.compose"),
    params: z.object({ paneId: z.number().int(), context: z.object({ text: z.string().min(1), label: z.string().min(1) }).optional() }),
  }),
  z.object({ method: z.literal("agent.prompt"), params: z.object({ paneId: z.number().int(), text: z.string().min(1) }) }),
  z.object({ method: z.literal("popup.hide"), params: z.object({ paneId: z.number().int() }) }),
  z.object({ method: z.literal("job.hide"), params: z.object({ jobId: z.number().int() }) }),
  z.object({ method: z.literal("job.dock"), params: z.object({ jobId: z.number().int(), text: z.string().max(200).nullable() }) }),
  z.object({ method: z.literal("script.tray"), params: z.object({ paneId: z.number().int(), text: z.string().max(200).nullable() }) }),
  z.object({ method: z.literal("script.toast"), params: z.object({ paneId: z.number().int(), text: z.string().max(200) }) }),
  z.object({ method: z.literal("script.state"), params: z.object({ paneId: z.number().int() }) }),
  z.object({
    method: z.literal("tab.badge"),
    params: z.object({
      tabId: z.number().int(),
      owner: z.string().min(1).max(32).refine((owner) => owner !== "komux", "komux is komux's own badge owner"),
      text: z.string().min(1).max(8).nullable().describe("Badge text, or null to clear it"),
      color: z.string().regex(/^(text|muted|accent|ok|warning|error|#[0-9a-fA-F]{6})$/).optional(),
    }),
  }),
  z.object({ method: z.literal("session.info") }),
  z.object({ method: z.literal("session.quit") }),
]);

export type ControlRequest = z.infer<typeof controlRequest>;
export type QuietToast = NonNullable<Extract<ControlRequest, { method: "agent.state" }>["params"]["toast"]>;
export type ControlResponse = { ok: true; result?: unknown } | { ok: false; error: string };
export type ControlHandler = (request: ControlRequest) => ControlResponse | Promise<ControlResponse>;

export class ControlError extends Error {}

export function serveControl(path: string, handler: ControlHandler): { stop: () => void } {
  const buffers = new WeakMap<object, string>();
  const server = Bun.listen({
    unix: path,
    socket: {
      async data(socket, data) {
        const text = (buffers.get(socket) ?? "") + data.toString();
        const lines = text.split("\n");
        buffers.set(socket, lines.pop()!);
        for (const line of lines) {
          if (line.trim() === "") continue;
          socket.write(`${JSON.stringify(await respond(line, handler))}\n`);
        }
      },
    },
  });
  return {
    stop: () => {
      server.stop(true);
      rmSync(path, { force: true });
    },
  };
}

export async function sendControl(path: string, request: ControlRequest, timeoutMs = 3000): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    let received = "";
    const timer = setTimeout(() => reject(new ControlError(`komux did not answer on ${path}`)), timeoutMs);
    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(request)}\n`);
        },
        data(socket, data) {
          received += data.toString();
          const newline = received.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timer);
          socket.end();
          resolve(JSON.parse(received.slice(0, newline)) as ControlResponse);
        },
        error(_socket, error) {
          clearTimeout(timer);
          reject(new ControlError(`could not reach komux on ${path}: ${error.message}`));
        },
      },
    }).catch((error: Error) => {
      clearTimeout(timer);
      reject(new ControlError(`could not reach komux on ${path}: ${error.message}`));
    });
  });
}

async function respond(line: string, handler: ControlHandler): Promise<ControlResponse> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, error: "request is not valid JSON" };
  }
  const parsed = controlRequest.safeParse(json);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  try {
    return await handler(parsed.data);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
