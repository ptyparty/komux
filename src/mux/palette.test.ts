import { describe, expect, test } from "bun:test";
import { fuzzyScore, paletteEntries, rankEntries } from "./palette.ts";

describe("palette", () => {
  test("ranks exact, prefix, word and substring matches ahead of scattered letters", () => {
    expect(fuzzyScore("tab", "tab")).toBe(0);
    expect(fuzzyScore("new", "new tab")).toBe(1);
    expect(fuzzyScore("tab", "new tab")).toBe(2);
    expect(fuzzyScore("ab", "new tab")).toBe(3);
    expect(fuzzyScore("nt", "new tab")).toBe(4);
    expect(fuzzyScore("zz", "new tab")).toBeUndefined();
  });

  test("lists each komux command once, under its shortest chord", () => {
    const entries = paletteEntries(undefined, undefined);
    const names = entries.map((entry) => entry.name);
    expect(new Set(names.filter((name) => name === "switch tab or open project"))).toHaveProperty("size", 1);
    expect(entries.find((entry) => entry.name === "switch tab or open project")?.keys).toBe("^␣ ␣");
    expect(entries.find((entry) => entry.name === "quit komux")?.keys).toBe("^␣ s Q");
    expect(entries.find((entry) => entry.name === "drawer taller")?.keys).toBe("^␣ p e ↑");
  });

  test("matches an app's commands by the app's name too", () => {
    const entries = paletteEntries(undefined, { pane: 1, keys: { app: "remax", groups: [{ name: "Review", commands: [{ label: "flag hunk", keys: "!" }] }] } });
    expect(rankEntries("remax flag", entries).map((entry) => entry.name)).toEqual(["flag hunk"]);
  });
});
