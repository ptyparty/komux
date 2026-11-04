import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { processCwd } from "./process-cwd.ts";

test("reads this process's working directory", () => {
  expect(processCwd(process.pid)).toBe(realpathSync(process.cwd()));
});

test("returns undefined for a process that does not exist", () => {
  expect(processCwd(2 ** 22 + 12345)).toBeUndefined();
});
