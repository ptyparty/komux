import type { Axis, Direction } from "./layout.ts";

export type Mode = "normal" | "leader" | "locked" | "pane" | "tab" | "session" | "tray" | "jobs" | "resize";

export type Command =
  | { type: "mode"; mode: Mode }
  | { type: "pass" }
  | { type: "palette" }
  | { type: "switcher" }
  | { type: "focus"; direction: Direction; spill?: boolean }
  | { type: "cycle-pane"; delta: number }
  | { type: "swap-pane"; direction: Direction }
  | { type: "new-pane"; axis?: Axis }
  | { type: "tab-pane" }
  | { type: "close-pane" }
  | { type: "zoom" }
  | { type: "rename-pane" }
  | { type: "new-tab" }
  | { type: "close-tab" }
  | { type: "restart-tab" }
  | { type: "rename-tab" }
  | { type: "cycle-tab"; delta: number }
  | { type: "move-tab"; delta: number }
  | { type: "go-to-tab"; index: number }
  | { type: "detach" }
  | { type: "close-popup" }
  | { type: "next-attention" }
  | { type: "compose-claude" }
  | { type: "context-claude" }
  | { type: "peek-reply" }
  | { type: "dismiss-toast" }
  | { type: "toggle-job" }
  | { type: "toggle-drawer" }
  | { type: "resize-drawer"; delta: number }
  | { type: "dock-job" }
  | { type: "start-layout-jobs" }
  | { type: "last-tab" }
  | { type: "select-widget"; delta: number }
  | { type: "open-widget" }
  | { type: "run-job" }
  | { type: "background-pane" }
  | { type: "select-job"; delta: number }
  | { type: "open-job" }
  | { type: "hide-job" }
  | { type: "rerun-job" }
  | { type: "promote-job" }
  | { type: "close-job" }
  | { type: "quit" };

export type Binding = { keys: string[]; command: Command; then?: Mode; name?: string };

export type Hint = { keys: string; description: string };

export type Key = { name: string; ctrl: boolean; meta: boolean; shift: boolean };

export type KeyGroup = { title: string; hints: Hint[] };

type ModeKeys = { title: string; about: string; bindings: Binding[]; hints: Hint[] };

export const leaderKey = "ctrl+space";
export const leaderLabel = "^␣";

const dvorak: Record<Direction, string> = { left: "h", up: "t", down: "n", right: "s" };
const vim: Record<Direction, string> = { left: "h", down: "j", up: "k", right: "l" };

const backToNormal: Binding = { keys: ["escape", "return"], command: { type: "mode", mode: "normal" } };

function directional(letters: Record<Direction, string>, prefix: string, name: string, command: (direction: Direction) => Command): Binding[] {
  return (Object.entries(letters) as [Direction, string][]).map(([direction, letter]) => ({
    keys: [`${prefix}${letter}`, `${prefix}${direction}`],
    command: command(direction),
    name: `${name} ${direction}`,
  }));
}

function goToTabs(prefix: string, then?: Mode): Binding[] {
  return Array.from({ length: 9 }, (_, index): Binding => ({ keys: [`${prefix}${index + 1}`], command: { type: "go-to-tab", index }, then }));
}

const enterMode = (key: string, mode: Mode, name: string): Binding => ({ keys: [key], command: { type: "mode", mode }, name });

