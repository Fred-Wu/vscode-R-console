import * as fs from "fs";
import * as net from "net";
import * as path from "path";

export type SessionRegistryIdentity = { sessionId: string; pid: number };
export type SessionRegistryKeyReader = (identity: SessionRegistryIdentity, migrationDigest?: string) => Promise<Buffer>;

export function isSessionRegistryIdentity(value: unknown): value is SessionRegistryIdentity {
  const item = value as SessionRegistryIdentity | undefined;
  return !!item && typeof item.sessionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.sessionId) &&
    Number.isSafeInteger(item.pid) && item.pid > 0 && item.pid <= 0xffffffff;
}

export function sessionRegistryKeyEndpoint(identity: SessionRegistryIdentity): string {
  if (!isSessionRegistryIdentity(identity)) throw new Error("Invalid session key identity");
  if (process.platform === "win32") return `\\\\.\\pipe\\r-console-key-${identity.sessionId}`;
  if (!process.getuid) throw new Error("Private session keys are unavailable on this platform");
  return path.join(`/tmp/r-console-keys-${process.getuid()}`, `${identity.sessionId}.sock`);
}

/** The broker uses a private Unix directory/socket or a local-only named pipe
 * with a user-only DACL. Its key is created and retained by the Rust runtime.
 * Endpoints are derived locally; a saved record cannot choose a network path. */
export const readSessionRegistryKey: SessionRegistryKeyReader = async (identity, migrationDigest) => {
  const endpoint = sessionRegistryKeyEndpoint(identity);
  const request = Buffer.alloc(37);
  request.write("RCK1", "ascii");
  if (migrationDigest !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(migrationDigest)) throw new Error("Invalid registry migration digest");
    request[4] = 1;
    Buffer.from(migrationDigest, "hex").copy(request, 5);
  }
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      if (process.platform !== "win32") {
        const directory = fs.lstatSync(path.dirname(endpoint));
        const socket = fs.lstatSync(endpoint);
        const uid = process.getuid!();
        if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0 ||
            !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) !== 0) {
          throw new Error("Session key endpoint is not private to this user");
        }
      }
      return await receiveKey(endpoint, identity.pid, request, Math.max(1, deadline - Date.now()));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (Date.now() >= deadline || !["ENOENT", "ECONNREFUSED", "EBUSY", "EPIPE"].includes(code ?? "")) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
};

function receiveKey(endpoint: string, pid: number, request: Buffer, timeout: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint });
    let bytes = Buffer.alloc(0);
    let pendingKey: Buffer | undefined;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Session key request timed out")), timeout);
    socket.once("connect", () => socket.write(request));
    function finish(error?: Error, key?: Buffer): void {
      if (settled) { key?.fill(0); return; }
      settled = true;
      clearTimeout(timer);
      bytes.fill(0);
      if (pendingKey !== key) pendingKey?.fill(0);
      pendingKey = undefined;
      socket.destroy();
      if (error) reject(error); else resolve(key!);
    }
    socket.on("error", error => finish(error));
    socket.on("close", () => { if (!settled) finish(new Error("Session key connection closed")); });
    socket.on("data", chunk => {
      if (settled) return;
      if (bytes.length + chunk.length > 41) { finish(new Error("Invalid session key response")); return; }
      const combined = Buffer.concat([bytes, chunk]);
      bytes.fill(0);
      chunk.fill(0);
      bytes = combined;
      if (bytes.length !== 41) return;
      if (bytes.subarray(0, 4).toString("ascii") !== "RCK1" || bytes.readUInt32LE(4) !== pid) {
        finish(new Error("Session key belongs to a different runtime"));
        return;
      }
      if (bytes[8] !== 0) {
        finish(Object.assign(new Error("The runtime rejected a plaintext registry replacement"), { code: "PLAINTEXT_REJECTED" }));
        return;
      }
      const key = Buffer.from(bytes.subarray(9));
      pendingKey = key;
      if (process.platform === "win32") socket.end(Buffer.from("RCK1"), () => finish(undefined, key));
      else finish(undefined, key);
    });
  });
}
