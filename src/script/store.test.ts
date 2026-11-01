import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): ScriptStore {
  const dir = mkdtempSync(join(tmpdir(), "qmux-scripts-"));
  dirs.push(dir);
  return new ScriptStore(join(dir, "scripts"));
}

test("replies are handed out once, and the outcome comes with them", async () => {
  const scripts = store();
  const { id } = scripts.create("qmux.exit(1)", { a: 1 }, { name: "t", show: false, dock: false });
  expect(scripts.program(id)).toEqual({ source: "qmux.exit(1)", input: { a: 1 } });
  expect(scripts.status(id)).toBe("starting");
  scripts.markRunning(id, process.pid);
  scripts.reply(id, { n: 1 });
  scripts.reply(id, { n: 2 });
  expect(scripts.take(id)).toEqual({ id, name: "t", status: "running", replies: [{ n: 1 }, { n: 2 }] });
  expect((await scripts.wait(id, 0)).replies).toEqual([]);
  scripts.finish(id, { status: "exited", value: "v" });
  expect(await scripts.wait(id, 1000)).toEqual({ id, name: "t", status: "exited", replies: [], value: "v" });
});

test("the inbox is read from an offset", () => {
  const scripts = store();
  const { id } = scripts.create("", null, { name: "t", show: false, dock: false });
  scripts.send(id, { a: 1 });
  const first = scripts.inbox(id, 0);
  scripts.send(id, { b: 2 });
  expect(first.messages).toEqual([{ a: 1 }]);
  expect(scripts.inbox(id, first.offset).messages).toEqual([{ b: 2 }]);
  scripts.finish(id, { status: "stopped" });
  expect(() => scripts.send(id, {})).toThrow("has finished");
});

test("a script whose host died is lost", () => {
  const scripts = store();
  const { id } = scripts.create("", null, { name: "t", show: false, dock: false });
  scripts.markRunning(id, 2 ** 22 + 12345);
  expect(scripts.status(id)).toBe("lost");
});

test("unknown ids are refused", () => {
  expect(() => store().meta("../../etc")).toThrow("no script with id");
});

test("running a finished script again clears its outcome but keeps old messages read", () => {
  const scripts = store();
  const { id } = scripts.create("", null, { name: "t", show: false, dock: false });
  scripts.send(id, { old: true });
  scripts.finish(id, { status: "error", error: "x" });
  scripts.markRunning(id, process.pid);
  expect(scripts.status(id)).toBe("running");
  expect(scripts.inbox(id, 0).offset).toBe(1);
});
