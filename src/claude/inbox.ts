import { join } from "node:path";

export function deliver(socket: string, text: string): Promise<void> {
  return sendLine(socket, { text });
}

export function sendLine(socket: string, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    Bun.connect({
      unix: socket,
      socket: {
        open(connection) {
          connection.end(`${JSON.stringify(payload)}\n`);
          resolve();
        },
        data() {},
        error(_connection, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}

export function draftSocketPath(tabDir: string, popupId: number): string {
  return join(tabDir, `compose-${popupId}.sock`);
}
