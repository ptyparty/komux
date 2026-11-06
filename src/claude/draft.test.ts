import { describe, expect, test } from "bun:test";
import { DraftWatch } from "./draft.ts";

describe("DraftWatch", () => {
  test("an empty box has no status", () => {
    const watch = new DraftWatch(0);
    watch.observe("a");
    watch.observe("b");
    expect(watch.status(true, 3_600_000)).toBeUndefined();
  });

  test("a draft left alone for a minute shows its age, counted from the last edit", () => {
    const watch = new DraftWatch(0);
    expect(watch.status(false, 59_000)).toBeUndefined();
    expect(watch.status(false, 3 * 3_600_000)).toBe("draft · 3h ago");
    watch.edit(3 * 3_600_000);
    expect(watch.status(false, 3 * 3_600_000 + 5 * 60_000)).toBe("draft · 5m ago");
  });

  test("a new conversation behind the draft marks it, and the mark stays", () => {
    const watch = new DraftWatch(0);
    watch.observe("a");
    watch.observe("a");
    expect(watch.status(false, 0)).toBeUndefined();
    watch.observe(undefined);
    expect(watch.status(false, 0)).toBe("written for an earlier conversation");
    watch.observe("a");
    expect(watch.status(false, 120_000)).toBe("draft · 2m ago · written for an earlier conversation");
  });

  test("a conversation that starts after the draft was opened is not a change", () => {
    const watch = new DraftWatch(0);
    watch.observe(undefined);
    watch.observe("a");
    expect(watch.status(false, 0)).toBeUndefined();
  });
});
