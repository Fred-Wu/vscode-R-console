const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

const workspace = { search: [".GlobalEnv"], loaded_namespaces: ["base"], globalenv: {} };
const attach = { jsonrpc: "2.0", method: "attach", params: {
  protocol_version: 1, session_id: "stable-r-session", host: "test-host",
  sess_version: "0.1.0", pid: 123, tempdir: "/tmp/R", wd: "/workspace",
} };
const send = (socket, message) => socket.write(`${JSON.stringify(message)}\n`);

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for session traffic");
    await delay(5);
  }
}

function readMessages(socket, listener) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      listener(JSON.parse(line));
    }
  });
}

async function upstream(t) {
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\vrc-test-${randomUUID()}`
    : path.join(os.tmpdir(), `vrc-${randomUUID().slice(0, 8)}.sock`);
  const sockets = [];
  const messages = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    readMessages(socket, (message) => messages.push(message));
  });
  server.listen(endpoint);
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { endpoint, sockets, messages };
}

async function connectR(t, endpoint, respond = true) {
  const socket = net.createConnection(endpoint);
  t.after(() => socket.destroy());
  const messages = [];
  readMessages(socket, (message) => {
    messages.push(message);
    if (respond && message.method === "workspace") {
      send(socket, { jsonrpc: "2.0", id: message.id, result: workspace });
    }
  });
  await once(socket, "connect");
  return { socket, messages };
}

function integrationFixture(t, info, overrides = {}) {
  const activations = [];
  const warnings = [];
  const commands = [];
  let discoveries = 0;
  let obsoleteFileAccesses = 0;
  const session = {
    getConnectionInfo: async () => { discoveries++; return info; },
    activate: async (id) => { activations.push(id); return true; },
    ...overrides,
  };
  const extension = { isActive: false, activate: async () => ({ session }) };
  const { SessVscodeRIntegration } = loadSource("src/Runtime/VSCR/sess/integration.ts", {
    fs: { ...fs, promises: { ...fs.promises,
      readdir: async () => { obsoleteFileAccesses++; return []; },
      writeFile: async () => { obsoleteFileAccesses++; },
    } },
    vscode: {
      extensions: { getExtension: () => extension },
      workspace: { getConfiguration: () => ({ get: () => false }) },
      window: { showWarningMessage: (message) => warnings.push(message) },
    },
  });
  const host = {
    extensionPath: path.resolve(__dirname, "../.."),
    onSessionDataChanged: () => {},
    mode: "ready", promptReady: true, promptKind: "main", activeSubmission: null,
    submissionPending: false, inputState: { text: "" },
    clearPromptRenderTimer: () => {}, clearInputRender: () => {},
    runtimeBackend: {
      getPid: () => undefined,
      canUseSessionCommands: () => true,
      sendSessionCommand: (_runtime, command) => { commands.push(command); return true; },
    },
  };
  const integrations = [];
  const create = () => {
    const integration = new SessVscodeRIntegration(host);
    integrations.push(integration);
    return integration;
  };
  t.after(() => integrations.forEach((integration) => integration.handleRuntimeExit()));
  return { create, host, extension, activations, warnings, commands,
    discoveries: () => discoveries, obsoleteFileAccesses: () => obsoleteFileAccesses };
}

test("sess launch uses the public protocol API and resolved plot preferences without discovery files", async (t) => {
  for (const [plotBackend, httpgd, jgd] of [
    ["auto", "TRUE", "TRUE"], ["standard", "FALSE", "FALSE"],
    ["httpgd", "TRUE", "FALSE"], ["jgd", "FALSE", "TRUE"],
  ]) {
    await t.test(plotBackend, async (t) => {
      const fixture = integrationFixture(t, {
        protocolVersion: 1, endpoint: "upstream", plotBackend,
        ...(jgd === "TRUE" ? { jgdSocket: "plot-socket" } : {}),
      });
      const integration = fixture.create();
      const env = { SESS_DISCOVERY_FILE: "inherited", SESS_PIPE: "old", JGD_SOCKET: "old" };
      await integration.prepareStart(env);
      assert.ok(env.SESS_ENDPOINT);
      assert.notEqual(env.SESS_ENDPOINT, "upstream");
      assert.ok(env.R_CONSOLE_SESSION_BOOTSTRAP.endsWith("sess.R"));
      assert.equal(env.SESS_DISCOVERY_FILE, undefined);
      assert.equal(env.SESS_PIPE, undefined);
      assert.equal(env.SESS_RSTUDIOAPI, "FALSE");
      assert.equal(env.SESS_USE_HTTPGD, httpgd);
      assert.equal(env.SESS_USE_JGD, jgd);
      assert.equal(env.JGD_SOCKET, jgd === "TRUE" ? "plot-socket" : undefined);
      integration.handleRuntimePid(process.pid);
      integration.handleHostConnected();
      assert.equal(fixture.obsoleteFileAccesses(), 0);
      assert.equal(fixture.discoveries(), 1);
      assert.deepEqual(fixture.warnings, []);
    });
  }
});

test("sess launch safely declines unavailable APIs and incompatible protocol versions", async (t) => {
  for (const info of [undefined, { protocolVersion: 2, endpoint: "bad" }, { protocolVersion: 1, endpoint: "" }]) {
    const fixture = integrationFixture(t, info);
    const env = { SESS_ENDPOINT: "inherited", SESS_DISCOVERY_FILE: "inherited", R_CONSOLE_SESSION_BOOTSTRAP: "old" };
    await fixture.create().prepareStart(env);
    assert.deepEqual(env, {});
    assert.equal(fixture.warnings.length, 1);
  }
  for (const api of [{}, { session: { getConnectionInfo: async () => { throw Error("unavailable"); }, activate: async () => false } }]) {
    const fixture = integrationFixture(t);
    fixture.extension.isActive = true;
    fixture.extension.exports = api;
    const env = {};
    await fixture.create().prepareStart(env);
    assert.deepEqual(env, {});
    assert.equal(fixture.warnings.length, 1);
  }
});

test("focus before attach activates the stable identity and a detached UI reuses its live proxy", { timeout: 10000 }, async (t) => {
  const server = await upstream(t);
  const fixture = integrationFixture(t, { protocolVersion: 1, endpoint: server.endpoint, plotBackend: "standard" });
  const integration = fixture.create();
  const env = {};
  await integration.prepareStart(env);
  fixture.host.rProcess = { sessionId: randomUUID() };
  integration.afterRuntimeStarted();
  integration.setActive(true);
  integration.handleMainPrompt();
  assert.deepEqual(fixture.activations, []);
  const r = await connectR(t, env.SESS_ENDPOINT);
  send(r.socket, attach);
  await waitFor(() => fixture.activations.length === 1 && server.messages.length > 0);
  assert.deepEqual(fixture.activations, [attach.params.session_id]);
  assert.deepEqual(server.messages[0], attach);
  assert.deepEqual(integration.getCachedWorkspaceData(), workspace);
  integration.disposeUi();
  const restored = fixture.create();
  restored.attachRuntime();
  restored.setActive(true);
  restored.handleMainPrompt();
  await waitFor(() => fixture.activations.length >= 2);
  assert.ok(fixture.activations.every((id) => id === attach.params.session_id));
  assert.equal(fixture.discoveries(), 1);
  assert.deepEqual(fixture.commands, []);
});

test("reload reconnect waits for an empty main prompt and submits endpoint-based sess connect once", async (t) => {
  const fixture = integrationFixture(t, { protocolVersion: 1, endpoint: "upstream", plotBackend: "jgd", jgdSocket: 'plot\\"socket' });
  fixture.host.rProcess = { sessionId: randomUUID() };
  fixture.host.inputState.text = "unfinished";
  const integration = fixture.create();
  integration.setActive(true);
  integration.handleMainPrompt();
  await delay(30);
  assert.deepEqual(fixture.commands, []);
  fixture.host.inputState.text = "";
  integration.handleMainPrompt();
  integration.handleMainPrompt();
  await waitFor(() => fixture.commands.length === 1);
  const { code } = fixture.commands[0];
  assert.match(code, /Sys.setenv\(SESS_ENDPOINT=/);
  assert.match(code, /sess::connect\( endpoint=/);
  assert.match(code, /use_httpgd=FALSE, use_jgd=TRUE/);
  assert.ok(code.includes('Sys.setenv(JGD_SOCKET="plot\\\\\\"socket")'));
  assert.doesNotMatch(code, /pipe_path|notify_client/);
  assert.equal(fixture.host.mode, "executing");
});

test("activation rejected before upstream attach completes retries on workspace data", { timeout: 10000 }, async (t) => {
  const server = await upstream(t);
  const activations = [];
  const fixture = integrationFixture(t, { protocolVersion: 1, endpoint: server.endpoint, plotBackend: "standard" }, {
    activate: async (id) => { activations.push(id); return activations.length > 1; },
  });
  const integration = fixture.create();
  const env = {};
  await integration.prepareStart(env);
  integration.setActive(true);
  const r = await connectR(t, env.SESS_ENDPOINT);
  send(r.socket, attach);
  await waitFor(() => activations.length === 1 && server.sockets.length === 1);
  await delay(5);
  send(server.sockets[0], { jsonrpc: "2.0", method: "workspace", id: 42, params: {} });
  await waitFor(() => activations.length === 2);
  assert.deepEqual(activations, [attach.params.session_id, attach.params.session_id]);
  assert.deepEqual(fixture.commands, []);
  integration.setActive(false);
  send(r.socket, { jsonrpc: "2.0", method: "workspace_updated", params: {} });
  await delay(20);
  assert.equal(activations.length, 2);
});

test("runtime exit cancels pending connection discovery", async (t) => {
  let resolve;
  const fixture = integrationFixture(t, undefined, { getConnectionInfo: () => new Promise((done) => { resolve = done; }) });
  fixture.host.rProcess = { sessionId: randomUUID() };
  const integration = fixture.create();
  integration.setActive(true);
  await waitFor(() => resolve);
  integration.handleRuntimeExit();
  resolve({ protocolVersion: 1, endpoint: "upstream", plotBackend: "standard" });
  await delay(20);
  assert.equal(integration.proxy, undefined);
  assert.equal(integration.connection, undefined);
  assert.deepEqual(fixture.commands, []);
});

test("proxy replacement survives old socket close, forwards Unicode, and propagates upstream disconnect", { timeout: 10000 }, async (t) => {
  const server = await upstream(t);
  const { SessProxy } = loadSource("src/Runtime/VSCR/sess/sessProxy.ts");
  const proxy = new SessProxy({ upstreamPipePath: server.endpoint });
  t.after(() => proxy.dispose());
  const endpoint = await proxy.start();
  const first = await connectR(t, endpoint, false);
  send(first.socket, attach);
  await waitFor(() => proxy.getSessionId() && server.sockets.length === 1);
  const oldSocket = proxy.rSocket;
  const pending = proxy.requestMemberCompletions("x", "$");
  await waitFor(() => first.messages.some((message) => message.method === "completion"));
  const second = await connectR(t, endpoint);
  await waitFor(() => server.sockets.length === 2);
  assert.equal(await pending, undefined);
  assert.equal(proxy.getSessionId(), undefined);
  oldSocket.emit("close");
  assert.equal(proxy.isConnected(), true);
  const replacement = { ...attach, params: { ...attach.params, session_id: "replacement" } };
  send(second.socket, replacement);
  await waitFor(() => proxy.getSessionId() === "replacement" && proxy.getWorkspaceData());
  const unicode = { jsonrpc: "2.0", method: "help", params: { text: "café 😀" } };
  const bytes = Buffer.from(`${JSON.stringify(unicode)}\n`);
  const split = bytes.indexOf(Buffer.from("😀")) + 1;
  second.socket.write(bytes.subarray(0, split));
  await delay(10);
  second.socket.write(bytes.subarray(split));
  await waitFor(() => server.messages.some((message) => message.method === "help"));
  assert.deepEqual(server.messages.find((message) => message.method === "help"), unicode);
  server.sockets[1].write(bytes.subarray(0, split));
  await delay(10);
  server.sockets[1].write(bytes.subarray(split));
  await waitFor(() => second.messages.some((message) => message.method === "help"));
  assert.deepEqual(second.messages.find((message) => message.method === "help"), unicode);
  server.sockets[1].destroy();
  await waitFor(() => second.socket.destroyed);
  assert.equal(proxy.isConnected(), false);
  assert.equal(proxy.getSessionId(), undefined);
  assert.equal(proxy.getWorkspaceData(), undefined);
});
