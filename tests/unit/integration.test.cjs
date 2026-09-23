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
  const env = { PATH: "keep", R_HOME: "keep", VSCODE_INIT_R: "old", SESS_PIPE: "old", SESS_TOKEN: "old", SESS_RSTUDIOAPI: "old", SESS_PLOT_BACKEND: "old", SESS_USE_HTTPGD: "old", SESS_USE_JGD: "old", R_CONSOLE_SESSION_BOOTSTRAP: "old" };
  sanitizeVscodeRIntegrationEnv(env);
  assert.deepEqual(env, { PATH: "keep", R_HOME: "keep" });
});
