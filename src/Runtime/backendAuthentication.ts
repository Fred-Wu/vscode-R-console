import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import * as net from "net";

const HEADER_BYTES = 12;
const FRAME_CHALLENGE = 22;
const FRAME_CLIENT_PROOF = 23;
const FRAME_SERVER_PROOF = 24;
const NONCE_BYTES = 32;
const CLIENT_CONTEXT = Buffer.from("rconsole-backend-client-v2", "ascii");
const SERVER_CONTEXT = Buffer.from("rconsole-backend-server-v2", "ascii");

export class BackendAuthenticationError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "BackendAuthenticationError";
  }
}

function frame(kind: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt16LE(kind, 4);
  return Buffer.concat([header, payload]);
}

function mac(secret: string, context: Buffer, serverNonce: Buffer, clientNonce: Buffer): Buffer {
  return createHmac("sha256", Buffer.from(secret, "ascii"))
    .update(context).update(serverNonce).update(clientNonce).digest();
}

/** Both peers prove the shared secret without transmitting it over TCP. */
export function authenticateBackendSocket(socket: net.Socket, token: string, timeoutMs = 3000): Promise<net.Socket> {
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return Promise.reject(new BackendAuthenticationError("Invalid backend authentication credentials."));
  }
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let phase = 0;
    let serverNonce: Buffer | undefined;
    let clientNonce: Buffer | undefined;
    let finished = false;
    const timeout = setTimeout(() => fail(new BackendAuthenticationError("Backend authentication timed out.", true)), timeoutMs);
    function cleanup(): void {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    }
    function fail(error: Error): void {
      if (finished) return;
      finished = true;
      cleanup();
      socket.destroy();
      reject(error);
    }
    function onError(error: Error): void {
      fail(error);
    }
    function onClose(): void {
      fail(new BackendAuthenticationError("Backend closed before mutual authentication.", true));
    }
    function onData(chunk: Buffer): void {
      // The handshake only accepts two exact, bounded frames.
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= HEADER_BYTES && !finished) {
        const length = buffer.readUInt32LE(0);
        const kind = buffer.readUInt16LE(4);
        const requiredKind = phase === 0 ? FRAME_CHALLENGE : FRAME_SERVER_PROOF;
        if (length !== NONCE_BYTES || kind !== requiredKind || buffer.readUInt16LE(6) !== 0 || buffer.readUInt32LE(8) !== 0) {
          fail(new BackendAuthenticationError("Invalid backend authentication frame."));
          return;
        }
        if (buffer.length < HEADER_BYTES + length) return;
        const payload = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
        buffer = buffer.subarray(HEADER_BYTES + length);
        if (phase === 0) {
          serverNonce = Buffer.from(payload);
          clientNonce = randomBytes(NONCE_BYTES);
          socket.write(frame(FRAME_CLIENT_PROOF, Buffer.concat([
            clientNonce, mac(token, CLIENT_CONTEXT, serverNonce, clientNonce),
          ])));
          phase = 1;
        } else {
          const expected = mac(token, SERVER_CONTEXT, serverNonce!, clientNonce!);
          if (!timingSafeEqual(payload, expected)) {
            fail(new BackendAuthenticationError("Backend identity verification failed."));
            return;
          }
          finished = true;
          cleanup();
          socket.pause();
          if (buffer.length) socket.unshift(buffer);
          resolve(socket);
        }
      }
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}
