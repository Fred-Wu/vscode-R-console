import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import * as net from "net";
import { BACKEND_AUTH_TIMEOUT_MS } from "../Runtime/backendAuthentication";

const NONCE_BYTES = 32;
const SECRET_BYTES = 64;
const SERVER_CONTEXT = Buffer.from("rconsole-lsp-server-v2", "ascii");
const CLIENT_CONTEXT = Buffer.from("rconsole-lsp-client-v2", "ascii");

function proof(token: string, context: Buffer, clientNonce: Buffer, serverNonce: Buffer): Buffer {
  return createHmac("sha256", Buffer.from(token, "ascii"))
    .update(context).update(clientNonce).update(serverNonce).digest();
}

/** Authenticate the R process to VS Code, and VS Code to the R process. */
export function authenticateLspSocket(
  socket: net.Socket,
  token: string,
  timeoutMs = BACKEND_AUTH_TIMEOUT_MS,
  expectedClientNonce?: string
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(token)) {
    socket.destroy();
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let received = Buffer.alloc(0);
    let finished = false;
    let phase = 0;
    let clientNonce: Buffer | undefined;
    let serverNonce: Buffer | undefined;
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(authenticated: boolean, extra = Buffer.alloc(0)): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onDisconnect);
      socket.off("error", onDisconnect);
      socket.pause();
      if (authenticated && extra.length) socket.unshift(extra);
      if (!authenticated) socket.destroy();
      resolve(authenticated);
    }
    function onDisconnect(): void { finish(false); }
    function onData(chunk: Buffer): void {
      received = Buffer.concat([received, chunk]);
      if (phase === 0 && received.length >= NONCE_BYTES) {
        clientNonce = Buffer.from(received.subarray(0, NONCE_BYTES));
        received = received.subarray(NONCE_BYTES);
        if (expectedClientNonce) {
          if (!/^[0-9a-f]{64}$/.test(expectedClientNonce) ||
              !timingSafeEqual(clientNonce, Buffer.from(expectedClientNonce, "hex"))) {
            finish(false);
            return;
          }
        }
        serverNonce = randomBytes(NONCE_BYTES);
        socket.write(Buffer.concat([
          serverNonce, proof(token, SERVER_CONTEXT, clientNonce, serverNonce),
        ]));
        phase = 1;
      }
      if (phase === 1 && received.length >= NONCE_BYTES) {
        const expected = proof(token, CLIENT_CONTEXT, clientNonce!, serverNonce!);
        const actual = received.subarray(0, NONCE_BYTES);
        finish(timingSafeEqual(expected, actual), received.subarray(NONCE_BYTES));
      }
      // A pre-authentication peer cannot buffer unlimited arbitrary traffic.
      if (received.length > SECRET_BYTES && !finished) finish(false);
    }
    socket.on("data", onData);
    socket.once("close", onDisconnect);
    socket.once("error", onDisconnect);
  });
}
