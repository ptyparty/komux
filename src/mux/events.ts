import { rmSync } from "node:fs";
import type { Socket } from "bun";
import type { PaneId } from "./layout.ts";
import type { AgentState, JobState } from "./workspace.ts";

export type TabFacts = { id: number; number: number; name: string; dir: string };
export type AgentFacts = { paneId: PaneId; tabId: number; state: AgentState | "idle"; name?: string; sessionId?: string };
export type JobFacts = { id: PaneId; tabId: number; name: string; state: JobState; code?: number | null; agent: boolean };
export type ToastFacts = { kind: "reply" | "job"; id: PaneId; tabId: number };
export type World = { tabs: TabFacts[]; focus: { tabId: number; paneId: PaneId } | undefined; agents: AgentFacts[]; jobs: JobFacts[]; toasts: ToastFacts[] };

export type StreamEvent =
  | ({ type: "snapshot" } & World)
  | { type: "tab.opened"; tab: TabFacts }
  | { type: "tab.changed"; tab: TabFacts }
  | { type: "tab.closed"; tabId: number }
  | { type: "focus"; tabId: number; paneId: PaneId }
  | { type: "agent.state"; agent: AgentFacts }
  | { type: "agent.gone"; paneId: PaneId; tabId: number }
  | { type: "job.started"; job: JobFacts }
  | { type: "job.finished"; job: JobFacts }
  | { type: "job.closed"; jobId: PaneId; tabId: number }
  | { type: "toast.shown"; toast: ToastFacts }
  | { type: "toast.dismissed"; toast: ToastFacts };

export const emptyWorld: World = { tabs: [], focus: undefined, agents: [], jobs: [], toasts: [] };

export function worldChanges(before: World, after: World): StreamEvent[] {
  const events: StreamEvent[] = [];
  const oldTabs = new Map(before.tabs.map((tab) => [tab.id, tab]));
  const newTabs = new Map(after.tabs.map((tab) => [tab.id, tab]));
  for (const tab of after.tabs) {
    const old = oldTabs.get(tab.id);
    if (!old) events.push({ type: "tab.opened", tab });
    else if (old.name !== tab.name || old.dir !== tab.dir || old.number !== tab.number) events.push({ type: "tab.changed", tab });
  }

  const oldAgents = new Map(before.agents.map((agent) => [agent.paneId, agent]));
  const newAgents = new Map(after.agents.map((agent) => [agent.paneId, agent]));
  for (const agent of after.agents) {
    const old = oldAgents.get(agent.paneId);
    if (!old || old.state !== agent.state || old.tabId !== agent.tabId || old.sessionId !== agent.sessionId || old.name !== agent.name) events.push({ type: "agent.state", agent });
  }
  for (const agent of before.agents) if (!newAgents.has(agent.paneId)) events.push({ type: "agent.gone", paneId: agent.paneId, tabId: agent.tabId });

  const oldJobs = new Map(before.jobs.map((job) => [job.id, job]));
  const newJobs = new Set(after.jobs.map((job) => job.id));
  for (const job of after.jobs) {
    const old = oldJobs.get(job.id);
    if (job.state === "running" && old?.state !== "running") events.push({ type: "job.started", job });
    if (job.state !== "running" && (!old || old.state === "running")) events.push({ type: "job.finished", job });
  }
  for (const job of before.jobs) if (!newJobs.has(job.id)) events.push({ type: "job.closed", jobId: job.id, tabId: job.tabId });

  const key = (toast: ToastFacts) => `${toast.kind}:${toast.id}`;
  const oldToasts = new Set(before.toasts.map(key));
  const newToasts = new Set(after.toasts.map(key));
  for (const toast of after.toasts) if (!oldToasts.has(key(toast))) events.push({ type: "toast.shown", toast });
  for (const toast of before.toasts) if (!newToasts.has(key(toast))) events.push({ type: "toast.dismissed", toast });

  for (const tab of before.tabs) if (!newTabs.has(tab.id)) events.push({ type: "tab.closed", tabId: tab.id });
  if (after.focus && (before.focus?.tabId !== after.focus.tabId || before.focus.paneId !== after.focus.paneId)) events.push({ type: "focus", ...after.focus });
  return events;
}

export class EventStream {
  private readonly subscribers = new Set<Socket<undefined>>();
  private world: World = emptyWorld;
  private readonly listener: ReturnType<typeof Bun.listen<undefined>>;

  constructor(
    private readonly path: string,
    private readonly session: string,
    private readonly server: string,
    private readonly current: () => World,
    private readonly now: () => number = Date.now,
  ) {
    rmSync(path, { force: true });
    this.listener = Bun.listen<undefined>({
      unix: path,
      socket: {
        open: (socket) => {
          if (this.subscribers.size === 0) this.world = this.current();
          this.subscribers.add(socket);
          socket.write(this.line({ type: "snapshot", ...this.world }));
        },
        data: () => {},
        close: (socket) => void this.subscribers.delete(socket),
        error: (socket) => void this.subscribers.delete(socket),
      },
    });
  }

  get listening(): boolean {
    return this.subscribers.size > 0;
  }

  sync(): void {
    if (this.subscribers.size === 0) return;
    const world = this.current();
    const events = worldChanges(this.world, world);
    this.world = world;
    if (events.length === 0) return;
    const text = events.map((event) => this.line(event)).join("");
    for (const socket of this.subscribers) socket.write(text);
  }

  stop(): void {
    this.listener.stop(true);
    rmSync(this.path, { force: true });
  }

  private line(event: StreamEvent): string {
    return `${JSON.stringify({ session: this.session, server: this.server, at: this.now(), ...event })}\n`;
  }
}
