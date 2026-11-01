import type { PanelElement, PanelEvent } from "./api.ts";

export type Stop = { element: number; id: string; value: string };

export type PanelKey = { name: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean };

export class PanelController {
  elements: PanelElement[] = [];
  stops: Stop[] = [];
  cursor = 0;

  render(elements: PanelElement[]): void {
    const current = this.stops[this.cursor];
    this.elements = elements;
    this.stops = elements.flatMap((element, index) => stopsOf(element, index));
    const kept = current ? this.stops.findIndex((stop) => stop.id === current.id && stop.value === current.value) : -1;
    this.cursor = kept >= 0 ? kept : Math.min(this.cursor, Math.max(this.stops.length - 1, 0));
  }

  focused(): Stop | undefined {
    return this.stops[this.cursor];
  }

  key(key: PanelKey): PanelEvent | undefined {
    const plain = !key.ctrl && !key.meta;
    if (plain && ["up", "down", "left", "right", "tab"].includes(key.name) && this.stops.length > 0) {
      const back = key.name === "up" || key.name === "left" || (key.name === "tab" && key.shift);
      this.cursor = (this.cursor + (back ? -1 : 1) + this.stops.length) % this.stops.length;
      return undefined;
    }
    if (plain && (key.name === "return" || key.name === "enter" || key.name === "space")) {
      const stop = this.focused();
      if (stop) return { type: "select", id: stop.id, value: stop.value };
    }
    return { type: "key", key: keyName(key) };
  }
}

function stopsOf(element: PanelElement, index: number): Stop[] {
  switch (element.type) {
    case "list":
      return element.items.map((item) => ({ element: index, id: element.id, value: item.value }));
    case "table":
      return element.id === undefined ? [] : element.rows.map((_, row) => ({ element: index, id: element.id!, value: String(row) }));
    case "buttons":
      return element.options.map((option) => ({ element: index, id: element.id, value: typeof option === "string" ? option : option.value }));
    default:
      return [];
  }
}

function keyName(key: PanelKey): string {
  const base = key.name || key.sequence || "";
  return [key.ctrl && "ctrl", key.meta && "alt", key.shift && base.length > 1 && "shift", base].filter(Boolean).join("+");
}
