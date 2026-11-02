import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";

export type SandboxHost = {
  call: (name: string, args: unknown[]) => void;
  request: (name: string, args: unknown[]) => Promise<unknown>;
  log: (line: string) => void;
};

export type Limits = { memoryBytes: number; stackBytes: number; turnMs: number; timers: number };

export type Outcome = { status: "exited"; value: unknown } | { status: "error"; error: string } | { status: "stopped" };

export const defaultLimits: Limits = { memoryBytes: 64 * 1024 * 1024, stackBytes: 512 * 1024, turnMs: 100, timers: 1000 };

const minIntervalMs = 16;

const prelude = `(() => {
  const call = globalThis.__call;
  const request = globalThis.__request;
  delete globalThis.__call;
  delete globalThis.__request;
  let onEvent;
  let onMessage;
  globalThis.komux = Object.freeze({
    render: (elements) => call("render", [elements]),
    show: () => call("show", []),
    hide: () => call("hide", []),
    dock: (text = null) => call("dock", [text]),
    tray: (text = null) => call("tray", [text]),
    toast: (text) => call("toast", [String(text)]),
    reply: (value) => call("reply", [value]),
    exit: (value) => call("exit", [value]),
    ask: (form) => request("ask", [form]),
    state: () => request("state", []),
    onEvent: (handler) => { onEvent = handler; },
    onMessage: (handler) => { onMessage = handler; },
  });
  return (kind, value) => {
    const handler = kind === "event" ? onEvent : onMessage;
    if (typeof handler === "function") handler(value);
  };
})()`;

export class Sandbox {
  readonly done: Promise<Outcome>;
  private settle!: (outcome: Outcome) => void;
  private outcome: Outcome | undefined;
  private inTurn = false;
  private released = false;
  private readonly pending = new Set<{ dispose: () => void; alive: boolean }>();
  private readonly timers = new Map<number, { timer: Timer; callback: QuickJSHandle; repeat: boolean }>();
  private nextTimer = 1;
  private deliver!: QuickJSHandle;
  private jsonParse!: QuickJSHandle;
  private jsonStringify!: QuickJSHandle;

  private constructor(
    private readonly vm: QuickJSContext,
    private readonly host: SandboxHost,
    private readonly limits: Limits,
  ) {
    this.done = new Promise((resolve) => (this.settle = resolve));
  }

  static async start(source: string, input: unknown, host: SandboxHost, limits: Limits = defaultLimits): Promise<Sandbox> {
    const quickjs = await getQuickJS();
    const runtime = quickjs.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    const sandbox = new Sandbox(runtime.newContext(), host, limits);
    sandbox.install(input);
    let code: string;
    try {
      code = transpile(source);
    } catch (error) {
      sandbox.finish({ status: "error", error: (error as Error).message });
      return sandbox;
    }
    sandbox.turn(() => sandbox.vm.evalCode(`(async () => {\n${code}\n})().catch((e) => __fail(e));`, "script.ts"));
    return sandbox;
  }

  send(kind: "event" | "message", value: unknown): void {
    this.turn(() => {
      const kindHandle = this.vm.newString(kind);
      const valueHandle = this.fromJson(value);
      const result = this.vm.callFunction(this.deliver, this.vm.undefined, kindHandle, valueHandle);
      kindHandle.dispose();
      valueHandle.dispose();
      return result;
    });
  }

  stop(): void {
    this.finish({ status: "stopped" });
  }

  private finish(outcome: Outcome): void {
    if (this.outcome) return;
    this.outcome = outcome;
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    if (!this.inTurn) this.release();
    this.settle(outcome);
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    for (const { callback } of this.timers.values()) callback.dispose();
    this.timers.clear();
    for (const handle of this.pending) if (handle.alive) handle.dispose();
    for (const handle of [this.deliver, this.jsonParse, this.jsonStringify]) handle?.dispose();
    const runtime = this.vm.runtime;
    this.vm.dispose();
    runtime.dispose();
  }

