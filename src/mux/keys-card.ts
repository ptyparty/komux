import { BoxRenderable, TextRenderable, bg, bold, fg, type CliRenderer } from "@opentui/core";
import { styled, type Part } from "../ui/styled.ts";
import type { AppKeys } from "./context.ts";
import { fit } from "./fit.ts";
import { hints, keymap, leaderGroups, withoutLeader, type Hint, type KeyGroup, type Mode } from "./keymap.ts";
import type { Palette } from "./palette.ts";
import { appColor, card, theme } from "./theme.ts";

const columnGap = 4;
const appRows = 5;

export class KeysCard {
  private readonly box: BoxRenderable;
  private readonly text: TextRenderable;

  constructor(private readonly renderer: CliRenderer) {
    this.box = new BoxRenderable(renderer, { position: "absolute", left: 1, zIndex: 160, visible: false, ...card(theme.accent), paddingLeft: 1, paddingRight: 1 });
    this.text = new TextRenderable(renderer, { wrapMode: "none" });
    this.box.add(this.text);
    renderer.root.add(this.box);
  }

  get height(): number {
    return this.box.visible && typeof this.box.height === "number" ? this.box.height : 0;
  }

  render(state: { mode: Mode; leader: boolean; app?: AppKeys; bottom: number; lockLeader: boolean }): void {
    const room = this.renderer.width - 2;
    const lines = state.leader ? leaderLines(state.app, room - 3) : state.mode === "normal" || state.mode === "leader" ? undefined : modeLines(state.mode, room - 3, state.lockLeader);
    this.box.visible = lines !== undefined;
    if (!lines) return;
    const width = Math.min(Math.max(...lines.map(lineWidth)) + 3, room);
    this.box.borderColor = theme.modes[state.mode];
    this.box.width = state.leader ? width : room;
    this.box.height = lines.length;
    this.box.bottom = state.bottom;
    this.text.content = styled(lines.flatMap((line, index) => [...(index > 0 ? ["\n"] : []), ...line]));
  }
}

function leaderLines(app: AppKeys | undefined, room: number): Part[][] {
  const columns = leaderGroups.map((group) => groupColumn(group, theme.accent));
  const appColumn = app ? appKeysColumn(app) : undefined;
  if (appColumn && columns.reduce((total, column) => total + column.width + columnGap, 0) + appColumn.width <= room) columns.push(appColumn);
  const depth = Math.max(...columns.map((column) => column.rows.length));
  const body = Array.from({ length: depth + 1 }, (_, row) =>
    columns.flatMap((column, index) => {
      const cell = row === 0 ? column.header : (column.rows[row - 1] ?? []);
      const pad = column.width - lineWidth(cell) + (index < columns.length - 1 ? columnGap : 0);
      return [...cell, " ".repeat(Math.max(pad, 0))];
    }),
  );
  const totalWidth = Math.max(...body.map(lineWidth));
  const heading: Part[] = [bold(fg(theme.accent)("Ctrl Space")), fg(theme.muted)("  komux")];
  const search: Part[] = [fg(theme.text)("?"), fg(theme.muted)(" all commands")];
  const gap = Math.max(totalWidth - lineWidth(heading) - lineWidth(search), 2);
  const footer: Part[] = [fg(theme.faint)("Without the leader  "), ...hintParts(withoutLeader)];
  return [[...heading, " ".repeat(gap), ...search], [""], ...body, [""], fitLine(footer, Math.max(totalWidth, room))];
}

type Column = { header: Part[]; rows: Part[][]; width: number };

function groupColumn(group: KeyGroup, color: string): Column {
  const keyWidth = Math.max(...group.hints.map((hint) => Bun.stringWidth(hint.keys)));
  const rows = group.hints.map((hint): Part[] => [fg(theme.text)(hint.keys + " ".repeat(keyWidth + 2 - Bun.stringWidth(hint.keys))), fg(theme.muted)(hint.description)]);
  const header = [bold(fg(color)(group.title.toUpperCase()))];
  return { header, rows, width: Math.max(lineWidth(header), ...rows.map(lineWidth)) };
}

function appKeysColumn(app: AppKeys): Column {
  const commands = app.groups.flatMap((group) => group.commands).slice(0, appRows);
  const color = appColor(app.app);
  const keyWidth = Math.min(Math.max(...commands.map((command) => Bun.stringWidth(command.keys ?? ""))), 8);
  const rows = commands.map((command): Part[] => [fg(theme.text)(fit(command.keys ?? "", keyWidth, true) + "  "), fg(command.send === undefined ? theme.faint : theme.muted)(fit(command.label, 22))]);
  const title = app.groups[0]?.name;
  const header = [bold(fg(color)(`◆ ${app.app}`)), ...(title ? [fg(theme.muted)(` · ${title}`)] : [])];
  return { header, rows, width: Math.max(lineWidth(header), ...rows.map(lineWidth)) };
}

