import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecentTabs, loadRecentTabs, saveRecentTabs } from "./recent.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "komux-recent-"));
  dirs.push(dir);
  return dir;
}

describe("recent tabs", () => {
  test("survive a save and a load", () => {
    const path = join(scratch(), "state", "recent-tabs.json");
    const tabs = [{ title: "merlin #12", project: { name: "merlin", dir: "/w/merlin", layout: "pr-review" }, args: { pr: "12" }, at: 5 }];
    saveRecentTabs(tabs, path);
    saveRecentTabs(tabs, path);
    expect(loadRecentTabs(path)).toEqual(tabs);
  });

  test("skip entries that don't look right and start empty without a file", () => {
    const path = join(scratch(), "recent-tabs.json");
    expect(loadRecentTabs(path)).toEqual([]);
    writeFileSync(path, JSON.stringify([{ title: "ok", at: 1, project: { name: "ok", dir: "/ok" } }, { title: "bad", at: "x", project: {} }, 7]));
    expect(loadRecentTabs(path)).toEqual([{ title: "ok", at: 1, project: { name: "ok", dir: "/ok" } }]);
  });
});

describe("RecentTabs", () => {
  test("two sessions saving to the same file keep each other's tabs", () => {
    const path = join(scratch(), "recent-tabs.json");
    const first = new RecentTabs(path, 10_000);
    const second = new RecentTabs(path, 10_000);
    first.remember({ title: "merlin", project: { name: "merlin", dir: "/w/merlin" }, at: 1 });
    second.remember({ title: "penguin", project: { name: "penguin", dir: "/w/penguin" }, at: 2 });
    expect(loadRecentTabs(path)).toEqual([]);
    first.flush();
    second.flush();
    first.remember({ title: "api", project: { name: "merlin", dir: "/w/merlin" }, at: 3 });
    first.flush();
    expect(loadRecentTabs(path).map((tab) => tab.title)).toEqual(["api", "penguin"]);
  });
});
