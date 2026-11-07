import { theme } from "./theme.ts";
import type { AgentState, CommandState } from "./workspace.ts";

export type Badge = { owner: string; text: string; color: string };

export const agentBadges: Record<AgentState, string> = { working: "🧠", waiting: "!", done: "🚀", failed: "✗" };
export const agentColors: Record<AgentState, string> = { working: theme.accent, waiting: theme.warning, done: theme.ok, failed: theme.error };
export const commandBadges: Record<CommandState, string> = { running: "⏳", succeeded: "🎉", failed: "💥" };
export const commandColors: Record<CommandState, string> = { running: theme.accent, succeeded: theme.ok, failed: theme.error };

export const badgeColors = ["text", "muted", "accent", "ok", "warning", "error"] as const;
export type BadgeColor = (typeof badgeColors)[number];

export function badgeColor(color: string | undefined): string {
  if (color === undefined) return theme.text;
  return (badgeColors as readonly string[]).includes(color) ? theme[color as BadgeColor] : color;
}
