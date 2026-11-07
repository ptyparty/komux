import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, defaultConfig, loadConfig, namedTabs, planLayout, projectLayout, projectTab } from "./config.ts";
import { paneRects } from "./layout.ts";

const dir = mkdtempSync(join(tmpdir(), "komux-config-"));
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

  test("a layout can take args and name its tabs", async () => {
    const path = writeConfig(
      "args.ts",
      `export default {
        projects: { layout: "ide" },
        layouts: {
          ide: { name: "{project} ide", row: [{}] },
          "pr-review": { args: ["pr"], name: "{project} #{pr}", row: [{ command: ["remax", "--pr", "{pr}", "{other}"], name: "pr {pr}" }] },
        },
      };`,
    );
    const { config, error } = await loadConfig(path);
    expect(error).toBeUndefined();
    expect(config.layouts["pr-review"]).toEqual({
      jobs: [],
      args: ["pr"],
      name: "{project} #{pr}",
      layout: { row: [{ command: ["remax", "--pr", "{pr}", "{other}"], name: "pr {pr}" }] },
    });
    expect(projectTab(config, { name: "penny", dir: "/p" })).toEqual({ name: "penny ide", layout: { jobs: [], name: "{project} ide", layout: { row: [{}] } } });
    expect(projectTab(config, { name: "penny", dir: "/p", layout: "pr-review" }, { pr: "12" })).toEqual({
      name: "penny #12",
      layout: { jobs: [], args: ["pr"], name: "{project} #{pr}", layout: { row: [{ command: ["remax", "--pr", "12", "{other}"], name: "pr 12" }] } },
    });
    expect(projectTab(defaultConfig, { name: "penny", dir: "/p" })).toEqual({ name: "penny" });
  });

  test("bad jobs, drawers, and args, old services, and unknown project layouts are errors", async () => {
    for (const [name, source] of [
      ["empty-job.ts", `export default { layouts: { a: { jobs: [{ command: [] }], row: [{}] } } };`],
      ["job-key.ts", `export default { layouts: { a: { jobs: [{ command: ["x"], docked: true }], row: [{}] } } };`],
      ["drawer-height.ts", `export default { layouts: { a: { drawer: { height: 95 }, row: [{}] } } };`],
      ["drawer-key.ts", `export default { layouts: { a: { drawer: { cmd: ["x"] }, row: [{}] } } };`],
      ["old-services.ts", `export default { layouts: { a: { services: [{ command: ["x"] }], row: [{}] } } };`],
      ["layout-for.ts", `export default { projects: { layoutFor: { "dashboard": "nope" } } };`],
      ["tab-layout.ts", `export default { tabs: { q: { layout: "nope" } } };`],
      ["startup.ts", `export default { layouts: { a: { row: [{}] } }, tabs: { q: { layout: "a" } }, startup: ["nope"] };`],
      ["arg-name.ts", `export default { layouts: { a: { args: ["project"], row: [{}] } } };`],
      ["args-default.ts", `export default { projects: { layout: "a" }, layouts: { a: { args: ["pr"], row: [{}] } } };`],
      ["args-tab.ts", `export default { layouts: { a: { args: ["pr"], row: [{}] } }, tabs: { q: { layout: "a" } } };`],
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

describe("plugins and keys", () => {
  test("plugins add their tray widgets and keys after the config's own", () => {
    const config = configSchema.parse({
      tray: [{ widget: "clock" }],
      keys: [{ key: "alt+m", popup: ["deal"] }],
      plugins: [{ name: "ponpoko", tray: [{ name: "ponpoko", command: ["ponpoko", "tray"] }], keys: [{ key: "alt+r", tab: ["ponpoko"] }] }],
    });
    expect(config.tray.map((entry) => ("widget" in entry ? entry.widget : entry.name))).toEqual(["clock", "ponpoko"]);
    expect(config.keys.map((binding) => binding.key)).toEqual(["alt+m", "alt+r"]);
    expect("plugins" in config).toBe(false);
  });

  test("refuses komux's own keys and keys bound twice", () => {
    const own = configSchema.safeParse({ keys: [{ key: "alt+n", popup: ["deal"] }] });
    expect(own.success).toBe(false);
    expect(JSON.stringify(own.error?.issues)).toContain("alt+n is komux's focus down");
    const twice = configSchema.safeParse({ keys: [{ key: "alt+m", popup: ["a"] }], plugins: [{ name: "ponpoko", keys: [{ key: "alt+m", popup: ["b"] }] }] });
    expect(JSON.stringify(twice.error?.issues)).toContain("alt+m is already bound by the config");
    expect(configSchema.safeParse({ keys: [{ key: "alt+m" }] }).success).toBe(false);
  });
});
