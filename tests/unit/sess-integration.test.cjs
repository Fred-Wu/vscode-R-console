const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { canSubmitRuntimeHiddenCommand, submitRuntimeHiddenCommand } =
  loadSource("src/Terminal/rTerminal/runtime.ts", { vscode: {} });

const settle = () => new Promise((resolve) => setImmediate(resolve));

class Socket extends EventEmitter {
  destroyed = false;
  destroy() { this.destroyed = true; }
  write() {}
}

function setup(t, { httpgd, jgd, rstudio = false, socket } = {}) {
  const servers = [];
  const submissions = [];
  const warnings = [];
  let clipboard = "original clipboard";
  let discoveries = 0;
  let settings = rstudio;
  const command = 'source("/vscode-r/attach.R")';
  const connectArgs = ["pipe_path = pipe_path"];
  if (httpgd !== undefined) connectArgs.push(`use_httpgd = ${httpgd ? "TRUE" : "FALSE"}`);
  if (jgd !== undefined) connectArgs.push(`use_jgd = ${jgd ? "TRUE" : "FALSE"}`);
  const script = [
    'local({',
    'pipe_path <- "upstream.sock"',
    socket ? `Sys.setenv(JGD_SOCKET = ${JSON.stringify(socket)})` : "",
    `sess::connect(${connectArgs.join(", ")})`,
    '})',
  ].join("\n");
  const { SessVscodeRIntegration } = loadSource("src/Runtime/VSCR/sess/integration.ts", {
    fs: {
      existsSync: () => true,
      promises: {
        readdir: async () => [],
        readFile: async () => script,
        rm: async () => {},
        chmod: async () => {},
        mkdir: async () => {},
        writeFile: async () => {},
      },
    },
    net: {
      createServer: (accept) => {
        const server = new EventEmitter();
        server.accept = accept;
        server.listen = (pipe, callback) => { server.pipe = pipe; callback(); };
        server.close = () => { server.closed = true; };
        servers.push(server);
        return server;
      },
      createConnection: () => new Socket(),
    },
    vscode: {
      extensions: { getExtension: () => ({ isActive: true }) },
      workspace: { getConfiguration: () => ({ get: () => settings }) },
      env: { clipboard: {
        readText: async () => clipboard,
        writeText: async (text) => { clipboard = text; },
      } },
      commands: { executeCommand: async (name) => {
        assert.equal(name, "r.connectToSession");
        discoveries++;
        clipboard = command;
      } },
      window: { showWarningMessage: (message) => warnings.push(message) },
    },
  });
  function host(rProcess = null) {
    const value = {
      extensionPath: "/console", rProcess,
      mode: "ready", promptReady: true, promptKind: "main",
      activeSubmission: null, submissionPending: false, inputState: { text: "" },
      clearPromptRenderTimer() {}, clearInputRender() {}, onSessionDataChanged() {},
      runtimeBackend: {
        getPid: () => undefined,
        canUseSessionCommands: () => true,
        sendSessionCommand: (_session, request) => { submissions.push(request.code); return true; },
      },
      canSubmitHiddenCommand: () => canSubmitRuntimeHiddenCommand(value),
      submitHiddenCommand: (code) => submitRuntimeHiddenCommand(value, code),
    };
    return value;
  }
  t.after(() => SessVscodeRIntegration.disposeForRuntimeSession("session"));
  return {
    Integration: SessVscodeRIntegration, host, servers, submissions, warnings, command,
    clipboard: () => clipboard, discoveries: () => discoveries,
    changeSettings: () => { settings = !settings; },
  };
}

