import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyWorld, EventStream, worldChanges, type World } from "./events.ts";

const dir = mkdtempSync(join(tmpdir(), "komux-events-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tab = { id: 1, number: 1, name: "ptyparty", dir: "/work/ptyparty" };
const world: World = {
  tabs: [tab],
  focus: { tabId: 1, paneId: 1 },
  agents: [{ paneId: 2, tabId: 1, state: "working" }],
  jobs: [{ id: 3, tabId: 1, name: "test", state: "running", agent: false }],
  toasts: [],
};

describe("worldChanges", () => {
  test("reports everything new as opened or started", () => {
    expect(worldChanges(emptyWorld, world).map((event) => event.type)).toEqual(["tab.opened", "agent.state", "job.started", "focus"]);
  });

  test("reports an agent's turn ending, a job failing, and its toast", () => {
    const after: World = {
      ...world,
      agents: [{ paneId: 2, tabId: 1, state: "done" }],
      jobs: [{ ...world.jobs[0]!, state: "failed", code: 1 }],
      toasts: [{ kind: "job", id: 3, tabId: 1 }],
    };
    expect(worldChanges(world, after)).toEqual([
      { type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done" } },
      { type: "job.finished", job: { id: 3, tabId: 1, name: "test", state: "failed", code: 1, agent: false } },
      { type: "toast.shown", toast: { kind: "job", id: 3, tabId: 1 } },
    ]);
    expect(worldChanges(after, { ...after, toasts: [] })).toEqual([{ type: "toast.dismissed", toast: { kind: "job", id: 3, tabId: 1 } }]);
  });

  test("reports agents, jobs and tabs that went away", () => {
    expect(worldChanges(world, { ...emptyWorld }).map((event) => event.type)).toEqual(["agent.gone", "job.closed", "tab.closed"]);
  });

  test("reports nothing when nothing changed", () => {
    expect(worldChanges(world, structuredClone(world))).toEqual([]);
  });
});

describe("EventStream", () => {
  test("sends a snapshot to a new subscriber, then changes", async () => {
    let current = world;
    const path = join(dir, "events.sock");
    const stream = new EventStream(path, "main", "s1", () => current, () => 42);
    const lines: unknown[] = [];
    let buffer = "";
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data(_socket, data) {
          buffer += data.toString();
          const parts = buffer.split("\n");
          buffer = parts.pop()!;
          for (const part of parts) lines.push(JSON.parse(part));
        },
      },
    });
    await waitFor(() => lines.length === 1);
    current = { ...world, tabs: [{ ...tab, name: "renamed" }] };
    stream.sync();
    await waitFor(() => lines.length === 2);
    expect(lines).toEqual([
      { session: "main", server: "s1", at: 42, type: "snapshot", ...world },
      { session: "main", server: "s1", at: 42, type: "tab.changed", tab: { ...tab, name: "renamed" } },
    ]);
    socket.end();
    stream.stop();
  });
});

async function waitFor(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !ready(); tries++) await Bun.sleep(10);
  expect(ready()).toBe(true);
}
