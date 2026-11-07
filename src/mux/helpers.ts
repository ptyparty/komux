import { writeLog } from "../log.ts";

const restartMs = 5000;

export class Helpers {
  private readonly children = new Set<Bun.Subprocess>();
  private stopped = false;

  constructor(
    private readonly commands: string[][],
    private readonly env: Record<string, string>,
  ) {}

  start(): void {
    for (const command of this.commands) void this.keep(command);
  }

  stop(): void {
    this.stopped = true;
    for (const child of this.children) child.kill();
  }

  private async keep(command: string[]): Promise<void> {
    while (!this.stopped) {
      let code: number | null = null;
      try {
        const child = Bun.spawn(command, { env: { ...process.env, ...this.env }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
        this.children.add(child);
        const [stderr, exited] = await Promise.all([new Response(child.stderr).text(), child.exited]);
        this.children.delete(child);
        code = exited;
        if (!this.stopped) writeLog(`helper ${command.join(" ")} exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`);
      } catch (error) {
        writeLog(`helper ${command.join(" ")} could not start: ${(error as Error).message}`);
      }
      if (this.stopped) return;
      await Bun.sleep(restartMs);
    }
  }
}
