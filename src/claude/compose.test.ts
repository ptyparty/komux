import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { Attachment } from "../mux/context.ts";
import { composeMessage, type ComposeIO } from "./run.ts";

let setup: TestRendererSetup | undefined;

afterEach(async () => {
  await setup?.dispose();
  setup = undefined;
});

async function open(overrides: Partial<ComposeIO> = {}) {
  setup = await createTestRenderer({ width: 100, height: 12, exitOnCtrlC: false });
  const sent: string[] = [];
  let hides = 0;
  let attach: (attachments: Attachment[]) => void = () => {};
  let finished = false;
  const done = composeMessage(setup.renderer, "Claude", {
    load: async () => ({ commands: [], reached: true, session: "a" }),
    cycleMode: async () => ({ commands: [], reached: true }),
    send: async (message) => void sent.push(message.text),
    hide: async () => {
      hides += 1;
      return true;
    },
    listen: (onAttach) => {
      attach = onAttach;
      return () => {};
    },
    attached: [],
    ...overrides,
  }).then(() => void (finished = true));
  await setup.renderOnce();
  return { setup, sent, hides: () => hides, attach: (items: Attachment[]) => attach(items), finished: () => finished, done };
}

async function frame(setup: TestRendererSetup): Promise<string> {
  await Bun.sleep(80);
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("the Alt c message box", () => {
  test("Esc on an empty box closes it", async () => {
    const box = await open();
    box.setup.mockInput.pressEscape();
    await frame(box.setup);
    expect(box.finished()).toBe(true);
    expect(box.hides()).toBe(0);
  });

  test("Esc with a draft hides the box and keeps it running; Ctrl c discards it", async () => {
    const box = await open();
    await box.setup.mockInput.typeText("half a thought");
    box.setup.mockInput.pressEscape();
    await frame(box.setup);
    expect(box.hides()).toBe(1);
    expect(box.finished()).toBe(false);
    box.setup.mockInput.pressCtrlC();
    await frame(box.setup);
    expect(box.finished()).toBe(true);
    expect(box.sent).toEqual([]);
  });

  test("an old server that can't hide the box closes it as before", async () => {
    const box = await open({ hide: async () => false });
    await box.setup.mockInput.typeText("draft");
    box.setup.mockInput.pressEscape();
    await frame(box.setup);
    expect(box.finished()).toBe(true);
  });

  test("comments sent to an open draft arrive as chips", async () => {
    const box = await open();
    box.attach([{ label: "remax · Fee.hs:12", text: "code" }]);
    box.attach([{ label: "quoll · plan.md", text: "notes" }]);
    const shown = await frame(box.setup);
    expect(shown).toContain("remax · Fee.hs:12");
    expect(shown).toContain("quoll · plan.md");
  });

  test("a failed send keeps the draft and says why", async () => {
    const box = await open({
      send: async () => {
        throw new Error("Claude went away");
      },
    });
    await box.setup.mockInput.typeText("keep me");
    box.setup.mockInput.pressEnter();
    const shown = await frame(box.setup);
    expect(box.finished()).toBe(false);
    expect(shown).toContain("Couldn't send: Claude went away");
    expect(shown).toContain("keep me");
  });
});
