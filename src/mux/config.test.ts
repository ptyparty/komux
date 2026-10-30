import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, namedTabs, planLayout, projectLayout } from "./config.ts";
import { paneRects } from "./layout.ts";

const dir = mkdtempSync(join(tmpdir(), "qmux-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

describe("config", () => {
  test("a missing file gives the defaults", async () => {
    expect(await loadConfig(join(dir, "missing.ts"))).toEqual({ config: defaultConfig });
  });

  test("loads layouts and projects from a TypeScript module", async () => {
    const path = writeConfig(
      "good.ts",
      `export default {
        projects: { roots: ["~/work/*/*"], layout: "ide" },
        layouts: { ide: { row: [{ command: ["dev", "claude"], focus: true }, { column: [{ command: ["remax"] }, {}] }] } },
      };`,
    );
    const { config, error } = await loadConfig(path);
    expect(error).toBeUndefined();
    expect(config.projects.layout).toBe("ide");
    expect(Object.keys(config.layouts)).toEqual(["ide"]);
  });

  test("invalid config falls back to defaults with an error", async () => {
    const path = writeConfig("bad.ts", `export default { projects: { layout: "nope" }, colours: true };`);
    const { config, error } = await loadConfig(path);
    expect(config).toEqual(defaultConfig);
    expect(error).toContain("colours");
  });

  test("stack is no longer accepted in layouts", async () => {
    const path = writeConfig("stack.ts", `export default { layouts: { ide: { row: [{}, { stack: [{}, {}] }] } } };`);
    const { config, error } = await loadConfig(path);
    expect(config).toEqual(defaultConfig);
    expect(error).toBeDefined();
  });

  test("a layout can declare services, and projects can pick their own layout", async () => {
    const path = writeConfig(
      "services.ts",
      `export default {
        projects: { layout: "ide", layoutFor: { "dashboard": "dashboard" } },
        layouts: {
          ide: { row: [{}, {}] },
          "dashboard": { jobs: [{ command: ["dashboard", "serve"], name: "server", dock: true }], row: [{ command: ["dashboard", "pane", "stories"] }, {}] },
        },
      };`,
    );
    const { config, error } = await loadConfig(path);
    expect(error).toBeUndefined();
    expect(config.layouts.ide).toEqual({ jobs: [], layout: { row: [{}, {}] } });
    expect(config.layouts["dashboard"]!.jobs).toEqual([{ command: ["dashboard", "serve"], name: "server", dock: true }]);
    expect(config.layouts["dashboard"]!.layout).toEqual({ row: [{ command: ["dashboard", "pane", "stories"] }, {}] });
    expect(projectLayout(config, { name: "dashboard", dir: "/q" })).toBe(config.layouts["dashboard"]);
    expect(projectLayout(config, { name: "penny", dir: "/p" })).toBe(config.layouts.ide);
    expect(projectLayout(config, { name: "penny", dir: "/p", layout: "dashboard" })).toBe(config.layouts["dashboard"]);
    expect(projectLayout(defaultConfig, { name: "penny", dir: "/p" })).toBeUndefined();
  });

  test("named tabs have their own layout and directory, and startup names them", async () => {
    const path = writeConfig(
      "tabs.ts",
      `export default {
        defaultCwd: "/srv",
        layouts: { "dashboard": { row: [{}] } },
        tabs: { "dashboard": { layout: "dashboard", cwd: "~/work/initech/dashboard" }, scratch: { layout: "dashboard" } },
        startup: ["dashboard"],
      };`,
    );
    const { config, error } = await loadConfig(path);
    expect(error).toBeUndefined();
    expect(config.startup).toEqual(["dashboard"]);
    expect(namedTabs(config)).toEqual([
      { name: "dashboard", dir: join(homedir(), "work/initech/dashboard"), layout: "dashboard" },
      { name: "scratch", dir: "/srv", layout: "dashboard" },
    ]);
  });

  test("a layout can say what its drawer runs", async () => {
    const path = writeConfig("drawer.ts", `export default { layouts: { ide: { drawer: { command: ["lazygit"], name: "git", height: 50 }, row: [{}, {}] } } };`);
    const { config, error } = await loadConfig(path);
    expect(error).toBeUndefined();
    expect(config.layouts.ide).toEqual({ jobs: [], drawer: { command: ["lazygit"], name: "git", height: 50 }, layout: { row: [{}, {}] } });
  });

  test("bad jobs and drawers, old services, and unknown project layouts are errors", async () => {
    for (const [name, source] of [
      ["empty-job.ts", `export default { layouts: { a: { jobs: [{ command: [] }], row: [{}] } } };`],
      ["job-key.ts", `export default { layouts: { a: { jobs: [{ command: ["x"], docked: true }], row: [{}] } } };`],
      ["drawer-height.ts", `export default { layouts: { a: { drawer: { height: 95 }, row: [{}] } } };`],
      ["drawer-key.ts", `export default { layouts: { a: { drawer: { cmd: ["x"] }, row: [{}] } } };`],
      ["old-services.ts", `export default { layouts: { a: { services: [{ command: ["x"] }], row: [{}] } } };`],
      ["layout-for.ts", `export default { projects: { layoutFor: { "dashboard": "nope" } } };`],
      ["tab-layout.ts", `export default { tabs: { q: { layout: "nope" } } };`],
      ["startup.ts", `export default { layouts: { a: { row: [{}] } }, tabs: { q: { layout: "a" } }, startup: ["nope"] };`],
    ]) {
      const { config, error } = await loadConfig(writeConfig(name!, source!));
      expect(config).toEqual(defaultConfig);
      expect(error).toBeDefined();
    }
  });

  test("a config that throws falls back to defaults with an error", async () => {
    const { error } = await loadConfig(writeConfig("throws.ts", `throw new Error("boom");`));
    expect(error).toContain("boom");
  });

  test("planning pane tabs", () => {
    let next = 1;
    const plan = planLayout({ row: [{}, { tabs: [{ command: ["remax"] }, {}] }] }, () => next++);
    expect(plan.root).toEqual({
      kind: "split",
      axis: "row",
      children: [
        { kind: "pane", id: 1 },
        { kind: "tabs", panes: [2, 3], selected: 0 },
      ],
    });
  });

  test("a focused pane tab is the one its group shows", () => {
    let next = 1;
    const plan = planLayout({ tabs: [{}, { focus: true }] }, () => next++);
    expect(plan.root).toEqual({ kind: "tabs", panes: [1, 2], selected: 1 });
    expect(plan.focus).toBe(2);
  });

  test("planning a layout allocates panes, shares space equally, and picks the focus", () => {
    let next = 10;
    const plan = planLayout({ row: [{ command: ["dev", "claude"] }, { column: [{ command: ["remax"] }, { focus: true }] }] }, () => next++);
    expect(plan.panes).toEqual([
      { id: 10, command: ["dev", "claude"], name: undefined },
      { id: 11, command: ["remax"], name: undefined },
      { id: 12, command: undefined, name: undefined },
    ]);
    expect(plan.focus).toBe(12);
    const rects = paneRects(plan.root);
    expect(rects.get(10)!.width).toBeCloseTo(1 / 2);
    expect(rects.get(12)).toMatchObject({ y: 0.5, height: 0.5 });
  });
});
