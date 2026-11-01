import type { FormSpec } from "../form/schema.ts";
import { age } from "../claude/sessions.ts";
import { firstLine } from "./fit.ts";
import type { AgentState, Reply } from "./workspace.ts";

export function peekSpec(title: string, text: string): FormSpec {
  return {
    title,
    elements: [
      { type: "markdown", text },
      { type: "text", id: "reply", label: "Reply", multiline: true, placeholder: "Ctrl+s sends · Esc closes" },
    ],
    submitLabel: "Send",
  };
}

export type ReplyChoice = { label: string; text: string };

export function replyChoices(replies: Reply[], now: number): ReplyChoice[] {
  return [...replies].reverse().map((reply) => ({ label: `${age(now - reply.at).padEnd(8)}  ${reply.unread ? "new" : "   "}  ${firstLine(reply.text, 60)}`, text: reply.text }));
}

export function pickSpec(title: string, choices: ReplyChoice[]): FormSpec {
  return {
    title,
    elements: [
      {
        type: "choice",
        id: "pick",
        label: "Replies, newest first",
        options: choices.map((choice, index) => ({ value: String(index), label: choice.label })),
        default: "0",
        required: true,
        other: false,
      },
    ],
    submitLabel: "Open",
  };
}

export type PromptRoute = "socket" | "paste" | "busy";

export function promptRoute(native: boolean, state: AgentState | undefined): PromptRoute {
  if (native) return "socket";
  return state === "working" || state === "waiting" ? "busy" : "paste";
}

export function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(/\x1b\[201~/g, "")}\x1b[201~`;
}
