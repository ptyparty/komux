type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type PanelElement =
  | { type: "text"; text: string; style?: "plain" | "bold" | "muted" | "accent" | "success" | "warning" | "error" }
  | { type: "markdown"; text: string }
  | { type: "progress"; value: number; max: number; label?: string }
  | { type: "list"; id: string; items: { value: string; text: string; mark?: string; detail?: string }[] }
  | { type: "table"; id?: string; columns: string[]; rows: string[][] }
  | { type: "buttons"; id: string; options: (string | { value: string; label?: string })[] }
  | { type: "divider" };

type PanelEvent = { type: "select"; id: string; value: string } | { type: "key"; key: string };

type AskResult = { status: "submitted"; values: Record<string, Json> } | { status: "cancelled" };

type KomuxState = {
  shown: boolean;
  tabs: { name: string; current: boolean; attention?: "working" | "waiting" | "done" | "failed" }[];
  panes: { name?: string; agent?: "working" | "waiting" | "done" | "failed" }[];
  jobs: { name: string; state: "running" | "succeeded" | "failed"; agent?: "working" | "waiting" | "done" | "failed" }[];
};

declare const input: any;

declare const komux: {
  render(elements: PanelElement[]): void;
  show(): void;
  hide(): void;
  dock(text?: string | null): void;
  tray(text?: string | null): void;
  toast(text: string): void;
  reply(value: Json): void;
  exit(value?: Json): void;
  ask(form: { title: string; description?: string; elements: object[]; submitLabel?: string }): Promise<AskResult>;
  state(): Promise<KomuxState>;
  onEvent(handler: (event: PanelEvent) => void): void;
  onMessage(handler: (message: any) => void): void;
};

declare function setTimeout(callback: () => void, ms?: number): number;
declare function setInterval(callback: () => void, ms?: number): number;
declare function clearTimeout(id: number): void;
declare function clearInterval(id: number): void;
declare const console: { log(...values: unknown[]): void; info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void };
