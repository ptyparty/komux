import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, runtimeDir } from "../private-dir.ts";
import type { Outcome } from "./sandbox.ts";

export type ScriptMeta = { id: string; name: string; createdAt: string; show: boolean; dock: boolean; socket?: string; jobId?: number };

export type ScriptStatus = "starting" | "running" | "exited" | "error" | "stopped" | "lost";

export type ScriptReport = { id: string; name: string; status: ScriptStatus; replies: unknown[]; value?: unknown; error?: string };

const idPattern = /^[a-z0-9]+-[0-9a-f]{8}$/;
const pruneAgeMs = 24 * 60 * 60 * 1000;
export const maxInputBytes = 1024 * 1024;

export class UnknownScriptError extends Error {
  constructor(id: string) {
    super(`no script with id ${id}`);
  }
}

export class ScriptLaunchError extends Error {}

export function defaultScriptRoot(): string {
  return join(runtimeDir(), "scripts");
}

export class ScriptStore {
  constructor(readonly root: string = defaultScriptRoot()) {
    ensurePrivateDir(root);
  }

  create(source: string, input: unknown, options: { name: string; show: boolean; dock: boolean }): ScriptMeta {
    this.prune();
    const inputText = JSON.stringify(input ?? null);
    if (inputText.length > maxInputBytes) throw new Error(`script input may be at most ${maxInputBytes} bytes`);
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const meta: ScriptMeta = { id, createdAt: new Date().toISOString(), ...options };
    mkdirSync(this.dir(id), { mode: 0o700 });
    writeFileSync(join(this.dir(id), "source.ts"), source);
    writeFileSync(join(this.dir(id), "input.json"), inputText);
    writeFileSync(join(this.dir(id), "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  }

  meta(id: string): ScriptMeta {
    return JSON.parse(readFileSync(join(this.existingDir(id), "meta.json"), "utf8"));
  }

  updateMeta(id: string, change: Partial<ScriptMeta>): void {
    writeFileSync(join(this.existingDir(id), "meta.json"), JSON.stringify({ ...this.meta(id), ...change }, null, 2));
  }

  program(id: string): { source: string; input: unknown } {
    const dir = this.existingDir(id);
    return { source: readFileSync(join(dir, "source.ts"), "utf8"), input: JSON.parse(readFileSync(join(dir, "input.json"), "utf8")) };
  }

  markRunning(id: string, pid: number): void {
    const dir = this.existingDir(id);
    rmSync(join(dir, "outcome.json"), { force: true });
    writeFileSync(join(dir, "pid"), String(pid));
  }

  send(id: string, message: unknown): void {
    if (this.outcome(id)) throw new ScriptLaunchError(`script ${id} has finished`);
    appendFileSync(join(this.existingDir(id), "inbox.jsonl"), `${JSON.stringify(message ?? null)}\n`);
  }

  inbox(id: string, offset: number): { messages: unknown[]; offset: number } {
    const path = join(this.existingDir(id), "inbox.jsonl");
    if (!existsSync(path)) return { messages: [], offset };
    const lines = readFileSync(path, "utf8").split("\n").slice(0, -1);
    return { messages: lines.slice(offset).map((line) => JSON.parse(line)), offset: lines.length };
  }

  reply(id: string, value: unknown): void {
    appendFileSync(join(this.existingDir(id), "replies.jsonl"), `${JSON.stringify(value ?? null)}\n`);
  }

  log(id: string, line: string): void {
    appendFileSync(join(this.existingDir(id), "console.log"), `${line}\n`);
  }

  finish(id: string, outcome: Outcome): void {
    const path = join(this.existingDir(id), "outcome.json");
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(outcome));
  }

  outcome(id: string): Outcome | undefined {
    const path = join(this.existingDir(id), "outcome.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  }

  status(id: string): ScriptStatus {
    const outcome = this.outcome(id);
    if (outcome) return outcome.status;
    const pidPath = join(this.existingDir(id), "pid");
    if (!existsSync(pidPath)) return "starting";
    return alive(Number(readFileSync(pidPath, "utf8"))) ? "running" : "lost";
  }

  take(id: string): ScriptReport {
    const dir = this.existingDir(id);
    const status = this.status(id);
    const outcome = this.outcome(id);
    const path = join(dir, "replies.jsonl");
    const cursorPath = join(dir, "read");
    const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").slice(0, -1) : [];
    const read = existsSync(cursorPath) ? Number(readFileSync(cursorPath, "utf8")) : 0;
    const replies = lines.slice(read).map((line) => JSON.parse(line));
    if (replies.length > 0) writeFileSync(cursorPath, String(lines.length));
    const report: ScriptReport = { id, name: this.meta(id).name, status, replies };
    if (outcome?.status === "exited") report.value = outcome.value;
    if (outcome?.status === "error") report.error = outcome.error;
    return report;
  }

  async wait(id: string, timeoutMs: number, pollMs = 100): Promise<ScriptReport> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const report = this.take(id);
      const settled = report.replies.length > 0 || !["starting", "running"].includes(report.status);
      if (settled || Date.now() >= deadline) return report;
      await Bun.sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 0)));
    }
  }

  consoleTail(id: string, lines = 20): string[] {
    const path = join(this.existingDir(id), "console.log");
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").slice(0, -1).slice(-lines) : [];
  }

  list(): { meta: ScriptMeta; status: ScriptStatus }[] {
    return this.ids().flatMap((id) => {
      try {
        return [{ meta: this.meta(id), status: this.status(id) }];
      } catch {
        return [];
      }
    });
  }

  private ids(): string[] {
    return readdirSync(this.root).filter((name) => idPattern.test(name) && existsSync(join(this.dir(name), "meta.json")));
  }

  private prune(): void {
    const cutoff = Date.now() - pruneAgeMs;
    for (const id of this.ids()) {
      const status = this.status(id);
      if (status !== "running" && status !== "starting" && statSync(this.dir(id)).mtimeMs < cutoff) rmSync(this.dir(id), { recursive: true, force: true });
    }
  }

  private existingDir(id: string): string {
    if (!idPattern.test(id) || !existsSync(this.dir(id))) throw new UnknownScriptError(id);
    return this.dir(id);
  }

  private dir(id: string): string {
    return join(this.root, id);
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
