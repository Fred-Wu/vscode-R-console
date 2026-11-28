const { spawn } = require("node:child_process");

// Windows PowerShell can take much longer to initialize on a busy CI runner
// than the pipe operation itself. Keep startup and script deadlines separate.
function runPowerShell(script, { env = process.env, signal, startupTimeout = 60000, timeout = 15000 } = {}) {
  const ready = "R_CONSOLE_POWERSHELL_READY";
  const command = `
    $ErrorActionPreference = 'Stop'
    [Console]::Error.WriteLine('${ready}')
    try { & {
      ${script}
    } } catch {
      [Console]::Error.WriteLine($_.ToString())
      exit 1
    }
  `;
  return new Promise((resolve, reject) => {
    // Ignore stdin explicitly: neither PowerShell nor the probe consumes it.
    // Text output avoids CLIXML; encoding preserves multiline command text.
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive",
      "-InputFormat", "Text", "-OutputFormat", "Text", "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64")], {
      env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal,
    });
    let stdout = "", stderr = "", started = false, failure;
    const expire = phase => {
      failure = new Error(`PowerShell ${phase} timed out`);
      child.kill();
    };
    let timer = setTimeout(() => expire("startup"), startupTimeout);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => {
      stderr += chunk;
      if (!started && stderr.split(/\r?\n/).includes(ready)) {
        started = true;
        clearTimeout(timer);
        timer = setTimeout(() => expire("script"), timeout);
      }
    });
    child.once("error", error => { failure ??= error; });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      stderr = stderr.replace(ready + "\r\n", "").replace(ready + "\n", "");
      if (failure || code !== 0 || !started) {
        const error = failure ?? new Error(`PowerShell ${started ? "script" : "startup"} exited (${code ?? exitSignal})`);
        reject(Object.assign(error, { stdout, stderr }));
      } else resolve({ stdout, stderr });
    });
  });
}

module.exports = { runPowerShell };
