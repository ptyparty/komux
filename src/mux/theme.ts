import type { BorderCharacters } from "@opentui/core";

const komux = "#8fb0ff";

export const theme = {
  background: "#0f1117",
  surface: "#181b24",
  surface2: "#1f2330",
  raised: "#282e3d",
  line: "#323949",
  border: "#323949",
  text: "#e8ebf2",
  muted: "#9298ab",
  faint: "#565e72",
  selection: "#2c3a68",
  accent: komux,
  ok: "#a2e27a",
  warning: "#ffa863",
  error: "#ff6b6b",
  apps: {
    komux,
    quoll: "#ffc45e",
    remax: "#a2e27a",
    kowari: "#5ad8cf",
  },
  modes: {
    normal: komux,
    leader: komux,
    pane: "#5ad8cf",
    tab: "#c89dff",
    session: "#ffc45e",
    jobs: "#ffa0c8",
    tray: "#6fcff5",
    resize: "#e0c27d",
    locked: "#ff6b6b",
    custom: "#f7a072",
  },
  syntax: {
    keyword: "#c89dff",
    function: komux,
    type: "#5ad8cf",
    string: "#b4e388",
    number: "#ffa0c8",
    operator: "#e0c27d",
    comment: "#6e7790",
    punctuation: "#a0a7ba",
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
