import { rmSync } from "node:fs";
import { join } from "node:path";

export type Attachment = { label: string; text: string };

export type ContextOutcome = { attach: Attachment[] } | { none: string } | { cancelled: true };

export type ContextHandlers = {
  picking(hint: string): void;
  done(outcome: ContextOutcome): void;
};

export type ContextRequest = { cancel(): void };

export const noContext = "No context from this pane";

export function contextSocketPath(tabDir: string, paneId: number): string {
  return join(tabDir, "context", `${paneId}.sock`);
}

export function askContext(path: string, handlers: ContextHandlers, firstReplyMs = 1000): ContextRequest {
  let finished = false;
  let connection: { end(data?: string): void } | undefined;
  let buffer = "";
  const finish = (outcome: ContextOutcome, farewell?: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    connection?.end(farewell);
    handlers.done(outcome);
  };
  const timer = setTimeout(() => finish({ none: noContext }), firstReplyMs);
  const handle = (line: string) => {
    const reply = parseReply(line);
    if (reply === undefined) return finish({ none: noContext });
    if ("picking" in reply) {
      clearTimeout(timer);
      return handlers.picking(reply.picking);
    }
    finish(reply);
  };
  Bun.connect({
    unix: path,
    socket: {
      open(socket) {
        if (finished) return void socket.end();
        connection = socket;
        socket.write(`${JSON.stringify({ context: 1 })}\n`);
      },
      data(_socket, data) {
        buffer += data.toString();
        for (let newline = buffer.indexOf("\n"); newline >= 0 && !finished; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim()) handle(line);
        }
      },
      close: () => finish({ cancelled: true }),
      error: () => finish({ cancelled: true }),
    },
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ECONNREFUSED") rmSync(path, { force: true });
    finish({ none: noContext });
  });
  return { cancel: () => finish({ cancelled: true }, `${JSON.stringify({ cancel: true })}\n`) };
}

function parseReply(line: string): ContextOutcome | { picking: string } | undefined {
  let reply: unknown;
  try {
    reply = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof reply !== "object" || reply === null) return undefined;
  const { picking, attach, none, cancelled } = reply as Record<string, unknown>;
  if (typeof picking === "string") return { picking };
  if (Array.isArray(attach)) {
    const attachments = attach.filter(isAttachment);
    return attachments.length > 0 ? { attach: attachments } : { none: "Nothing to attach" };
  }
  if (typeof none === "string") return { none };
  if (cancelled === true) return { cancelled: true };
  return undefined;
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) return false;
  const { label, text } = value as Record<string, unknown>;
  return typeof label === "string" && label !== "" && typeof text === "string" && text.trim() !== "";
}
