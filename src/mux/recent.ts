import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { komuxStateDir } from "../claude/hooks-setup.ts";
import { pastSessions, projectDir } from "../claude/sessions.ts";
import type { RecentTab } from "./workspace.ts";

const describeTtlMs = 60_000;

export function recentTabsPath(): string {
  return join(komuxStateDir(), "recent-tabs.json");
}

export function loadRecentTabs(path = recentTabsPath()): RecentTab[] {
  try {
    return parseRecentTabs(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

export function parseRecentTabs(text: string): RecentTab[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry): RecentTab[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { title, at, project, args } = entry as Record<string, unknown>;
    if (typeof title !== "string" || typeof at !== "number" || typeof project !== "object" || project === null) return [];
    const { name, dir, layout } = project as Record<string, unknown>;
    if (typeof name !== "string" || typeof dir !== "string") return [];
    const validArgs = typeof args === "object" && args !== null && Object.values(args).every((value) => typeof value === "string") ? (args as Record<string, string>) : undefined;
    return [{ title, at, project: { name, dir, ...(typeof layout === "string" ? { layout } : {}) }, ...(validArgs ? { args: validArgs } : {}) }];
  });
}

export function saveRecentTabs(tabs: RecentTab[], path = recentTabsPath()): void {
  const staging = `${path}.${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(staging, `${JSON.stringify(tabs)}\n`);
    renameSync(staging, path);
  } catch {
    return;
  }
}

export class ConversationTitles {
  private readonly known = new Map<string, { title?: string; at: number }>();
  private readonly loading = new Set<string>();

  constructor(private readonly changed: () => void) {}

  title(dir: string): string | undefined {
    if (dir === "") return undefined;
    const known = this.known.get(dir);
    if ((!known || Date.now() - known.at > describeTtlMs) && !this.loading.has(dir)) this.load(dir);
    return known?.title;
  }

  private load(dir: string): void {
    this.loading.add(dir);
    pastSessions(projectDir(dir), 1).then(
      ([latest]) => this.store(dir, latest ? (latest.title ?? latest.lastPrompt?.replace(/\s+/g, " ").trim()) : undefined),
      () => this.store(dir, undefined),
    );
  }

  private store(dir: string, title: string | undefined): void {
    this.loading.delete(dir);
    const before = this.known.get(dir)?.title;
    this.known.set(dir, { title, at: Date.now() });
    if (title !== before) this.changed();
  }
}
