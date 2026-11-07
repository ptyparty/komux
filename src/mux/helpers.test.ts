import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Helpers } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "komux-helpers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("helpers", () => {
  test("run with the session's environment, and stop with it", async () => {
    const out = join(dir, "out");
    const helpers = new Helpers([["sh", "-c", `echo "$KOMUX_SESSION" > ${out}; sleep 30`]], { KOMUX_SESSION: "main" });
    helpers.start();
    for (let tries = 0; tries < 100; tries++) {
      try {
        if (readFileSync(out, "utf8") === "main\n") break;
      } catch {}
      await Bun.sleep(10);
    }
    expect(readFileSync(out, "utf8")).toBe("main\n");
    helpers.stop();
  });
});
