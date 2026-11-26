import type { ChildProcess } from "child_process";
import type { Readable } from "stream";

// Matches the R entry point. Startup options can contain large user values.
// Leave room for the authenticated ciphertext envelope in a 16 MiB backend frame.
export const MAX_STARTUP_STATE_BYTES = 16 * 1024 * 1024 - 32;

export interface LspStartupStateStore {
  load(): Promise<Buffer | undefined>;
  save(state: Buffer): Promise<void>;
}

/** Consume the private pipe acknowledgement before any stdio LSP writes. */
export function readStartupAcknowledgement(output: Readable, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(new Error("Language server startup pipe timed out")), timeoutMs);
    function finish(error?: Error): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      output.off("readable", onReadable);
      output.off("end", onEnd);
      output.off("close", onEnd);
      output.off("error", onError);
      if (error) reject(error); else resolve();
    }
    function onReadable(): void {
      const ack: Buffer | null = output.read(4);
      if (ack) finish(ack.equals(Buffer.from("RCS1")) ? undefined :
        new Error("Invalid language server startup pipe acknowledgement"));
    }
    function onEnd(): void { finish(new Error("Language server startup pipe closed")); }
    function onError(): void { finish(new Error("Language server startup pipe failed")); }
    output.on("readable", onReadable);
    output.once("end", onEnd);
    output.once("close", onEnd);
    output.once("error", onError);
  });
}

/** Decode the opaque R envelope received over the spawned child's stdout pipe. */
export function decodeStartupState(value: unknown): Buffer {
  if (typeof value !== "string" || !value.length ||
      value.length > Math.ceil(MAX_STARTUP_STATE_BYTES / 3) * 4) {
    throw new Error("Invalid language server startup state");
  }
  const state = Buffer.from(value, "base64");
  if (!state.length || state.length > MAX_STARTUP_STATE_BYTES || state.toString("base64") !== value) {
    state.fill(0);
    throw new Error("Invalid language server startup state size");
  }
  return state;
}

/** Read a startup snapshot from this exact child's stdout, not an LSP socket.
 * R startup profiles can write to stdout first, so seek a random per-spawn
 * marker. No prefix is logged, and unread LSP bytes remain in the stream. */
export function readPrivateStartupState(output: Readable, nonce: string, timeoutMs = 30_000): Promise<Buffer> {
  if (!/^[0-9a-f]{32}$/.test(nonce)) return Promise.reject(new Error("Invalid startup pipe marker"));
  const marker = Buffer.from(`RCS2${nonce}:`, "ascii");
  const maximumEncoded = Math.ceil(MAX_STARTUP_STATE_BYTES / 3) * 4;
  return new Promise((resolve, reject) => {
    let found = false;
    let tail = Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let encodedLength = 0;
    let finished = false;
    const timer = setTimeout(() => finish(new Error("Language server private startup pipe timed out")), timeoutMs);
    function finish(error?: Error, snapshot?: Buffer): void {
      if (finished) { snapshot?.fill(0); return; }
      finished = true;
      clearTimeout(timer);
      output.off("readable", onReadable);
      output.off("end", onEnd);
      output.off("close", onEnd);
      output.off("error", onError);
      tail.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      if (error) reject(error); else resolve(snapshot!);
    }
    function onReadable(): void {
      try {
        for (let chunk: Buffer | null; (chunk = output.read()) !== null;) {
          let data: Buffer = chunk;
          if (!found) {
            const candidate = tail.length ? Buffer.concat([tail, data]) : data;
            const at = candidate.indexOf(marker);
            if (at < 0) {
              const keep = Math.min(candidate.length, marker.length - 1);
              tail = Buffer.from(candidate.subarray(candidate.length - keep));
              continue;
            }
            found = true;
            data = candidate.subarray(at + marker.length);
            tail = Buffer.alloc(0);
          }
          const newline = data.indexOf(10);
          const part = newline < 0 ? data : data.subarray(0, newline);
          encodedLength += part.length;
          if (encodedLength > maximumEncoded + 1) throw new Error("Invalid language server private startup pipe size");
          if (part.length) chunks.push(Buffer.from(part));
          if (newline < 0) continue;
          if (newline + 1 < data.length) output.unshift(data.subarray(newline + 1));
          const encoded = Buffer.concat(chunks, encodedLength).toString("ascii").replace(/\r$/, "");
          finish(undefined, decodeStartupState(encoded));
          return;
        }
      } catch {
        finish(new Error("Invalid language server private startup pipe"));
      }
    }
    function onEnd(): void { finish(new Error("Language server private startup pipe closed")); }
    function onError(): void { finish(new Error("Language server private startup pipe failed")); }
    output.on("readable", onReadable);
    output.once("end", onEnd);
    output.once("close", onEnd);
    output.once("error", onError);
    onReadable();
  });
}

/** The OS supplies this pipe directly to our child, before R loads packages. */
export function writeStartupState(child: ChildProcess, state: Buffer, onError: (error: Error) => void): void {
  if (!child.stdin) throw new Error("Language server startup requires a private input pipe");
  if (!state.length || state.length > MAX_STARTUP_STATE_BYTES) {
    throw new Error("Invalid language server startup state size");
  }
  child.stdin.on("error", onError);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(state.length);
  // Write before exposing stdin to the LSP writer. The stream preserves order
  // and handles backpressure for the bounded payload. Stdio LSP keeps it open.
  child.stdin.write(header);
  child.stdin.write(state);
}
