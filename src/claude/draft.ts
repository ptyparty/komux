import { age } from "./sessions.ts";

export class DraftWatch {
  private conversation: string | undefined;
  private moved = false;
  private edited: number;

  constructor(now: number) {
    this.edited = now;
  }

  edit(now: number): void {
    this.edited = now;
  }

  observe(conversation: string | undefined): void {
    if (this.conversation === undefined) this.conversation = conversation;
    else if (conversation !== this.conversation) this.moved = true;
  }

  status(empty: boolean, now: number): string | undefined {
    if (empty) return undefined;
    const idle = now - this.edited;
    const parts = [...(idle >= 60_000 ? [`draft · ${age(idle)}`] : []), ...(this.moved ? ["written for an earlier conversation"] : [])];
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }
}
