// Writes a line to stderr, which for the session server is its session log.
//
// Use this instead of console.* in any process with a live OpenTUI renderer: the renderer
// replaces the global console and keeps what it is given in memory for an overlay that
// komux never shows, so console output written while it runs is lost.
//
// Strings are written as they are; anything else, such as an Error, is formatted with
// Bun.inspect, which keeps the stack trace.
export function writeLog(value: unknown): void {
  process.stderr.write(`${typeof value === "string" ? value : Bun.inspect(value)}\n`);
}
