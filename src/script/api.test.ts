import { expect, test } from "bun:test";
import { parseCall, parseRequest, scriptForm } from "./api.ts";

test("calls are checked against their shapes", () => {
  expect(parseCall("render", [[{ type: "text", text: "hi" }]])).toEqual({ name: "render", args: [[{ type: "text", text: "hi" }]] });
  expect(() => parseCall("render", [[{ type: "iframe", src: "x" }]])).toThrow("komux.render");
  expect(() => parseCall("exec", ["rm -rf /"])).toThrow("komux.exec");
  expect(() => parseRequest("fetch", ["https://example.com"])).toThrow("komux.fetch");
});

test("script forms can't show pictures, since those read files", () => {
  const form = (element: object) => ({ title: "t", elements: [element] });
  expect(scriptForm(form({ type: "confirm", id: "ok", label: "OK?" })).title).toBe("t");
  expect(() => scriptForm(form({ type: "image", path: "/home/me/.ssh/id_ed25519" }))).toThrow("image or slides");
  expect(() => scriptForm(form({ type: "slides", id: "s", slides: [{ path: "/etc/passwd" }] }))).toThrow("image or slides");
});
