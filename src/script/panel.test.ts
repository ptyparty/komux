import { expect, test } from "bun:test";
import { PanelController } from "./panel.ts";

const elements = [
  { type: "text" as const, text: "hi" },
  { type: "list" as const, id: "files", items: [{ value: "a", text: "a.ts" }, { value: "b", text: "b.ts" }] },
  { type: "buttons" as const, id: "go", options: ["ok", { value: "no", label: "Cancel" }] },
];

test("arrows move through list items and buttons, wrapping around", () => {
  const panel = new PanelController();
  panel.render(elements);
  expect(panel.focused()).toEqual({ element: 1, id: "files", value: "a" });
  panel.key({ name: "down" });
  panel.key({ name: "down" });
  expect(panel.focused()?.value).toBe("ok");
  panel.key({ name: "right" });
  panel.key({ name: "right" });
  expect(panel.focused()?.value).toBe("a");
  panel.key({ name: "up" });
  expect(panel.focused()?.value).toBe("no");
});

test("Enter selects the focused stop, other keys are reported", () => {
  const panel = new PanelController();
  panel.render(elements);
  panel.key({ name: "down" });
  expect(panel.key({ name: "return" })).toEqual({ type: "select", id: "files", value: "b" });
  expect(panel.key({ name: "q" })).toEqual({ type: "key", key: "q" });
  expect(panel.key({ name: "c", ctrl: true })).toEqual({ type: "key", key: "ctrl+c" });
});

test("re-rendering keeps focus on the same item when it is still there", () => {
  const panel = new PanelController();
  panel.render(elements);
  panel.key({ name: "down" });
  panel.render([{ type: "list", id: "files", items: [{ value: "z", text: "z.ts" }, { value: "b", text: "b.ts" }] }]);
  expect(panel.focused()?.value).toBe("b");
  panel.render([{ type: "text", text: "done" }]);
  expect(panel.focused()).toBeUndefined();
  expect(panel.key({ name: "return" })).toEqual({ type: "key", key: "return" });
});

test("only tables with an id have selectable rows", () => {
  const panel = new PanelController();
  panel.render([{ type: "table", columns: ["a"], rows: [["1"]] }, { type: "table", id: "t", columns: ["a"], rows: [["1"], ["2"]] }]);
  expect(panel.stops.map((stop) => `${stop.id}:${stop.value}`)).toEqual(["t:0", "t:1"]);
});
