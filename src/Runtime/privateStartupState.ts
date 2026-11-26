import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { isSessionRegistryIdentity, sessionRegistryKeyEndpoint, type SessionRegistryIdentity } from "./sessionRegistryKey";

// Both sides enforce the same bound. The broker and key reader share an
// OS-protected same-user local endpoint, never the backend's TCP connection.
export const MAX_PRIVATE_STARTUP_STATE_BYTES = 16 * 1024 * 1024 - 32;
const PRIVATE_TIMEOUT_MS = 10_000;

import { createHmac, timingSafeEqual } from "crypto";

const CLIENT_CONTEXT = "rconsole-private-state-client-v1";
const SERVER_CONTEXT = "rconsole-private-state-server-v1";
const CHALLENGE_BYTES = 40;
const RESPONSE_HEADER_BYTES = 12;
const MAC_BYTES = 32;

function mac(context: string, token: string, nonce: Buffer, header: Buffer, payload?: Buffer): Buffer {
  const hash = createHmac("sha256", token);
  hash.update(context, "ascii");
  hash.update(nonce);
  hash.update(header);
  if (payload) hash.update(payload);
  return hash.digest();
}

export async function loadPrivateStartupState(
  identity: SessionRegistryIdentity, authToken: string
): Promise<Buffer | undefined> {
  const bytes = await exchange(identity, authToken);
  return bytes?.length ? bytes : undefined;
}

export async function savePrivateStartupState(
  identity: SessionRegistryIdentity, authToken: string, state: Buffer
): Promise<void> {
  if (!state.length || state.length > MAX_PRIVATE_STARTUP_STATE_BYTES) {
    throw new Error("Invalid private startup state size");
  }
  const response = await exchange(identity, authToken, state);
  if (!response || response.length !== 1 || response[0] !== 0) {
    response?.fill(0);
    throw new Error("Persistent session already has a different startup snapshot");
  }
  response.fill(0);
}

async function exchange(identity: SessionRegistryIdentity, authToken: string, state?: Buffer): Promise<Buffer | undefined> {
  if (!isSessionRegistryIdentity(identity)) throw new Error("Invalid runtime startup identity");
  if (!/^[0-9a-f]{64}$/.test(authToken)) throw new Error("Session authentication unavailable");
  const deadline = Date.now() + PRIVATE_TIMEOUT_MS;
  while (true) {
    try {
      return await exchangeOnce(identity, authToken, state, Math.max(1, deadline - Date.now()));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOENT", "ECONNREFUSED", "EBUSY"].includes(code ?? "") || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

function exchangeOnce(identity: SessionRegistryIdentity, authToken: string,
  state: Buffer | undefined, timeoutMs: number): Promise<Buffer | undefined> {
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
    const request = Buffer.alloc(37);
    request.write(state ? "RCSP" : "RCSG", "ascii");
    if (state) request.writeUInt32LE(state.length, 4);
    let pending = Buffer.alloc(0);
    let serverNonce: Buffer | undefined;
    let expectedResponse: number | undefined;
    let settled = false;
    // Windows can report read EPIPE when the broker disconnects after sending
    // the complete authenticated reply but before Node finishes the final ACK.
    // Never tolerate pipe errors before the response MAC has been validated.
    let verifiedResponse: Buffer | undefined;
    const timer = setTimeout(() => finish(new Error("Private startup state transfer timed out")), timeoutMs);
    function finish(error?: Error, result?: Buffer): void {
      if (settled) { result?.fill(0); return; }
      settled = true;
      clearTimeout(timer);
      pending.fill(0);
      serverNonce?.fill(0);
      request.fill(0);
      if (error) verifiedResponse?.fill(0);
      verifiedResponse = undefined;
      socket.destroy();
      if (error) reject(error); else resolve(result);
    }
    socket.once("connect", () => socket.write(request));
    socket.on("error", error => {
      if (process.platform === "win32" && verifiedResponse &&
          (error as NodeJS.ErrnoException).code === "EPIPE") {
        finish(undefined, verifiedResponse);
      } else {
        finish(error);
      }
    });
    socket.on("close", () => {
      if (settled) return;
      if (process.platform === "win32" && verifiedResponse) finish(undefined, verifiedResponse);
      else finish(new Error("Private startup state connection closed"));
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      const bound = serverNonce
        ? RESPONSE_HEADER_BYTES + MAX_PRIVATE_STARTUP_STATE_BYTES + MAC_BYTES
        : CHALLENGE_BYTES;
      if (pending.length + chunk.length > bound) {
        finish(new Error("Invalid private startup authentication framing"));
        return;
      }
      const bytes = Buffer.concat([pending, chunk]);
      pending.fill(0);
      pending = bytes;
      if (!serverNonce) {
        if (pending.length < CHALLENGE_BYTES) return;
        if (pending.subarray(0, 4).toString("ascii") !== "RCSC" ||
            pending.readUInt32LE(4) !== identity.pid) {
          finish(new Error("Private startup challenge belongs to a different runtime"));
          return;
        }
        serverNonce = Buffer.from(pending.subarray(8));
        pending.fill(0);
        pending = Buffer.alloc(0);
        const clientProof = mac(CLIENT_CONTEXT, authToken, serverNonce, request, state);
        // Do not erase a buffer before the socket finishes sending it.
        socket.write(clientProof, () => clientProof.fill(0));
        if (state) socket.write(state);
        return;
      }
      if (pending.length >= RESPONSE_HEADER_BYTES && expectedResponse === undefined) {
        if (pending.subarray(0, 4).toString("ascii") !== "RCSR" ||
            pending.readUInt32LE(4) !== identity.pid) {
          finish(new Error("Private startup response belongs to a different runtime"));
          return;
        }
        expectedResponse = pending.readUInt32LE(8);
        if (expectedResponse > MAX_PRIVATE_STARTUP_STATE_BYTES ||
            (state !== undefined && expectedResponse !== 1)) {
          finish(new Error("Invalid private startup state response length"));
          return;
        }
      }
      if (expectedResponse === undefined || pending.length < RESPONSE_HEADER_BYTES + expectedResponse + MAC_BYTES) return;
      if (pending.length !== RESPONSE_HEADER_BYTES + expectedResponse + MAC_BYTES) {
        finish(new Error("Invalid private startup response framing"));
        return;
      }
      const proofBytes = pending.subarray(RESPONSE_HEADER_BYTES + expectedResponse);
      const expected = mac(SERVER_CONTEXT, authToken, serverNonce, request,
        pending.subarray(0, RESPONSE_HEADER_BYTES + expectedResponse));
      const valid = timingSafeEqual(proofBytes, expected);
      expected.fill(0);
      if (!valid) {
        finish(new Error("Private startup response authentication failed"));
        return;
      }
      const result = Buffer.from(pending.subarray(RESPONSE_HEADER_BYTES, RESPONSE_HEADER_BYTES + expectedResponse));
      if (process.platform === "win32") {
        // The broker's disconnect does not invalidate an already authenticated
        // response. Still attempt the ACK so the broker can serve the next call.
        verifiedResponse = result;
        socket.end(Buffer.from("RCK1"), () => { if (!settled) finish(undefined, result); });
      } else {
        finish(undefined, result);
      }
    });
  });
}