  private turn(run: () => ReturnType<QuickJSContext["evalCode"]>): void {
    if (this.outcome) return;
    this.inTurn = true;
    try {
      this.vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.limits.turnMs));
      const result = run();
      if (result.error) this.fail(result.error);
      else result.value.dispose();
      if (!this.outcome) {
        const jobs = this.vm.runtime.executePendingJobs();
        if (jobs.error) this.fail(jobs.error);
      }
    } finally {
      this.inTurn = false;
      if (this.outcome) this.release();
    }
  }

  private fail(error: QuickJSHandle): void {
    const dumped = this.vm.dump(error);
    error.dispose();
    const described = describeError(dumped);
    this.finish({ status: "error", error: described.startsWith("InternalError: interrupted") ? described.replace("InternalError: interrupted", `stopped: the script ran for over ${this.limits.turnMs}ms without yielding`) : described });
  }

  private install(input: unknown): void {
    const vm = this.vm;
    const json = vm.getProp(vm.global, "JSON");
    this.jsonParse = vm.getProp(json, "parse");
    this.jsonStringify = vm.getProp(json, "stringify");
    json.dispose();

    const define = (target: QuickJSHandle, name: string, body: (...args: QuickJSHandle[]) => QuickJSHandle | void) => {
      const handle = vm.newFunction(name, body);
      vm.setProp(target, name, handle);
      handle.dispose();
    };

    define(vm.global, "__call", (name, args) => {
      const callName = vm.getString(name);
      const values = this.toJsonArray(args);
      if (callName === "exit") this.finish({ status: "exited", value: values[0] ?? null });
      else this.host.call(callName, values);
    });
    define(vm.global, "__request", (name, args) => {
      const deferred = vm.newPromise();
      this.pending.add(deferred);
      const settle = (resolve: boolean, value: unknown) =>
        this.turn(() => {
          const handle = resolve ? this.fromJson(value) : vm.newError(String(value));
          (resolve ? deferred.resolve : deferred.reject)(handle);
          handle.dispose();
          deferred.dispose();
          this.pending.delete(deferred);
          return { value: vm.undefined } as ReturnType<QuickJSContext["evalCode"]>;
        });
      this.host.request(vm.getString(name), this.toJsonArray(args)).then(
        (value) => settle(true, value),
        (error: Error) => settle(false, error.message),
      );
      return deferred.handle;
    });
    define(vm.global, "__fail", (error) => void this.fail(error.dup()));

    const consoleObject = vm.newObject();
    for (const level of ["log", "info", "warn", "error"]) {
      define(consoleObject, level, (...args) => void this.host.log(args.map((arg) => describeValue(vm.dump(arg))).join(" ")));
    }
    vm.setProp(vm.global, "console", consoleObject);
    consoleObject.dispose();

    const addTimer = (repeat: boolean) => (handler: QuickJSHandle, delay: QuickJSHandle) => {
      if (vm.typeof(handler) !== "function") throw new TypeError("timer callback must be a function");
      if (this.timers.size >= this.limits.timers) throw new RangeError(`a script may hold at most ${this.limits.timers} timers`);
      const id = this.nextTimer++;
      const requested = Math.max(0, Number(vm.dump(delay)) || 0);
      const ms = repeat ? Math.max(minIntervalMs, requested) : requested;
      const callback = handler.dup();
      const fire = () => {
        this.turn(() => vm.callFunction(callback, vm.undefined));
        if (repeat || !this.timers.delete(id)) return;
        callback.dispose();
      };
      this.timers.set(id, { timer: repeat ? setInterval(fire, ms) : setTimeout(fire, ms), callback, repeat });
      return vm.newNumber(id);
    };
    const clearTimer = (id: QuickJSHandle) => {
      const key = Number(vm.dump(id));
      const entry = this.timers.get(key);
      if (!entry) return;
      this.timers.delete(key);
      clearTimeout(entry.timer);
      entry.callback.dispose();
    };
    define(vm.global, "setTimeout", addTimer(false));
    define(vm.global, "setInterval", addTimer(true));
    define(vm.global, "clearTimeout", clearTimer);
    define(vm.global, "clearInterval", clearTimer);

    const inputHandle = this.fromJson(input);
    vm.setProp(vm.global, "input", inputHandle);
    inputHandle.dispose();

    this.deliver = vm.unwrapResult(vm.evalCode(prelude, "prelude.js"));
  }

  private toJsonArray(handle: QuickJSHandle): unknown[] {
    const value = this.toJson(handle);
    return Array.isArray(value) ? value : [];
  }

  private toJson(handle: QuickJSHandle): unknown {
    const result = this.vm.unwrapResult(this.vm.callFunction(this.jsonStringify, this.vm.undefined, handle));
    const text = this.vm.typeof(result) === "string" ? this.vm.getString(result) : undefined;
    result.dispose();
    return text === undefined ? undefined : JSON.parse(text);
  }

  private fromJson(value: unknown): QuickJSHandle {
    if (value === undefined) return this.vm.undefined;
    const text = this.vm.newString(JSON.stringify(value));
    const result = this.vm.callFunction(this.jsonParse, this.vm.undefined, text);
    text.dispose();
    return this.vm.unwrapResult(result);
  }
}

export function transpile(source: string): string {
  try {
    return new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
  } catch (error) {
    throw new Error(`SyntaxError: ${(error as Error).message}`);
  }
}

function describeError(dumped: unknown): string {
  if (typeof dumped === "object" && dumped !== null && "message" in dumped) {
    const { name, message, stack } = dumped as { name?: string; message?: string; stack?: string };
    return `${name ?? "Error"}: ${message ?? ""}\n${stack ?? ""}`.trim();
  }
  return describeValue(dumped);
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
