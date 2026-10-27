const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

test("vscode-R selects disabled, legacy, or sess integration by available capabilities", () => {
  let extension;
  let hasLegacyInit = false;
  const { resolveVscodeRIntegrationOptions, sanitizeVscodeRIntegrationEnv } = loadSource("src/Runtime/VSCR/config.ts", {
    fs: { existsSync: () => hasLegacyInit },
    vscode: {
      extensions: { getExtension: () => extension },
      window: { showWarningMessage: () => {} },
    },
  });
  assert.equal(resolveVscodeRIntegrationOptions(false).kind, "disabled");
  assert.equal(resolveVscodeRIntegrationOptions(true).kind, "disabled");
  extension = { extensionPath: "/vscode-r", packageJSON: {} };
  hasLegacyInit = true;
  assert.equal(resolveVscodeRIntegrationOptions(true).kind, "legacy");
  extension.packageJSON.contributes = { commands: [{ command: "r.connectToSession" }] };
  assert.equal(resolveVscodeRIntegrationOptions(true).kind, "sess");
  const env = { PATH: "keep", R_HOME: "keep", VSCODE_INIT_R: "old", SESS_ENDPOINT: "old", SESS_DISCOVERY_FILE: "old", SESS_PIPE: "old", SESS_TOKEN: "old", SESS_PLOT_BACKEND: "jgd", R_CONSOLE_SESSION_BOOTSTRAP: "old" };
  sanitizeVscodeRIntegrationEnv(env);
  assert.deepEqual(env, { PATH: "keep", R_HOME: "keep" });
});

test("disabled and legacy integration remove inherited sess discovery settings", async () => {
  const { DisabledVscodeRIntegration } = loadSource("src/Runtime/VSCR/disabled/integration.ts");
  const { LegacyVscodeRIntegration } = loadSource("src/Runtime/VSCR/legacy/integration.ts", {
    fs: { existsSync: () => true, mkdirSync: () => {}, chmodSync: () => {} },
  });
  const host = { extensionPath: "/console", onSessionDataChanged: () => {} };
  for (const integration of [
    new DisabledVscodeRIntegration(host),
    new LegacyVscodeRIntegration(host, { initPath: "/init.R", watcherDir: "/watcher" }),
  ]) {
    const env = { SESS_ENDPOINT: "old", SESS_DISCOVERY_FILE: "another-terminal", SESS_PLOT_BACKEND: "jgd", PATH: "keep" };
    await integration.prepareStart(env);
    assert.equal(env.SESS_ENDPOINT, undefined);
    assert.equal(env.SESS_DISCOVERY_FILE, undefined);
    assert.equal(env.SESS_PLOT_BACKEND, undefined);
    assert.equal(env.PATH, "keep");
  }
});

test("legacy session watcher does not forward credentials to remote hosts", () => {
  const loadSource = require("../helpers/load-source.cjs");
  const { SessionWatcher } = loadSource("src/Runtime/VSCR/legacy/sessionWatcher.ts");
  const watcher = new SessionWatcher("unused");
  assert.equal(watcher.parseServerInfo({ host: "example.com", port: 8888, token: "secret" }), undefined);
  assert.equal(watcher.parseServerInfo({ host: "127.0.0.1", port: 8888, token: "secret" }).host, "127.0.0.1");
  assert.equal(watcher.parseServerInfo({ host: "localhost", port: 65536, token: "secret" }), undefined);
});


test("legacy watcher directory is owner-only before IPC metadata is shared", { skip: process.platform === "win32" }, (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vrc-watcher-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o755);
  const { SessionWatcher } = loadSource("src/Runtime/VSCR/legacy/sessionWatcher.ts");
  const watcher = new SessionWatcher(dir);
  t.after(() => watcher.dispose());
  watcher.start();
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});
