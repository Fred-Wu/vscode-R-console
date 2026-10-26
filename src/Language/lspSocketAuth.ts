import { timingSafeEqual } from "crypto";
import * as net from "net";

export function authenticateLspSocket(
  socket: net.Socket,
  token: string,
  timeoutMs = 15000
): Promise<boolean> {
  const expected = Buffer.from(token, "ascii");
  return new Promise((resolve) => {
    let bytes = Buffer.alloc(0);
    let finished = false;
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
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < expected.length) return;
      const supplied = bytes.subarray(0, expected.length);
      const accepted = expected.length === 64 && timingSafeEqual(supplied, expected);
      finish(accepted, bytes.subarray(expected.length));
    }
    socket.on("data", onData);
    socket.once("close", onDisconnect);
    socket.once("error", onDisconnect);
  });
}