export const keymap: Record<Mode, ModeKeys> = {
  normal: {
    title: "normal",
    about: "keys go to the pane",
    bindings: [
      { keys: [leaderKey], command: { type: "mode", mode: "leader" } },
      ...directional(dvorak, "alt+", "focus", (direction) => ({ type: "focus", direction, spill: true })),
      ...goToTabs("alt+"),
      { keys: ["alt+o"], command: { type: "cycle-pane", delta: -1 }, name: "previous pane" },
      { keys: ["alt+e"], command: { type: "cycle-pane", delta: 1 }, name: "next pane" },
      { keys: ["alt+a"], command: { type: "next-attention" }, name: "next agent needing you" },
      { keys: ["alt+c"], command: { type: "compose-claude" }, name: "message Claude" },
      { keys: ["alt+shift+c", "alt+shift+C"], command: { type: "context-claude" }, name: "message Claude about this" },
      { keys: ["alt+p"], command: { type: "peek-reply" }, name: "peek at a reply" },
      { keys: ["alt+x"], command: { type: "dismiss-toast" }, name: "dismiss the top toast" },
      { keys: ["alt+j"], command: { type: "toggle-job" }, name: "hide or reopen a job or question" },
      { keys: ["alt+d"], command: { type: "toggle-drawer" }, name: "shell drawer" },
    ],
    hints: [],
  },
  leader: {
    title: "Ctrl Space",
    about: "komux",
    bindings: [
      enterMode("p", "pane", "pane mode"),
      enterMode("t", "tab", "tab mode"),
      enterMode("j", "jobs", "jobs mode"),
      enterMode("s", "session", "session mode"),
      enterMode("w", "tray", "tray"),
      enterMode("l", "locked", "lock keys"),
      { keys: ["space", "o"], command: { type: "switcher" }, then: "normal", name: "switch tab or open project" },
      ...goToTabs("", "normal"),
      { keys: ["a"], command: { type: "last-tab" }, then: "normal", name: "last tab" },
      ...(Object.keys(dvorak) as Direction[]).map((direction): Binding => ({ keys: [direction], command: { type: "focus", direction }, then: "normal" })),
      { keys: ["n"], command: { type: "new-pane" }, then: "normal", name: "new pane" },
      { keys: ["x"], command: { type: "close-pane" }, then: "normal", name: "close pane" },
      { keys: ["f"], command: { type: "zoom" }, then: "normal", name: "zoom pane" },
      { keys: ["r"], command: { type: "run-job" }, then: "normal", name: "run a job" },
      { keys: ["b"], command: { type: "background-pane" }, then: "normal", name: "send this pane to the background" },
      { keys: ["c"], command: { type: "compose-claude" }, then: "normal" },
      { keys: ["shift+c"], command: { type: "context-claude" }, then: "normal" },
      { keys: ["v"], command: { type: "peek-reply" }, then: "normal" },
      { keys: ["g"], command: { type: "next-attention" }, then: "normal" },
      { keys: ["d"], command: { type: "detach" }, then: "normal", name: "detach" },
      { keys: ["?", "/"], command: { type: "palette" } },
      { keys: [leaderKey], command: { type: "pass" } },
      { keys: ["escape"], command: { type: "mode", mode: "normal" } },
    ],
    hints: [],
  },
  locked: {
    title: "locked",
    about: "all keys go to the pane",
    bindings: [],
    hints: [{ keys: `${leaderLabel} l`, description: "unlock" }],
  },
  pane: {
    title: "pane",
    about: "split, close and arrange panes",
    bindings: [
      ...directional(vim, "", "focus", (direction) => ({ type: "focus", direction })),
      ...directional(dvorak, "alt+", "move pane", (direction) => ({ type: "swap-pane", direction })),
      { keys: ["p"], command: { type: "cycle-pane", delta: 1 } },
      { keys: ["n"], command: { type: "new-pane" }, then: "normal", name: "new pane" },
      { keys: ["d"], command: { type: "new-pane", axis: "column" }, then: "normal", name: "new pane below" },
      { keys: ["r"], command: { type: "new-pane", axis: "row" }, then: "normal", name: "new pane right" },
      { keys: ["s"], command: { type: "tab-pane" }, then: "normal", name: "new pane tab" },
      { keys: ["x"], command: { type: "close-pane" }, then: "normal", name: "close pane" },
      { keys: ["f"], command: { type: "zoom" }, then: "normal", name: "zoom pane" },
      { keys: ["c"], command: { type: "rename-pane" }, then: "normal", name: "rename pane" },
      { keys: ["e"], command: { type: "mode", mode: "resize" }, name: "resize the drawer" },
      { keys: ["?"], command: { type: "palette" } },
      backToNormal,
    ],
    hints: [
      { keys: "←↓↑→/hjkl", description: "focus" },
      { keys: "Alt h/t/n/s", description: "move" },
      { keys: "n", description: "new" },
      { keys: "d", description: "new below" },
      { keys: "r", description: "new right" },
      { keys: "s", description: "new pane tab" },
      { keys: "x", description: "close" },
      { keys: "f", description: "zoom" },
      { keys: "c", description: "rename" },
      { keys: "e", description: "resize drawer" },
    ],
  },
  tab: {
    title: "tab",
    about: "switch, arrange and manage tabs",
    bindings: [
      { keys: ["h", "left", "up"], command: { type: "cycle-tab", delta: -1 }, name: "previous tab" },
      { keys: ["s", "right", "down"], command: { type: "cycle-tab", delta: 1 }, name: "next tab" },
      { keys: ["t"], command: { type: "move-tab", delta: -1 }, name: "move tab left" },
      { keys: ["n"], command: { type: "move-tab", delta: 1 }, name: "move tab right" },
      { keys: ["space", "o"], command: { type: "switcher" }, then: "normal", name: "switch tab or open project" },
      { keys: ["c"], command: { type: "new-tab" }, then: "normal", name: "new tab" },
      { keys: ["x"], command: { type: "close-tab" }, then: "normal", name: "close tab" },
      { keys: ["r"], command: { type: "rename-tab" }, then: "normal", name: "rename tab" },
      { keys: ["shift+r"], command: { type: "restart-tab" }, then: "normal", name: "restart tab" },
      { keys: ["a"], command: { type: "last-tab" }, then: "normal", name: "last tab" },
      { keys: ["w"], command: { type: "mode", mode: "tray" } },
      ...goToTabs("", "normal"),
      { keys: ["?"], command: { type: "palette" } },
      backToNormal,
    ],
    hints: [
      { keys: "h s", description: "prev/next" },
      { keys: "t n", description: "move tab" },
      { keys: "1–9", description: "go to" },
      { keys: "␣", description: "switcher" },
      { keys: "a", description: "last" },
      { keys: "c", description: "new" },
      { keys: "x", description: "close" },
      { keys: "r", description: "rename" },
      { keys: "R", description: "restart" },
      { keys: "o", description: "open project" },
    ],
  },
  tray: {
    title: "tray",
    about: "pick a tray widget",
    bindings: [
      { keys: ["h", "left", "up"], command: { type: "select-widget", delta: -1 }, name: "previous widget" },
      { keys: ["s", "right", "down"], command: { type: "select-widget", delta: 1 }, name: "next widget" },
      { keys: ["return"], command: { type: "open-widget" }, then: "normal", name: "open widget" },
      { keys: ["?"], command: { type: "palette" } },
      { keys: ["escape"], command: { type: "mode", mode: "normal" } },
    ],
    hints: [
      { keys: "h s", description: "prev/next widget" },
      { keys: "Enter", description: "open" },
    ],
  },
  jobs: {
    title: "jobs",
    about: "run and manage this tab's jobs",
    bindings: [
      { keys: ["n"], command: { type: "run-job" }, then: "normal", name: "run a job" },
      { keys: ["b"], command: { type: "background-pane" }, then: "normal", name: "send this pane to the background" },
      { keys: ["up"], command: { type: "select-job", delta: -1 } },
      { keys: ["down"], command: { type: "select-job", delta: 1 } },
      { keys: ["return"], command: { type: "open-job" }, then: "normal", name: "open job" },
      { keys: ["h"], command: { type: "hide-job" }, then: "normal", name: "hide job" },
      { keys: ["r"], command: { type: "rerun-job" }, name: "rerun job" },
      { keys: ["p"], command: { type: "promote-job" }, then: "normal", name: "move job to a pane" },
      { keys: ["d"], command: { type: "dock-job" }, name: "dock or undock job" },
      { keys: ["s"], command: { type: "start-layout-jobs" }, then: "normal", name: "start layout jobs" },
      { keys: ["x"], command: { type: "close-job" }, name: "close job" },
      { keys: ["?"], command: { type: "palette" } },
      { keys: ["escape"], command: { type: "mode", mode: "normal" } },
    ],
    hints: [
      { keys: "n", description: "new job" },
      { keys: "b", description: "background this pane" },
      { keys: "↑↓", description: "select" },
      { keys: "Enter", description: "open" },
      { keys: "h", description: "hide" },
      { keys: "r", description: "rerun" },
      { keys: "p", description: "to pane" },
      { keys: "d", description: "dock" },
      { keys: "s", description: "start layout jobs" },
      { keys: "x", description: "close" },
    ],
  },
  resize: {
    title: "resize",
    about: "drawer height",
    bindings: [
      { keys: ["up", "k", "t"], command: { type: "resize-drawer", delta: 1 }, name: "drawer taller" },
      { keys: ["down", "j", "n"], command: { type: "resize-drawer", delta: -1 }, name: "drawer shorter" },
      { keys: ["?"], command: { type: "palette" } },
      backToNormal,
    ],
    hints: [
      { keys: "↑/k/t", description: "taller" },
      { keys: "↓/j/n", description: "shorter" },
    ],
  },
  session: {
    title: "session",
    about: "this komux session",
    bindings: [
      { keys: ["d"], command: { type: "detach" }, then: "normal", name: "detach" },
      { keys: ["x"], command: { type: "close-popup" }, then: "normal", name: "close popup" },
      { keys: ["shift+q"], command: { type: "quit" }, name: "quit komux" },
      { keys: ["?"], command: { type: "palette" } },
      backToNormal,
    ],
    hints: [
      { keys: "d", description: "detach" },
      { keys: "x", description: "close popup" },
      { keys: "Q", description: "quit" },
    ],
  },
};

