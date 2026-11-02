import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { declinedPath, defaultHookCommand, hasKomuxHooks, installHooks, missingHooks, komuxStateDir, readSettings, removeHooks, settingsPaths, writeSettings, type Settings } from "./hooks-setup.ts";
import { applyLink, backupPath, linkState, removeLink, type Link, type LinkState } from "./links.ts";
import { claudeConfigDir } from "./sessions.ts";

export type SetupState = LinkState;

export type SetupItem = {
  id: string;
  label: string;
  state: SetupState;
  detail: string;
  apply(): Promise<string>;
  remove(): Promise<string | undefined>;
};

const repoRoot = join(import.meta.dir, "..", "..");

export async function setupItems(configDir = claudeConfigDir(), root = repoRoot, hookCommand: () => string = defaultHookCommand): Promise<SetupItem[]> {
  return [await hooksItem(configDir, hookCommand), ...links(configDir, root).map(linkItem)];
}

function links(configDir: string, root: string): (Link & { id: string; label: string })[] {
  const skills = readdirSync(join(root, "skills"))
    .sort()
    .map((name) => ({ kind: "skill", folder: "skills", name, file: name }));
  const rules = readdirSync(join(root, "rules"))
    .sort()
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({ kind: "rule", folder: "rules", name: basename(file, ".md"), file }));
  return [...skills, ...rules].map(({ kind, folder, name, file }) => ({
    id: `${kind}:${name}`,
    label: `${kind} ${name}`,
    source: join(root, folder, file),
    target: join(configDir, folder, file),
    tail: join(folder, file),
    owner: "komux",
  }));
}

function linkItem(link: Link & { id: string; label: string }): SetupItem {
  const state = linkState(link);
  const detail = {
    installed: "linked",
    missing: "missing",
    outdated: "links to another komux checkout",
    different: `something else is there; it would be kept as ${backupPath(link)}`,
  }[state];
  return {
    id: link.id,
    label: link.label,
    state,
    detail,
    apply: async () => {
      const backup = applyLink(link);
      return backup ? `linked, keeping the old one as ${backup}` : "linked";
    },
    remove: async () => {
      const outcome = removeLink(link);
      return outcome === "skipped" ? undefined : outcome === "restored" ? "removed, and put back what it replaced" : "removed";
    },
  };
}

async function hooksItem(configDir: string, hookCommand: () => string): Promise<SetupItem> {
  const paths = settingsPaths(configDir);
  let settings: Settings, local: Settings;
  try {
    [settings, local] = await Promise.all([readSettings(paths.user), readSettings(paths.local)]);
  } catch (error) {
    const problem = `can't read Claude's settings: ${(error as Error).message}`;
    return {
      id: "hooks",
      label: "hooks",
      state: "different",
      detail: problem,
      apply: async () => {
        throw new Error(problem);
      },
      remove: async () => undefined,
    };
  }
  const missing = missingHooks([settings, local]);
  const state: SetupState = missing.length === 0 ? "installed" : hasKomuxHooks(settings) || hasKomuxHooks(local) ? "outdated" : "missing";
  return {
    id: "hooks",
    label: "hooks",
    state,
    detail: state === "installed" ? "in settings.json" : missing.map((hook) => hook.label).join(" · "),
    apply: async () => {
      const backup = await writeSettings(paths.user, installHooks(settings, [local], hookCommand()));
      return backup ? `added to settings.json, keeping the old file as ${backup}` : "added to settings.json";
    },
    remove: async () => {
      const removed: string[] = [];
      for (const [path, from] of [
        [paths.user, settings],
        [paths.local, local],
      ] as const) {
        if (!hasKomuxHooks(from)) continue;
        await writeSettings(path, removeHooks(from));
        removed.push(basename(path));
      }
      return removed.length > 0 ? `removed from ${removed.join(" and ")}, keeping the old files as .komux-backup` : undefined;
    },
  };
}

export const stateMarks: Record<SetupState, string> = { installed: "✓", missing: "✗", outdated: "↻", different: "!" };

export function setupDeclinedPath(): string {
  return join(komuxStateDir(), "setup-declined");
}

export async function declinedItems(): Promise<Set<string>> {
  const file = Bun.file(setupDeclinedPath());
  const ids = (await file.exists()) ? (await file.text()).split("\n").filter(Boolean) : [];
  if (existsSync(declinedPath())) ids.push("hooks");
  return new Set(ids);
}

export async function declineItems(ids: string[]): Promise<void> {
  const declined = await declinedItems();
  for (const id of ids) declined.add(id);
  await Bun.write(setupDeclinedPath(), [...declined].join("\n") + "\n");
}
