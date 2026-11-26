import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { isSessionRegistryIdentity, sessionRegistryKeyEndpoint, type SessionRegistryIdentity } from "./sessionRegistryKey";

// Both sides enforce the same bound. The broker and key reader share an
// OS-protected same-user local endpoint, never the backend's TCP connection.
export const MAX_PRIVATE_STARTUP_STATE_BYTES = 16 * 1024 * 1024 - 32;
const PRIVATE_TIMEOUT_MS = 10_000;

export async function loadPrivateStartupState(identity: SessionRegistryIdentity): Promise<Buffer | undefined> {
  const state = await exchange(identity);
  return state?.length ? state : undefined;
}

export async function savePrivateStartupState(identity: SessionRegistryIdentity, state: Buffer): Promise<void> {
  if (!state.length || state.length > MAX_PRIVATE_STARTUP_STATE_BYTES) {
    throw new Error("Invalid private startup state size");
  }
  const result = await exchange(identity, state);
  if (!result || result.length !== 1 || result[0] !== 0) {
    result?.fill(0);
    throw new Error("Persistent session already has a different startup snapshot");
  }
  result.fill(0);
}

async function exchange(identity: SessionRegistryIdentity, snapshot?: Buffer): Promise<Buffer | undefined> {
  // The private key broker can serve a registry-key request while the console
  // attaches. Retry transient busy/not-ready errors without retrying invalid
  // framing, identity mismatches or permission failures.
  const deadline = Date.now() + PRIVATE_TIMEOUT_MS;
  while (true) {
    try {
      return await exchangeOnce(identity, snapshot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOENT", "ECONNREFUSED", "EBUSY", "EPIPE"].includes(code ?? "") ||
          Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

function exchangeOnce(identity: SessionRegistryIdentity, snapshot?: Buffer): Promise<Buffer | undefined> {
  if (!isSessionRegistryIdentity(identity)) return Promise.reject(new Error("Invalid runtime startup identity"));
  const endpoint = sessionRegistryKeyEndpoint(identity);
  if (process.platform !== "win32") {
    try {
      const directory = fs.lstatSync(path.dirname(endpoint));
      const socket = fs.lstatSync(endpoint);
      const uid = process.getuid!();
      if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0 ||
          !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) !== 0) {
        throw new Error("Runtime startup endpoint is not private to this user");
      }
    } catch (error) { return Promise.reject(error); }
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint });
    const header = Buffer.alloc(37);
    header.write(snapshot ? "RCSP" : "RCSG", "ascii");
    if (snapshot) header.writeUInt32LE(snapshot.length, 4);
    let chunks: Buffer[] = [];
    let bytes = 0;
    let expected: number | undefined;
    let finished = false;
    const timer = setTimeout(() => finish(new Error("Private startup state transfer timed out")), PRIVATE_TIMEOUT_MS);
    function finish(error?: Error, data?: Buffer): void {
      if (finished) { data?.fill(0); return; }
      finished = true;
      clearTimeout(timer);
      for (const chunk of chunks) chunk.fill(0);
      chunks = [];
      socket.destroy();
      if (error) reject(error); else resolve(data);
    }
    socket.once("connect", () => {
      socket.write(header);
      if (snapshot) socket.write(snapshot);
    });
    socket.on("error", error => finish(error));
    socket.on("close", () => { if (!finished) finish(new Error("Private startup state connection closed")); });
    socket.on("data", chunk => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > 12 + MAX_PRIVATE_STARTUP_STATE_BYTES) {
        chunk.fill(0);
        finish(new Error("Private startup state response exceeds size limit"));
        return;
      }
      chunks.push(Buffer.from(chunk));
      if (bytes >= 12 && expected === undefined) {
        const prefix = Buffer.concat(chunks, bytes);
        if (prefix.subarray(0, 4).toString("ascii") !== "RCSR" ||
            prefix.readUInt32LE(4) !== identity.pid) {
          prefix.fill(0);
          finish(new Error("Private startup state belongs to a different runtime"));
          return;
        }
        expected = prefix.readUInt32LE(8);
        prefix.fill(0);
        if (expected > MAX_PRIVATE_STARTUP_STATE_BYTES ||
            (snapshot !== undefined && expected !== 1)) {
          finish(new Error("Invalid private startup state response length"));
          return;
        }
      }
      if (expected === undefined || bytes < 12 + expected) return;
      if (bytes !== 12 + expected) {
        finish(new Error("Invalid private startup state response framing"));
        return;
      }
      const result = Buffer.concat(chunks, bytes);
      const payload = Buffer.from(result.subarray(12));
      result.fill(0);
      if (process.platform === "win32") {
        socket.end(Buffer.from("RCK1"), () => finish(undefined, payload));
      } else {
        finish(undefined, payload);
      }
    });
  });
}
