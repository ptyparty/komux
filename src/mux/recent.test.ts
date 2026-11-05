import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRecentTabs, saveRecentTabs } from "./recent.ts";

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
    const tabs = [{ title: "merlot #12", project: { name: "merlot", dir: "/w/merlot", layout: "pr-review" }, args: { pr: "12" }, at: 5 }];
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