export const leaderGroups: KeyGroup[] = [
  {
    title: "Tabs",
    hints: [
      { keys: "␣", description: "switch…" },
      { keys: "1–9", description: "go to tab" },
      { keys: "a", description: "last tab" },
      { keys: "t", description: "tabs…" },
    ],
  },
  {
    title: "Panes",
    hints: [
      { keys: "←↓↑→", description: "focus" },
      { keys: "n", description: "new pane" },
      { keys: "x", description: "close pane" },
      { keys: "f", description: "zoom" },
      { keys: "p", description: "panes…" },
    ],
  },
  {
    title: "Jobs",
    hints: [
      { keys: "r", description: "run a job" },
      { keys: "b", description: "background" },
      { keys: "j", description: "jobs…" },
    ],
  },
  {
    title: "Claude",
    hints: [
      { keys: "c", description: "message" },
      { keys: "C", description: "about this" },
      { keys: "v", description: "peek reply" },
      { keys: "g", description: "needs you" },
    ],
  },
  {
    title: "Session",
    hints: [
      { keys: "d", description: "detach" },
      { keys: "l", description: "lock keys" },
      { keys: "w", description: "tray…" },
      { keys: "s", description: "session…" },
    ],
  },
];

export const withoutLeader: Hint[] = [
  { keys: "Alt h/t/n/s", description: "focus" },
  { keys: "Alt 1–9", description: "tab" },
  { keys: "Alt c", description: "Claude" },
  { keys: "Alt p", description: "peek" },
  { keys: "Alt j", description: "job" },
  { keys: "Alt d", description: "drawer" },
  { keys: "Alt a", description: "needs you" },
];

