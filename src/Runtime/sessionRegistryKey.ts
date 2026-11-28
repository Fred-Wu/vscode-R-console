import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { execFile, execFileSync } from "child_process";

export type SessionRegistryIdentity = { sessionId: string; pid: number };
export type SessionRegistryKeyReader = (identity: SessionRegistryIdentity) => Promise<Buffer>;

export function isSessionRegistryIdentity(value: unknown): value is SessionRegistryIdentity {
  const item = value as SessionRegistryIdentity | undefined;
  return !!item && typeof item.sessionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.sessionId) &&
    Number.isSafeInteger(item.pid) && item.pid > 0 && item.pid <= 0xffffffff;
}

export function sessionRegistryKeyEndpoints(identity: SessionRegistryIdentity): string[] {
  if (!isSessionRegistryIdentity(identity)) throw new Error("Invalid session key identity");
  if (process.platform === "win32") return [`\\\\.\\pipe\\r-console-key-${identity.sessionId}`];
  if (!process.getuid) throw new Error("Private session keys are unavailable on this platform");
  const uid = process.getuid();
  const bases = process.platform === "darwin"
    ? [() => execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 1000 }).trim()]
    : [...(process.platform === "linux" ? [() => `/run/user/${uid}`] : []), () => os.userInfo().homedir];
  const endpoints: string[] = [];
  let failure: unknown;
  for (const base of bases) {
    try {
      const home = fs.realpathSync.native(base());
      for (let directory = home;; directory = path.dirname(directory)) {
        const stat = fs.lstatSync(directory);
        const owner = directory === home ? stat.uid === uid : stat.uid === uid || stat.uid === 0;
        const protectedEntry = (stat.mode & 0o022) === 0 ||
          (directory !== home && stat.uid === 0 && (stat.mode & 0o1000) !== 0);
        if (!stat.isDirectory() || !owner || !protectedEntry) throw new Error("Session key home is not protected from other users");
        if (directory === path.dirname(directory)) break;
      }
      endpoints.push(path.join(home, ".r-console", identity.sessionId.replace(/-/g, "")));
    } catch (error) { failure = error; }
  }
  if (!endpoints.length) throw failure;
  return [...new Set(endpoints)];
}

/** The broker uses a private Unix directory/socket or a local-only named pipe
 * with a user-only DACL. Its key is created and retained by the Rust runtime.
 * Endpoints are derived locally; a saved record cannot choose a network path. */
export async function readSessionRegistryKey(identity: SessionRegistryIdentity, nativeHelper?: string): Promise<Buffer> {
  const endpoints = sessionRegistryKeyEndpoints(identity);
  if (process.platform === "win32") {
    if (!nativeHelper) throw new Error("Native session key verification is unavailable");
    return new Promise((resolve, reject) => {
      // The packaged helper owns the pipe handle through verification and read.
      // Its anonymous stdout pipe carries only the key, with no shell involved.
      execFile(nativeHelper, ["--read-session-key", identity.sessionId, String(identity.pid)],
        { encoding: "buffer", timeout: 3500, maxBuffer: 4096, windowsHide: true }, (error, stdout, stderr) => {
          stderr.fill(0);
          if (error || stdout.length !== 32) {
            stdout.fill(0);
            reject(new Error("Session key broker could not be authenticated or read"));
          } else resolve(stdout);
        });
    });
  }
  const request = Buffer.alloc(37);
  request.write("RCK1", "ascii");
  const deadline = Date.now() + 3000;
  while (true) {
    let failure: unknown;
    let retryable = true;
    for (const endpoint of endpoints) {
      try {
        const directory = fs.lstatSync(path.dirname(endpoint));
        const socket = fs.lstatSync(endpoint);
        const uid = process.getuid!();
        if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0 ||
            !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) !== 0) {
          throw new Error("Session key endpoint is not private to this user");
        }
        // Linux sockaddr_un has 108 bytes including its terminating NUL. Keep
        // the socket in the protected account directory and address long paths
        // through a held directory descriptor. HOME/TMPDIR never select a peer.
        let directoryFd: number | undefined;
        try {
          let connectPath = endpoint;
          if (process.platform === "linux" && Buffer.byteLength(endpoint) >= 108) {
            directoryFd = fs.openSync(path.dirname(endpoint), fs.constants.O_RDONLY |
              fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            const opened = fs.fstatSync(directoryFd);
            if (!opened.isDirectory() || opened.uid !== uid || (opened.mode & 0o077) !== 0 ||
                opened.dev !== directory.dev || opened.ino !== directory.ino) {
              throw new Error("Session key directory changed before connection");
            }
            connectPath = `/proc/self/fd/${directoryFd}/${path.basename(endpoint)}`;
          }
          return await receiveKey(connectPath, identity.pid, request, Math.max(1, deadline - Date.now()));
        } finally {
          if (directoryFd !== undefined) fs.closeSync(directoryFd);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        failure = error;
        retryable &&= ["ENOENT", "ECONNREFUSED", "EBUSY", "EPIPE"].includes(code ?? "");
      }
    }
    if (!retryable || Date.now() >= deadline) throw failure;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function receiveKey(endpoint: string, pid: number, request: Buffer, timeout: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint });
    let bytes = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Session key request timed out")), timeout);
    socket.once("connect", () => socket.write(request));
    function finish(error?: Error, key?: Buffer): void {
      if (settled) { key?.fill(0); return; }
      settled = true;
      clearTimeout(timer);
      bytes.fill(0);
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
        finish(new Error("Invalid session key response"));
        return;
      }
      const key = Buffer.from(bytes.subarray(9));
      finish(undefined, key);
    });
  });
}
