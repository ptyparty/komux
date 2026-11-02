import { z } from "zod";
import { formSpec, type FormSpec } from "../form/schema.ts";

const id = z.string().min(1).max(100);
const shortText = z.string().max(2000);

export const textStyles = ["plain", "bold", "muted", "accent", "success", "warning", "error"] as const;

const option = z.union([z.string().max(200), z.object({ value: z.string().max(200), label: z.string().max(200).optional() })]);

export const panelElement = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(20_000), style: z.enum(textStyles).optional() }),
  z.object({ type: z.literal("markdown"), text: z.string().max(50_000) }),
  z.object({ type: z.literal("progress"), value: z.number(), max: z.number().positive(), label: shortText.optional() }),
  z.object({
    type: z.literal("list"),
    id,
    items: z.array(z.object({ value: z.string().max(200), text: shortText, mark: z.string().max(4).optional(), detail: shortText.optional() })).max(1000),
  }),
  z.object({
    type: z.literal("table"),
    id: id.optional(),
    columns: z.array(shortText).min(1).max(20),
    rows: z.array(z.array(shortText).max(20)).max(1000),
  }),
  z.object({ type: z.literal("buttons"), id, options: z.array(option).min(1).max(10) }),
  z.object({ type: z.literal("divider") }),
]);

export const panelElements = z.array(panelElement).max(200);

export type PanelElement = z.infer<typeof panelElement>;

export type PanelEvent = { type: "select"; id: string; value: string } | { type: "key"; key: string };

export const maxRenderBytes = 256 * 1024;
export const maxReplyBytes = 256 * 1024;
export const maxStatusLength = 200;

export const scriptCall = z.discriminatedUnion("name", [
  z.object({ name: z.literal("render"), args: z.tuple([panelElements]) }),
  z.object({ name: z.literal("show"), args: z.tuple([]) }),
  z.object({ name: z.literal("hide"), args: z.tuple([]) }),
  z.object({ name: z.literal("dock"), args: z.tuple([z.string().nullable()]) }),
  z.object({ name: z.literal("tray"), args: z.tuple([z.string().nullable()]) }),
  z.object({ name: z.literal("toast"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("reply"), args: z.tuple([z.unknown()]) }),
]);

export type ScriptCall = z.infer<typeof scriptCall>;

export const scriptRequest = z.discriminatedUnion("name", [
  z.object({ name: z.literal("ask"), args: z.tuple([z.unknown()]) }),
  z.object({ name: z.literal("state"), args: z.tuple([]) }),
]);

export type ScriptRequest = z.infer<typeof scriptRequest>;

export class ScriptCallError extends Error {}

export function parseCall(name: string, args: unknown[]): ScriptCall {
  const parsed = scriptCall.safeParse({ name, args });
  if (!parsed.success) throw new ScriptCallError(`komux.${name}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function parseRequest(name: string, args: unknown[]): ScriptRequest {
  const parsed = scriptRequest.safeParse({ name, args });
  if (!parsed.success) throw new ScriptCallError(`komux.${name}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function scriptForm(input: unknown): FormSpec {
  const parsed = formSpec.safeParse(input);
  if (!parsed.success) throw new ScriptCallError(`komux.ask: ${z.prettifyError(parsed.error)}`);
  const pictures = parsed.data.elements.filter((element) => element.type === "image" || element.type === "slides");
  if (pictures.length > 0) throw new ScriptCallError("komux.ask: scripts can't show image or slides elements, since they read files");
  return parsed.data;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxStatusLength);
}