for (const [httpgd, jgd, backend] of [
  [true, true, "auto"], [true, false, "httpgd"],
  [false, true, "jgd"], [false, false, "standard"],
  [undefined, undefined, undefined], [false, undefined, undefined],
  [undefined, true, undefined],
]) {
  for (const rstudio of [false, true]) {
    test(`sess startup and reconnect preserve flags (${httpgd}, ${jgd}, RStudio=${rstudio})`, async (t) => {
      const fixture = setup(t, { httpgd, jgd, rstudio, socket: jgd ? 'C:\\plot "socket"' : undefined });
      const host = fixture.host();
      const integration = new fixture.Integration(host);
      t.after(() => integration.handleRuntimeExit());
      const env = { SESS_PLOT_BACKEND: "stale", JGD_SOCKET: "stale" };
      await integration.prepareStart(env);
      host.rProcess = { sessionId: "session" };
      integration.afterRuntimeStarted();
      assert.equal(env.SESS_PIPE, fixture.servers[0].pipe);
      assert.equal(env.SESS_RSTUDIOAPI, rstudio ? "TRUE" : "FALSE");
      assert.equal(env.SESS_USE_HTTPGD, (httpgd ?? true) ? "TRUE" : "FALSE");
      assert.equal(env.SESS_USE_JGD, (jgd ?? false) ? "TRUE" : "FALSE");
      assert.equal(env.SESS_PLOT_BACKEND, backend);
      assert.equal(env.JGD_SOCKET, jgd ? 'C:\\plot "socket"' : undefined);
      assert.equal(fixture.clipboard(), "original clipboard");
      assert.deepEqual(fixture.warnings, []);

      // Reuse a live proxy after detaching the UI, then lose its R connection
      // before the first prompt. Reconnect must retain the original settings.
      const rSocket = new Socket();
      fixture.servers[0].accept(rSocket);
      assert.equal(integration.isRedundantAttachSubmission(` ${fixture.command} `), true);
      assert.equal(integration.isRedundantAttachSubmission("1 + 1"), false);
      integration.disposeUi();
      fixture.changeSettings();
      const restored = new fixture.Integration(fixture.host(host.rProcess));
      restored.attachRuntime();
      restored.setActive(true);
      await settle();
      assert.equal(fixture.discoveries(), 1);
      assert.equal(restored.isRedundantAttachSubmission(fixture.command), true);
      rSocket.destroy();
      assert.equal(restored.isRedundantAttachSubmission(fixture.command), false);
      restored.handleMainPrompt();
      await settle();
      assert.equal(fixture.submissions.length, 1);
      const reconnect = fixture.submissions[0];
      assert.ok(reconnect.includes(`pipe_path="${env.SESS_PIPE.replace(/\\/g, "\\\\")}"`));
      assert.ok(reconnect.includes(`use_rstudioapi=${env.SESS_RSTUDIOAPI}`));
      assert.ok(reconnect.includes(`use_httpgd=${env.SESS_USE_HTTPGD}`));
      assert.ok(reconnect.includes(`use_jgd=${env.SESS_USE_JGD}`));
      assert.ok(reconnect.includes(jgd
        ? 'Sys.setenv(JGD_SOCKET="C:\\\\plot \\"socket\\"")'
        : 'Sys.unsetenv("JGD_SOCKET")'));
      assert.equal(fixture.discoveries(), 1);
    });
  }
}

test("sess restoration discovers a replacement for a disconnected proxy and defers commands until focused", async (t) => {
  const fixture = setup(t, { httpgd: false, jgd: false });
  const host = fixture.host();
  const integration = new fixture.Integration(host);
  await integration.prepareStart({});
  host.rProcess = { sessionId: "session" };
  integration.afterRuntimeStarted();
  integration.disposeUi();
  const restored = new fixture.Integration(fixture.host(host.rProcess));
  restored.attachRuntime();
  restored.handleMainPrompt();
  await settle();
  assert.equal(fixture.discoveries(), 1);
  assert.deepEqual(fixture.submissions, []);
  restored.setActive(true);
  await settle();
  assert.equal(fixture.discoveries(), 2);
  assert.equal(fixture.servers[0].closed, true);
  assert.equal(fixture.submissions.length, 1);
  assert.match(fixture.submissions[0], /use_httpgd=FALSE, use_jgd=FALSE/);
});

test("a live restored proxy is selected with an attach notification, without reconnecting", async (t) => {
  const fixture = setup(t, { httpgd: true, jgd: true });
  const host = fixture.host();
  const integration = new fixture.Integration(host);
  await integration.prepareStart({});
  host.rProcess = { sessionId: "session" };
  integration.afterRuntimeStarted();
  const socket = new Socket();
  fixture.servers[0].accept(socket);
  integration.disposeUi();
  const restored = new fixture.Integration(fixture.host(host.rProcess));
  restored.setActive(true);
  await settle();
  assert.deepEqual(fixture.submissions, []);
  restored.handleMainPrompt();
  await settle();
  assert.equal(fixture.discoveries(), 1);
  assert.equal(fixture.submissions.length, 1);
  assert.match(fixture.submissions[0], /sess::notify_client\("attach"/);
  assert.doesNotMatch(fixture.submissions[0], /sess::connect/);
  fixture.Integration.disposeForRuntimeSession("session");
  assert.equal(socket.destroyed, true);
  assert.equal(fixture.servers[0].closed, true);
});
