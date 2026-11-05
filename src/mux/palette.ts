import type { AppKeys } from "./context.ts";
import { komuxCommands, type Binding, type Mode } from "./keymap.ts";
import type { PaneId } from "./layout.ts";

export type PaletteEntry = { name: string; keys: string; app: string; binding?: Binding; send?: string; pane?: PaneId };

export type Palette = { scope?: Mode; back: Mode; text: string; entries: PaletteEntry[]; matches: PaletteEntry[]; selected: number };

export function paletteEntries(scope: Mode | undefined, app: { pane: PaneId; keys: AppKeys } | undefined): PaletteEntry[] {
  const komux = komuxCommands(scope).map(({ name, keys, binding }): PaletteEntry => ({ name, keys, app: "komux", binding }));
  if (scope || !app) return komux;
  const own = app.keys.groups.flatMap((group) => group.commands.map((command): PaletteEntry => ({ name: command.label, keys: command.keys ?? "", app: app.keys.app, send: command.send, pane: app.pane })));
  return [...own, ...komux];
}

export function rankEntries(query: string, entries: PaletteEntry[]): PaletteEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return entries;
  const scored = entries.flatMap((entry, index) => {
    const score = Math.min(fuzzyScore(needle, entry.name.toLowerCase()) ?? Infinity, (fuzzyScore(needle, `${entry.app} ${entry.name}`.toLowerCase()) ?? Infinity) + 1);
    return score === Infinity ? [] : [{ entry, score, index }];
  });
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map(({ entry }) => entry);
}

export function fuzzyScore(needle: string, haystack: string): number | undefined {
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  if (haystack.split(/[\s/·-]+/).some((word) => word.startsWith(needle))) return 2;
  if (haystack.includes(needle)) return 3;
  let position = 0;
  for (const char of needle) {
    position = haystack.indexOf(char, position);
    if (position < 0) return undefined;
    position++;
  }
  return 4;
}
