import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupItems } from "./setup.ts";

let dir: string;
let config: string;
let root: string;
const ours = () => "/home/me/.bun/bin/komux hook";

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "komux-setup-")));
  config = join(dir, "claude");
  root = join(dir, "komux");
  mkdirSync(join(root, "skills", "komux-ask"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "komux" }));
  writeFileSync(join(root, "skills", "komux-ask", "SKILL.md"), "skill");
  mkdirSync(join(root, "rules"), { recursive: true });
  writeFileSync(join(root, "rules", "komux-jobs.md"), "jobs");
  writeFileSync(join(root, "rules", "notes.txt"), "not a rule");
  mkdirSync(join(config, "rules"), { recursive: true });
  writeFileSync(join(config, "rules", "komux-jobs.md"), "mine");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("komux setup", () => {
  test("lists hooks, skills and rules with their state, sets them up, and removes them", async () => {
    const before = await setupItems(config, root, ours);
    expect(before.map((item) => [item.id, item.state])).toEqual([
      ["hooks", "missing"],
      ["skill:komux-ask", "missing"],
      ["rule:komux-jobs", "different"],
    ]);
    for (const item of before) await item.apply();
    expect((await setupItems(config, root, ours)).map((item) => item.state)).toEqual(["installed", "installed", "installed"]);
    expect(readFileSync(join(config, "skills", "komux-ask", "SKILL.md"), "utf8")).toBe("skill");
    expect(readFileSync(join(config, "komux-backup", "rules", "komux-jobs.md"), "utf8")).toBe("mine");
    for (const item of await setupItems(config, root, ours)) await item.remove();
    expect(readFileSync(join(config, "rules", "komux-jobs.md"), "utf8")).toBe("mine");
    expect(existsSync(join(config, "skills", "komux-ask"))).toBe(false);
    expect(JSON.parse(readFileSync(join(config, "settings.json"), "utf8"))).toEqual({});
  });

  test("a broken settings file blocks only the hooks, and local-only hooks are removed too", async () => {
    writeFileSync(join(config, "settings.json"), "{ not json");
    const items = await setupItems(config, root, ours);
    expect(items.map((item) => item.state)).toEqual(["different", "missing", "different"]);
    await expect(items[0]!.apply()).rejects.toThrow("can't read Claude's settings");
    await items[1]!.apply();
    expect(readFileSync(join(config, "skills", "komux-ask", "SKILL.md"), "utf8")).toBe("skill");
    rmSync(join(config, "settings.json"));
    writeFileSync(join(config, "settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: ours() }] }] } }));
    const [hooks] = await setupItems(config, root, ours);
    expect(await hooks!.remove()).toContain("settings.local.json");
    expect(JSON.parse(readFileSync(join(config, "settings.local.json"), "utf8"))).toEqual({});
  });
});
