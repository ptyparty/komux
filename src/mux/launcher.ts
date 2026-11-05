import { BoxRenderable, TextRenderable, bg, bold, fg, type CliRenderer } from "@opentui/core";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { styled, type Part } from "../ui/styled.ts";
import { card, theme } from "./theme.ts";
import { fit } from "./fit.ts";
import type { Prompt, SwitchEntry } from "./workspace.ts";

export type EntryLook = { badge?: string; color?: string; detail?: string; aside?: string };

export class Launcher {
  private readonly box: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly detail: TextRenderable;
  private readonly input: TextRenderable;
  private readonly matches: TextRenderable;
  private readonly marked: TextRenderable;
  private readonly footer: TextRenderable;
  private firstShown = 0;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly look: (entry: SwitchEntry) => EntryLook,
  ) {
    this.box = new BoxRenderable(renderer, {
      position: "absolute",
      left: "20%",
      top: "15%",
      width: "60%",
      zIndex: 200,
      visible: false,
      ...card(theme.accent),
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      paddingBottom: 1,
    });
    this.title = new TextRenderable(renderer, { height: 1, wrapMode: "none" });
    this.detail = new TextRenderable(renderer, { fg: theme.muted });
    this.input = new TextRenderable(renderer, {});
    this.matches = new TextRenderable(renderer, { marginTop: 1, wrapMode: "none" });
    this.marked = new TextRenderable(renderer, { marginTop: 1, wrapMode: "none" });
    this.footer = new TextRenderable(renderer, { fg: theme.muted, marginTop: 1 });
    for (const child of [this.title, this.detail, this.input, this.matches, this.marked, this.footer]) this.box.add(child);
    renderer.root.add(this.box);
  }

  render(prompt: Prompt | undefined): void {
    this.box.visible = prompt !== undefined;
    if (!prompt) {
      this.firstShown = 0;
      return;
    }
    const width = Math.max(Math.floor(this.renderer.width * 0.6) - 3, 20);
    const switching = prompt.kind === "switch";
    this.title.content = styled([
      bold(fg(theme.text)(prompt.title)),
      ...(switching && prompt.detail ? [fg(theme.muted)(prompt.detail.padStart(Math.max(width - Bun.stringWidth(prompt.title), 0)))] : []),
    ]);
    this.detail.visible = prompt.detail !== undefined && !switching;
    this.input.marginTop = switching ? 1 : 0;
    this.detail.content = prompt.detail ?? "";
    this.input.content = styled([bold(fg(theme.accent)("› ")), fg(theme.text)(prompt.text), bg(theme.text)(" ")]);
    const marked = prompt.marked ?? [];
    const markedRows = marked.length > 0 ? marked.length + 2 : 0;
    const fixedRows = 2 + (this.detail.visible || switching ? 1 : 0) + 1 + 1 + markedRows + 2;
    const shown = this.showMatches(prompt, Math.max(Math.floor(this.renderer.height * 0.75) - fixedRows, 3));
    const matches = prompt.matches;
    this.matches.visible = matches !== undefined;
    if (matches) this.matches.content = shown.length > 0 ? styled(this.matchLines(prompt, shown, width)) : styled([fg(theme.muted)("No matching tabs or projects")]);
    this.marked.visible = marked.length > 0;
    if (marked.length > 0) this.marked.content = styled(this.markedLines(marked, width));
    const keys: [string, string][] = matches
      ? [
          ["⏎", marked.length > 0 ? `open ${marked.length}` : "go"],
          ["↑↓", "choose"],
          ...(prompt.text === "" ? [["1–9", "jump"] as [string, string]] : []),
          ["␣", "mark"],
          ["Alt ⏎", "without jobs"],
          ["Esc", "close"],
        ]
      : [
          ["Enter", "confirm"],
          ["Esc", "cancel"],
        ];
    this.footer.content = styled(keys.flatMap(([key, label], index) => [...(index > 0 ? ["  "] : []), fg(theme.text)(key), fg(theme.muted)(` ${label}`)]));
    const matchRows = matches ? Math.max(shown.length, 1) + 1 : 0;
    this.box.height = 2 + (this.detail.visible || switching ? 1 : 0) + 1 + matchRows + markedRows + 2;
  }

  private matchLines(prompt: Prompt, shown: SwitchEntry[], width: number): Part[] {
    return shown.flatMap((match, index) => [
      ...(index > 0 ? ["\n"] : []),
      ...this.entryRow(match, width, { selected: this.firstShown + index === prompt.selected, marked: prompt.marked?.some((mark) => mark.name === match.name) ?? false }),
    ]);
  }

  private markedLines(marked: SwitchEntry[], width: number): Part[] {
    return [fg(theme.muted)("To open"), ...marked.flatMap((entry) => ["\n", ...this.entryRow(entry, width, { selected: false, marked: true })])];
  }

  private entryRow(entry: SwitchEntry, width: number, state: { selected: boolean; marked: boolean }): Part[] {
    const look = this.look(entry);
    const paint = (part: Part) => (state.selected ? bg(theme.selection)(part) : part);
    const lead = state.marked ? "✓ " : state.selected ? "▸ " : "  ";
    const number = entry.number === undefined ? "   " : `${String(entry.number).padStart(2)} `;
    const name = fit(entry.name, 22, true);
    const badge = look.badge ? ` ${look.badge}` : "";
    const aside = look.aside ?? "";
    const used = Bun.stringWidth(lead + number + name + badge) + 2;
    const room = width - used - Bun.stringWidth(aside) - 2;
    const detail = room >= 6 ? fit(look.detail ?? (entry.kind === "project" ? shortenHome(dirname(entry.dir)) : ""), room) : "";
    const gap = Math.max(width - used - Bun.stringWidth(detail) - Bun.stringWidth(aside), 1);
    return [
      paint(state.marked ? bold(fg(theme.accent)(lead)) : fg(theme.accent)(lead)),
      paint(fg(theme.muted)(number)),
      paint(state.selected ? bold(fg(theme.text)(name)) : fg(theme.text)(name)),
      paint(fg(look.color ?? theme.muted)(badge)),
      paint(fg(theme.muted)(`  ${detail}`)),
      paint(fg(look.color ?? theme.faint)(`${" ".repeat(gap)}${aside}`)),
    ];
  }

  private showMatches(prompt: Prompt, rows: number): SwitchEntry[] {
    const matches = prompt.matches ?? [];
    if (prompt.selected < this.firstShown) this.firstShown = prompt.selected;
    if (prompt.selected >= this.firstShown + rows) this.firstShown = prompt.selected - rows + 1;
    this.firstShown = Math.max(Math.min(this.firstShown, matches.length - rows), 0);
    return matches.slice(this.firstShown, this.firstShown + rows);
  }
}

function shortenHome(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
