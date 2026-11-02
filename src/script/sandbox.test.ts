import { expect, test } from "bun:test";
import { Sandbox, type SandboxHost } from "./sandbox.ts";

function recorder(answers: unknown[] = []) {
  const events: unknown[] = [];
  const host: SandboxHost = {
    call: (name, args) => void events.push({ [name]: args[0] ?? null }),
    request: async (name, args) => {
      events.push({ [name]: args[0] ?? null });
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    log: (line) => void events.push({ log: line }),
  };
  return { events, host };
}

async function run(source: string, input: unknown = null, answers: unknown[] = []) {
  const { events, host } = recorder(answers);
  const sandbox = await Sandbox.start(source, input, host);
  const outcome = await Promise.race([sandbox.done, Bun.sleep(3000).then(() => "still running")]);
  sandbox.stop();
  return { events, outcome };
}

test("the guest sees no host authority", async () => {
  const { events, outcome } = await run(`
    const names = ["fetch", "Bun", "process", "require", "Deno", "WebAssembly", "XMLHttpRequest", "WebSocket", "std", "os", "__call", "__request"];
    komux.reply(names.filter((name) => typeof (globalThis as any)[name] !== "undefined"));
    komux.reply((function () {}).constructor("return typeof process + typeof Bun")());
    try { await import("node:fs"); komux.reply("imported"); } catch (e: any) { komux.reply("import failed"); }
    komux.exit(null);
  `);
  expect(events).toEqual([{ reply: [] }, { reply: "undefinedundefined" }, { reply: "import failed" }]);
  expect(outcome).toEqual({ status: "exited", value: null });
});

test("the komux object can't be replaced or changed", async () => {
  const { outcome } = await run(`
    (komux as any).toast = () => {};
    komux.exit(Object.isFrozen(komux));
  `);
  expect(outcome).toEqual({ status: "exited", value: true });
});

test("a replaced JSON doesn't change what crosses the boundary", async () => {
  const { events } = await run(`
    (globalThis as any).JSON = { stringify: () => "hacked", parse: () => "hacked" };
    komux.reply({ ok: 1 });
    komux.exit(null);
  `);
  expect(events[0]).toEqual({ reply: { ok: 1 } });
});

test("types are stripped and input arrives as JSON", async () => {
  const { outcome } = await run(
    `
    type Step = { name: string };
    const steps: Step[] = input.steps;
    komux.exit(steps.map((s: Step) => s.name.toUpperCase()));
  `,
    { steps: [{ name: "a" }, { name: "b" }] },
  );
  expect(outcome).toEqual({ status: "exited", value: ["A", "B"] });
});

test("a syntax error is reported", async () => {
  const { outcome } = await run(`const = 1`);
  expect(JSON.stringify(outcome)).toContain("SyntaxError");
});

test("requests resolve an awaited promise, and failures reject it", async () => {
  const { events, outcome } = await run(
    `
    const answer: any = await komux.ask({ title: "Pick", elements: [] });
    komux.toast("picked " + answer.values.env);
    try { await komux.state(); } catch (e: any) { komux.exit(e.message); }
  `,
    null,
    [{ status: "submitted", values: { env: "prod" } }, new Error("no state")],
  );
  expect(events).toEqual([{ ask: { title: "Pick", elements: [] } }, { toast: "picked prod" }, { state: null }]);
  expect(outcome).toEqual({ status: "exited", value: "no state" });
});

test("a host call that throws becomes a guest exception", async () => {
  const { host } = recorder();
  const sandbox = await Sandbox.start(`try { komux.render([]); } catch (e: any) { komux.exit("caught " + e.message); }`, null, {
    ...host,
    call: () => {
      throw new Error("bad render");
    },
  });
  expect(await sandbox.done).toEqual({ status: "exited", value: "caught bad render" });
});

test("an uncaught error ends the script", async () => {
  const { outcome } = await run(`setTimeout(() => { throw new Error("boom"); }, 5);`);
  expect(JSON.stringify(outcome)).toContain("boom");
});

test("a busy loop is interrupted", async () => {
  const started = Date.now();
  const { outcome } = await run(`while (true) {}`);
  expect(JSON.stringify(outcome)).toContain("without yielding");
  expect(Date.now() - started).toBeLessThan(500);
});

test("a busy loop in a timer callback is interrupted too", async () => {
  const { events, outcome } = await run(`komux.toast("before"); setTimeout(() => { while (true) {} }, 10);`);
  expect(events).toEqual([{ toast: "before" }]);
  expect(JSON.stringify(outcome)).toContain("without yielding");
});

test("memory is capped", async () => {
  const { outcome } = await run(`const a: number[][] = []; while (true) a.push(new Array(100000).fill(a.length));`);
  expect(JSON.stringify(outcome)).toMatch(/out of memory|without yielding/);
});

test("deep recursion is capped", async () => {
  const { outcome } = await run(`function f(): number { return f() + 1; } f();`);
  expect(JSON.stringify(outcome)).toContain("stack");
});

test("intervals repeat until cleared", async () => {
  const { outcome } = await run(`
    let ticks = 0;
    const id = setInterval(() => {
      ticks += 1;
      if (ticks === 3) { clearInterval(id); setTimeout(() => komux.exit(ticks), 60); }
    }, 1);
  `);
  expect(outcome).toEqual({ status: "exited", value: 3 });
});

test("events and messages reach their handlers, and ones after exit are dropped", async () => {
  const { events, host } = recorder();
  const sandbox = await Sandbox.start(
    `
    komux.onMessage((m: any) => { komux.reply(m.n * 2); if (m.n === 3) komux.exit("bye"); });
    komux.onEvent((e: any) => komux.reply(e));
  `,
    null,
    host,
  );
  sandbox.send("event", { type: "key", key: "x" });
  for (const n of [1, 2, 3]) sandbox.send("message", { n });
  sandbox.send("message", { n: 4 });
  expect(await sandbox.done).toEqual({ status: "exited", value: "bye" });
  expect(events).toEqual([{ reply: { type: "key", key: "x" } }, { reply: 2 }, { reply: 4 }, { reply: 6 }]);
});

test("stopping releases a script with pending timers and requests", async () => {
  const { host } = recorder();
  const sandbox = await Sandbox.start(`setTimeout(() => {}, 10000); setInterval(() => {}, 1000); komux.ask({ title: "x", elements: [] });`, null, { ...host, request: () => new Promise(() => {}) });
  sandbox.stop();
  expect(await sandbox.done).toEqual({ status: "stopped" });
});
