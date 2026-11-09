import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { encodeShutdownFrame, parseBackendFrames } from "./backendProtocol";
import { getPersistedRuntimePid, isLegacyConsoleRecord, isProcessAlive, type LegacyConsoleRecord } from "./persistentSessionRegistry";

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LegacyProcessStatus = {
  state: "verified" | "stopped" | "unverified";
  pid?: number;
  reason?: string;
};

export async function inspectLegacySession(entry: LegacyConsoleRecord): Promise<LegacyProcessStatus> {
  const pid = getPersistedRuntimePid(entry.terminal);
  const unverified = (reason: string): LegacyProcessStatus => ({ state: "unverified", pid, reason });
  if (!isLegacyConsoleRecord(entry)) return unverified("This is not a session from before authentication was introduced.");
  if (!pid) return unverified("The saved session does not identify its process.");
  if (!isProcessAlive(pid)) return { state: "stopped", pid };
  const { sessionId, port } = entry.terminal.runtime;
  if (!UUID.test(sessionId)) return unverified("The saved session ID is invalid.");
  const bootstrap = path.join(os.tmpdir(), `r-console-session-${sessionId}.json`);
  try {
    const info = JSON.parse(await fs.promises.readFile(bootstrap, "utf8"));
    const stat = await fs.promises.stat(bootstrap);
    if (info.pid !== pid || info.port !== port) {
      return unverified("The session's connection file no longer matches its saved PID and port.");
    }
    if (process.platform === "win32") {
      // Numeric PID only; no user-controlled path or shell text is interpolated.
      const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
        `[pscustomobject]@{name=$p.ProcessName; startedMs=([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress`;
      const { stdout } = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true, timeout: 5000, maxBuffer: 65536,
      });
      const identity = JSON.parse(stdout.trim());
      // A reused PID starts after the original bootstrap file was created.
      if (identity.name !== "R_CONSOLE_HOST" || !Number.isFinite(identity.startedMs) ||
          stat.birthtimeMs <= 0 || identity.startedMs > stat.birthtimeMs) {
        return unverified("The recorded PID no longer identifies the original R Console backend.");
      }
    } else if (process.platform === "linux") {
      const [executable, environment] = await Promise.all([
        fs.promises.readlink(`/proc/${pid}/exe`), fs.promises.readFile(`/proc/${pid}/environ`, "utf8"),
      ]);
      if (path.basename(executable.replace(/ \(deleted\)$/, "")) !== "R_CONSOLE_HOST" ||
          !environment.split("\0").includes(`VSC_R_BACKEND_SESSION_FILE=${bootstrap}`)) {
        return unverified("The recorded PID belongs to a different process or session.");
      }
    } else if (process.platform === "darwin") {
      const [command, environment] = await Promise.all([
        execute("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 5000 }),
        execute("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], { timeout: 5000, maxBuffer: 1024 * 1024 }),
      ]);
      const marker = `VSC_R_BACKEND_SESSION_FILE=${bootstrap}`;
      if (path.basename(command.stdout.trim()) !== "R_CONSOLE_HOST" ||
          !(`${environment.stdout.trim()} `).includes(`${marker} `)) {
        return unverified("The recorded PID belongs to a different process or session.");
      }
    } else {
      return unverified("Process verification is unavailable on this platform.");
    }
    return { state: "verified", pid };
  } catch {
    return isProcessAlive(pid)
      ? unverified("The original process could not be verified. Its saved record has been kept.")
      : { state: "stopped", pid };
  }
}

/** Explicit, confirmed cleanup only. Never used as an authentication fallback. */
export async function closeLegacySession(entry: LegacyConsoleRecord): Promise<void> {
  // Verify identity after the user chooses Close, immediately before connecting.
  const status = await inspectLegacySession(entry);
  if (status.state === "stopped") return;
  if (status.state !== "verified") throw new Error(status.reason);
  const pid = status.pid!;
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: entry.terminal.runtime.port });
    let carry: Buffer = Buffer.alloc(0);
    let bytes = 0;
    let ready = false;
    let matchedPid = false;
    let sent = false;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("The old session did not acknowledge shutdown. Its record has been kept.")), 5000);
    // Windows can reset the stream as the backend exits. After sending shutdown,
    // process exit below is the success criterion, not a clean TCP close.
    socket.on("error", (error) => finish(sent ? undefined : error));
    socket.on("close", () => finish(sent ? undefined : new Error("The old session closed before its identity could be checked.")));
    socket.on("data", (chunk: Buffer) => {
      if (sent) return;
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { finish(new Error("Unexpected old-session response.")); return; }
      const parsed = parseBackendFrames(chunk, carry);
      carry = parsed.carry;
      // In particular, a modern authentication challenge is rejected here.
      if (parsed.error) { finish(new Error("The endpoint is not a compatible old R Console session.")); return; }
      for (const event of parsed.events) {
        if (event.type === "backend-ready") {
          ready = event.protocolVersion === 1 && event.backend === "embedded-r-host" && event.capabilities.includes("shutdown");
        } else if (event.type === "session-state") {
          if (event.pid !== pid) { finish(new Error("The endpoint belongs to a different process.")); return; }
          matchedPid = true;
        }
      }
      if (ready && matchedPid) {
        sent = true;
        // This is the only command sent. Use the verified connection rather
        // than killing a PID that could be reused between inspection and exit.
        socket.end(encodeShutdownFrame());
      }
    });
  });
  const deadline = Date.now() + 5000;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error("The old session is still running after shutdown. Its record has been kept.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
