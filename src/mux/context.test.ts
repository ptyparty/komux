import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askContext, type ContextOutcome } from "./context.ts";

const dirs: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "komux-context-"));
  dirs.push(dir);
  return join(dir, "7.sock");
}

function program(path: string, reply: (line: string, write: (message: unknown) => void, close: () => void) => void): string[] {
  const received: string[] = [];
  servers.push(
    Bun.listen({
      unix: path,
      socket: {
        data(socket, data) {
          for (const line of data.toString().split("\n").filter(Boolean)) {
            received.push(line);
            reply(line, (message) => socket.write(`${JSON.stringify(message)}\n`), () => socket.end());
          }
        },
      },
    }),
  );
  return received;
}

function ask(path: string, firstReplyMs = 1000) {
  const hints: string[] = [];
  let request: ReturnType<typeof askContext>;
  const outcome = new Promise<ContextOutcome>((resolve) => {
    request = askContext(path, { picking: (hint) => hints.push(hint), done: resolve }, firstReplyMs);
  });
  return { hints, outcome, cancel: () => request.cancel() };
}

describe("asking a pane for context", () => {
  test("attaches what the program sends", async () => {
    const path = socketPath();
    const received = program(path, (_, write) => write({ attach: [{ label: "plan.md:3", text: "> ship it" }] }));
    expect(await ask(path).outcome).toEqual({ attach: [{ label: "plan.md:3", text: "> ship it" }] });
    expect(received).toEqual(['{"context":1}']);
  });

  test("waits past the first reply while the program picks", async () => {
    const path = socketPath();
    program(path, (_, write) => {
      write({ picking: "Pick a block" });
      setTimeout(() => write({ attach: [{ label: "plan.md:3", text: "> ship it" }] }), 80);
    });
    const request = ask(path, 30);
    expect(await request.outcome).toEqual({ attach: [{ label: "plan.md:3", text: "> ship it" }] });
    expect(request.hints).toEqual(["Pick a block"]);
  });

  test("passes on the program's reason for no context", async () => {
    const path = socketPath();
    program(path, (_, write) => write({ none: "Nothing selected" }));
    expect(await ask(path).outcome).toEqual({ none: "Nothing selected" });
  });

  test("gives up on a program that doesn't answer in time", async () => {
    const path = socketPath();
    program(path, () => {});
    expect(await ask(path, 30).outcome).toEqual({ none: "No context from this pane" });
  });

  test("treats a missing socket as no context", async () => {
    expect(await ask(socketPath()).outcome).toEqual({ none: "No context from this pane" });
  });

  test("removes a stale socket", async () => {
    const path = socketPath();
    writeFileSync(path, "");
    expect(await ask(path).outcome).toEqual({ none: "No context from this pane" });
    expect(existsSync(path)).toBe(false);
  });

  test("cancels when the program closes the connection", async () => {
    const path = socketPath();
    program(path, (_, write, close) => {
      write({ picking: "Pick a block" });
      setTimeout(close, 20);
    });
    expect(await ask(path).outcome).toEqual({ cancelled: true });
  });

  test("tells the program when the user cancels", async () => {
    const path = socketPath();
    let request: ReturnType<typeof ask> | undefined;
    const received = program(path, (line, write) => {
      if (line.includes("context")) {
        write({ picking: "Pick a block" });
        setTimeout(() => request?.cancel(), 20);
      }
    });
    request = ask(path);
    expect(await request.outcome).toEqual({ cancelled: true });
    await Bun.sleep(30);
    expect(received).toEqual(['{"context":1}', '{"cancel":true}']);
  });
});
