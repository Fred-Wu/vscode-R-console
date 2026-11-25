import type { ChildProcess } from "child_process";
import type { Readable } from "stream";

// Matches the R entry point. Startup options can contain large user values.
export const MAX_STARTUP_STATE_BYTES = 16 * 1024 * 1024;

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

/** Decode the opaque R envelope received over the private LSP transport. */
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
