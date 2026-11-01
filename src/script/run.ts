import { selfCommand } from "../ask/hosts.ts";
import { sendControl, type ControlRequest } from "../mux/control.ts";
import { transpile } from "./sandbox.ts";
import { ScriptLaunchError, ScriptStore, type ScriptMeta } from "./store.ts";

export type StartOptions = { name?: string; show?: boolean; dock?: boolean; cwd?: string };

export async function startScript(store: ScriptStore, source: string, input: unknown, options: StartOptions = {}, env: Record<string, string | undefined> = process.env): Promise<ScriptMeta> {
  const socket = env.QMUX_SOCKET;
  const near = Number(env.QMUX_PANE_ID);
  if (!socket || !Number.isInteger(near)) throw new ScriptLaunchError("qmux scripts run from inside a qmux pane");
  try {
    transpile(source);
  } catch (error) {
    throw new ScriptLaunchError((error as Error).message);
  }
  const name = options.name ?? "script";
  const meta = store.create(source, input, { name, show: options.show ?? false, dock: options.dock ?? false });
  const { jobId } = (await control(socket, { method: "job.run", params: { command: [...selfCommand(), "script", "host", meta.id], near, name, cwd: options.cwd ?? process.cwd() } })) as { jobId: number };
  store.updateMeta(meta.id, { socket, jobId });
  return { ...meta, socket, jobId };
}

export async function stopScript(store: ScriptStore, id: string): Promise<void> {
  const meta = store.meta(id);
  const status = store.status(id);
  if (status !== "running" && status !== "starting") return;
  if (meta.socket && meta.jobId !== undefined) {
    const stopped = await control(meta.socket, { method: "job.stop", params: { jobId: meta.jobId } }).then(
      () => true,
      () => false,
    );
    if (stopped) await Bun.sleep(200);
  }
  store.finish(id, { status: "stopped" });
}

async function control(socket: string, request: ControlRequest): Promise<unknown> {
  const response = await sendControl(socket, request).catch((error: Error) => {
    throw new ScriptLaunchError(error.message);
  });
  if (!response.ok) throw new ScriptLaunchError(response.error);
  return response.result;
}