export function keyName(key: Key): string {
  const modifiers = [key.ctrl && "ctrl", key.meta && "alt", key.shift && "shift"].filter(Boolean);
  return [...modifiers, key.name].join("+");
}

export function lookup(mode: Mode, key: Key): Binding | undefined {
  const name = keyName(key);
  return keymap[mode].bindings.find((binding) => binding.keys.includes(name));
}

export function hints(mode: Mode): Hint[] {
  return keymap[mode].hints;
}

const keyLabels: Record<string, string> = {
  space: "␣",
  return: "Enter",
  escape: "Esc",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  [leaderKey]: leaderLabel,
};

export function showKey(name: string): string {
  if (Object.hasOwn(keyLabels, name)) return keyLabels[name]!;
  const parts = name.split("+");
  const base = parts.pop()!;
  const shifted = parts.includes("shift") && base.length === 1 ? base.toUpperCase() : (keyLabels[base] ?? base);
  const prefix = [parts.includes("ctrl") && "^", parts.includes("alt") && "Alt "].filter(Boolean).join("");
  return `${prefix}${shifted}`;
}

export type KomuxCommand = { name: string; keys: string; mode: Mode; binding: Binding };

export function komuxCommands(scope?: Mode): KomuxCommand[] {
  const chords = modeChords();
  const modes = scope ? [scope] : (Object.keys(keymap) as Mode[]).filter((mode) => chords.has(mode)).sort((a, b) => chords.get(a)!.length - chords.get(b)!.length);
  const seen = new Set<string>();
  const commands: KomuxCommand[] = [];
  for (const mode of modes) {
    for (const binding of keymap[mode].bindings) {
      if (!binding.name) continue;
      const id = JSON.stringify(binding.command);
      if (seen.has(id)) continue;
      seen.add(id);
      const prefix = scope ? "" : chords.get(mode)!;
      commands.push({ name: binding.name, keys: [prefix, showKey(binding.keys[0]!)].filter(Boolean).join(" "), mode, binding });
    }
  }
  return commands;
}

function modeChords(): Map<Mode, string> {
  const chords = new Map<Mode, string>([["normal", ""]]);
  const queue: Mode[] = ["normal"];
  for (let mode = queue.shift(); mode !== undefined; mode = queue.shift()) {
    for (const binding of keymap[mode].bindings) {
      if (binding.command.type !== "mode" || binding.then || chords.has(binding.command.mode)) continue;
      chords.set(binding.command.mode, [chords.get(mode), showKey(binding.keys[0]!)].filter(Boolean).join(" "));
      queue.push(binding.command.mode);
    }
  }
  return chords;
}
