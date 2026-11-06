import { afterEach, expect, spyOn, test } from "bun:test";
import { writeLog } from "./log.ts";

const write = spyOn(process.stderr, "write").mockImplementation(() => true);

afterEach(() => write.mockClear());

test("writes a string as it is, with a newline", () => {
  writeLog("config.ts: no layout named ide\nsecond line");
  expect(write).toHaveBeenCalledWith("config.ts: no layout named ide\nsecond line\n");
});

test("writes an error with its message and stack", () => {
  writeLog(new Error("queue failed"));
  const written = String(write.mock.calls[0]![0]);
  expect(written).toContain("queue failed");
  expect(written).toContain("log.test.ts");
  expect(written.endsWith("\n")).toBe(true);
});
