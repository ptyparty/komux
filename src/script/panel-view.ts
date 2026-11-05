import { BoxRenderable, MarkdownRenderable, ScrollBoxRenderable, TextRenderable, bold, fg, bg, type CliRenderer, type KeyEvent, type Renderable } from "@opentui/core";
import { markdownStyle } from "../form/view.ts";
import { theme } from "../mux/theme.ts";
import { styled, type Part } from "../ui/styled.ts";
import type { PanelElement, PanelEvent, textStyles } from "./api.ts";
import { PanelController, type Stop } from "./panel.ts";

const styleColors: Record<(typeof textStyles)[number], string> = {
  plain: theme.text,
  bold: theme.text,
  muted: theme.muted,
  accent: theme.accent,
  success: theme.ok,
  warning: theme.warning,
  error: theme.error,
};

export class PanelView {
  private readonly scroll: ScrollBoxRenderable;
  private readonly footer: TextRenderable;
  private readonly frame: BoxRenderable;
  private readonly controller = new PanelController();
  private pending: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly onEvent: (event: PanelEvent) => void,
  ) {
    this.frame = new BoxRenderable(renderer, {
      backgroundColor: theme.raised,
      flexDirection: "column",
      width: "100%",
      height: "100%",
      paddingRight: 1,
    });
    this.scroll = new ScrollBoxRenderable(renderer, { flexGrow: 1, contentOptions: { flexDirection: "column", gap: 1 } });
    this.footer = new TextRenderable(renderer, { fg: theme.muted, flexShrink: 0, wrapMode: "none" });
    this.frame.add(this.scroll);
    this.frame.add(this.footer);
    renderer.root.add(this.frame);
    renderer.keyInput.on("keypress", this.onKey);
    this.status("starting…");
  }

  render(elements: PanelElement[]): void {
    this.controller.render(elements);
    this.schedule();
  }

  status(text: string): void {
    this.footer.content = text;
  }

  destroy(): void {
    clearTimeout(this.pending);
    this.renderer.keyInput.off("keypress", this.onKey);
  }

  private readonly onKey = (key: KeyEvent): void => {
    if (key.name === "pageup" || key.name === "pagedown") {
      this.scroll.scrollBy((key.name === "pageup" ? -1 : 1) * 0.8, "viewport");
      return;
    }
    const before = this.controller.cursor;
    const event = this.controller.key(key);
    if (event) this.onEvent(event);
    if (this.controller.cursor !== before) this.draw();
  };

  private schedule(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.draw();
    }, 16);
  }

  private draw(): void {
    for (const child of this.scroll.content.getChildren()) child.destroyRecursively();
    const focused = this.controller.focused();
    this.controller.elements.forEach((element, index) => this.scroll.add(this.build(element, index, focused)));
    const hints = this.controller.stops.length > 0 ? "↑↓ move · Enter select · PgUp/PgDn scroll · Alt j hide" : "PgUp/PgDn scroll · Alt j hide";
    this.status(hints);
    if (focused) this.scroll.scrollChildIntoView(this.controller.elements[focused.element]?.type === "buttons" ? `stop-${focused.element}-${focused.id}` : stopId(focused));
  }

  private build(element: PanelElement, index: number, focused: Stop | undefined): Renderable {
    const text = (content: Part[] | string, id?: string) => new TextRenderable(this.renderer, { id, content: typeof content === "string" ? content : styled(content), wrapMode: "word" });
    const isFocused = (value: string) => focused?.element === index && focused.value === value;
    switch (element.type) {
      case "text": {
        const color = styleColors[element.style ?? "plain"];
        return text([element.style === "bold" ? bold(fg(color)(element.text)) : fg(color)(element.text)]);
      }
      case "markdown":
        return new MarkdownRenderable(this.renderer, { content: element.text, syntaxStyle: markdownStyle(this.renderer), tableOptions: { widthMode: "content", cellPaddingX: 1 } });
      case "divider":
        return text([fg(theme.border)("─".repeat(Math.max(this.renderer.width - 4, 1)))]);
      case "progress": {
        const width = Math.max(Math.min(this.renderer.width - 20, 50), 10);
        const share = Math.min(Math.max(element.value / element.max, 0), 1);
        const filled = Math.round(share * width);
        const label = element.label ? `${element.label}  ` : "";
        return text([fg(theme.text)(label), fg(theme.accent)("█".repeat(filled)), fg(theme.border)("░".repeat(width - filled)), fg(theme.muted)(` ${Math.round(share * 100)}%`)]);
      }
      case "list": {
        const box = new BoxRenderable(this.renderer, { flexDirection: "column" });
        for (const item of element.items) {
          const selected = isFocused(item.value);
          const mark = item.mark !== undefined ? `${item.mark} ` : "";
          const line = `${selected ? "›" : " "} ${mark}${item.text}`;
          const parts: Part[] = [selected ? bold(bg(theme.surface)(fg(theme.accent)(line))) : fg(theme.text)(line)];
          if (item.detail) parts.push(fg(theme.muted)(`  ${item.detail}`));
          box.add(text(parts, stopId({ element: index, id: element.id, value: item.value })));
        }
        return box;
      }
      case "table": {
        const widths = element.columns.map((column, col) => Math.min(Math.max(Bun.stringWidth(column), ...element.rows.map((row) => Bun.stringWidth(row[col] ?? ""))), 40));
        const cells = (row: string[]) => element.columns.map((_, col) => pad(row[col] ?? "", widths[col]!)).join("  ");
        const box = new BoxRenderable(this.renderer, { flexDirection: "column" });
        box.add(text([bold(fg(theme.accent)(`  ${cells(element.columns)}`))]));
        element.rows.forEach((row, rowIndex) => {
          const value = String(rowIndex);
          const selected = element.id !== undefined && isFocused(value);
          const line = `${selected ? "›" : " "} ${cells(row)}`;
          box.add(text([selected ? bold(bg(theme.surface)(fg(theme.accent)(line))) : fg(theme.text)(line)], element.id === undefined ? undefined : stopId({ element: index, id: element.id, value })));
        });
        return box;
      }
      case "buttons": {
        const parts = element.options.flatMap((option, position): Part[] => {
          const value = typeof option === "string" ? option : option.value;
          const label = ` ${typeof option === "string" ? option : (option.label ?? option.value)} `;
          const selected = isFocused(value);
          return [...(position > 0 ? ["  "] : []), selected ? bold(bg(theme.accent)(fg(theme.background)(label))) : bg(theme.surface)(fg(theme.text)(label))];
        });
        return text(parts, `stop-${index}-${element.id}`);
      }
    }
  }
}

function stopId(stop: Stop): string {
  const element = `stop-${stop.element}-${stop.id}`;
  return stop.value === "" ? element : `${element}-${stop.value}`;
}

function pad(text: string, width: number): string {
  const shown = Bun.stringWidth(text) > width ? `${[...text].slice(0, width - 1).join("")}…` : text;
  return shown + " ".repeat(Math.max(width - Bun.stringWidth(shown), 0));
}