function modeLines(mode: Mode, room: number, lockLeader: boolean): Part[][] {
  const { title, about } = keymap[mode];
  const color = theme.modes[mode];
  const heading: Part[] = [bold(fg(color)(title.toUpperCase())), fg(theme.muted)(`  ${lockLeader ? "Ctrl Space pressed · l unlocks, any other key goes to the pane" : about}`)];
  const searchable = keymap[mode].bindings.some((binding) => binding.command.type === "palette");
  const right: Part[] = mode === "locked" ? [] : [...(searchable ? [fg(theme.text)("?"), fg(theme.muted)(" search  ")] : []), fg(theme.text)("Esc"), fg(theme.muted)(" done")];
  const gap = Math.max(room - lineWidth(heading) - lineWidth(right), 2);
  const rows: Part[][] = [];
  let row: Part[] = [];
  for (const hint of hints(mode)) {
    const parts = hintParts([hint]);
    if (row.length > 0 && lineWidth(row) + 3 + lineWidth(parts) > room) {
      rows.push(row);
      row = [];
    }
    row.push(...(row.length > 0 ? ["   "] : []), ...parts);
  }
  if (row.length > 0) rows.push(row);
  return [[...heading, " ".repeat(gap), ...right], ...rows];
}

export class PaletteCard {
  private readonly box: BoxRenderable;
  private readonly text: TextRenderable;
  private firstShown = 0;

  constructor(private readonly renderer: CliRenderer) {
    this.box = new BoxRenderable(renderer, { position: "absolute", left: "20%", top: "15%", width: "60%", zIndex: 210, visible: false, ...card(theme.accent), paddingLeft: 1, paddingRight: 1 });
    this.text = new TextRenderable(renderer, { wrapMode: "none" });
    this.box.add(this.text);
    renderer.root.add(this.box);
  }

  render(palette: Palette | undefined, app: AppKeys | undefined): void {
    this.box.visible = palette !== undefined;
    if (!palette) {
      this.firstShown = 0;
      return;
    }
    const width = Math.max(Math.floor(this.renderer.width * 0.6) - 3, 30);
    const title = palette.scope ? `${keymap[palette.scope].title} mode commands` : "Run a command";
    const aside: Part[] = palette.scope ? [] : app ? [fg(appColor(app.app))(app.app), fg(theme.muted)(" focused")] : [];
    const lines: Part[][] = [[bold(fg(theme.text)(title)), " ".repeat(Math.max(width - Bun.stringWidth(title) - lineWidth(aside), 1)), ...aside], [""]];
    lines.push([bold(fg(theme.accent)("› ")), fg(theme.text)(palette.text), bg(theme.text)(" ")], [""]);
    const rows = Math.max(Math.floor(this.renderer.height * 0.7) - 7, 3);
    if (palette.selected < this.firstShown) this.firstShown = palette.selected;
    if (palette.selected >= this.firstShown + rows) this.firstShown = palette.selected - rows + 1;
    this.firstShown = Math.max(Math.min(this.firstShown, palette.matches.length - rows), 0);
    const shown = palette.matches.slice(this.firstShown, this.firstShown + rows);
    const appWidth = Math.max(...palette.matches.map((entry) => Bun.stringWidth(entry.app)), 5);
    if (shown.length === 0) lines.push([fg(theme.muted)("No matching commands")]);
    shown.forEach((entry, index) => {
      const selected = this.firstShown + index === palette.selected;
      const paint = (part: Part) => (selected ? bg(theme.selection)(part) : part);
      const keys = entry.keys;
      const nameRoom = width - 2 - appWidth - 2 - Bun.stringWidth(keys) - 2;
      const name = fit(entry.name, Math.max(nameRoom, 8));
      const gap = Math.max(width - 2 - appWidth - 2 - Bun.stringWidth(name) - Bun.stringWidth(keys), 1);
      const runnable = entry.binding !== undefined || entry.send !== undefined;
      lines.push([
        paint(fg(theme.accent)(selected ? "▸ " : "  ")),
        paint(fg(appColor(entry.app))(entry.app.padEnd(appWidth + 2))),
        paint((selected ? bold : (part: Part) => part)(fg(runnable ? theme.text : theme.faint)(name))),
        paint(fg(theme.muted)(`${" ".repeat(gap)}${keys}`)),
      ]);
    });
    const selected = palette.matches[palette.selected];
    const note: Part[] = selected && selected.app !== "komux" ? [fg(theme.faint)(selected.send === undefined ? `${selected.app} shows this, but komux can't run it` : `runs by typing its keys into ${selected.app}`)] : [];
    const keys = hintParts([
      { keys: "⏎", description: "run" },
      { keys: "↑↓", description: "choose" },
      { keys: "Esc", description: "close" },
    ]);
    lines.push([""], [...note, " ".repeat(Math.max(width - lineWidth(note) - lineWidth(keys), 1)), ...keys]);
    this.box.height = lines.length;
    this.text.content = styled(lines.flatMap((line, index) => [...(index > 0 ? ["\n"] : []), ...line]));
  }
}

export function hintParts(list: Hint[]): Part[] {
  return list.flatMap((hint, index) => [...(index > 0 ? ["  "] : []), fg(theme.text)(hint.keys), fg(theme.muted)(` ${hint.description}`)]);
}

function fitLine(parts: Part[], width: number): Part[] {
  const kept: Part[] = [];
  let used = 0;
  for (const part of parts) {
    const size = lineWidth([part]);
    if (used + size > width) break;
    kept.push(part);
    used += size;
  }
  return kept;
}

function lineWidth(parts: Part[]): number {
  return parts.reduce((total, part) => total + Bun.stringWidth(typeof part === "string" ? part : part.text), 0);
}
