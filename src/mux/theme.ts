import type { BorderCharacters } from "@opentui/core";

const komux = "#8ea8ff";

export const theme = {
  background: "#15171d",
  surface: "#1b1e26",
  surface2: "#20242d",
  raised: "#262a35",
  line: "#2c313d",
  border: "#2c313d",
  text: "#d5d8e0",
  muted: "#868c9c",
  faint: "#4f5566",
  selection: "#283350",
  accent: komux,
  ok: "#9fd07e",
  warning: "#f0a36a",
  error: "#ef6b6b",
  apps: {
    komux,
    quoll: "#e9b765",
    remax: "#9fd07e",
    kowari: "#66c7c2",
  },
  modes: {
    normal: komux,
    pane: "#66c7c2",
    tab: "#b99cf0",
    session: "#e9b765",
    jobs: "#f2a2c0",
    tray: "#7cc4e8",
    resize: "#c9b27f",
    locked: "#ef6b6b",
  },
  syntax: {
    keyword: "#b99cf0",
    function: komux,
    type: "#66c7c2",
    string: "#a9d48a",
    number: "#f2a2c0",
    operator: "#c9b27f",
    comment: "#6b7285",
    punctuation: "#9aa0b0",
  },
} as const;

export function appColor(name: string | undefined): string {
  return name !== undefined && Object.hasOwn(theme.apps, name) ? theme.apps[name as keyof typeof theme.apps] : theme.apps.komux;
}

export const stripeChars: BorderCharacters = {
  topLeft: "▎",
  topRight: " ",
  bottomLeft: "▎",
  bottomRight: " ",
  horizontal: " ",
  vertical: "▎",
  topT: " ",
  bottomT: " ",
  leftT: "▎",
  rightT: " ",
  cross: " ",
};

export function card(color: string) {
  return { border: ["left" as const], customBorderChars: stripeChars, borderColor: color, backgroundColor: theme.raised };
}
