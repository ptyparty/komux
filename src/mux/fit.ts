export function firstLine(text: string, max: number): string {
  return fit(text.split("\n").find((candidate) => candidate.trim())?.replace(/[*_`#>]/g, "").trim() ?? "", max);
}

export function fit(text: string, width: number, pad = false): string {
  if (Bun.stringWidth(text) <= width) return pad ? text + " ".repeat(width - Bun.stringWidth(text)) : text;
  let cut = "";
  for (const char of text) {
    if (Bun.stringWidth(cut + char) > width - 1) break;
    cut += char;
  }
  return `${cut}…${pad ? " ".repeat(Math.max(width - 1 - Bun.stringWidth(cut), 0)) : ""}`;
}
