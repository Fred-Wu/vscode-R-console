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
const attachV2 = { jsonrpc: "2.0", method: "attach", params: {
  protocol_version: 2, interactive_token: "opaque-value",
  session_id: "protocol-2-session", host: "test-host",
  sess_version: "0.2.0", pid: 456, tempdir: "/tmp/R2", wd: "/workspace",
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
  const activationOptions = [];
  const warnings = [];
  const commands = [];
  const preparations = [];
  let discoveries = 0;
  let obsoleteFileAccesses = 0;
  const session = {
    getConnectionInfo: async () => { discoveries++; return info; },
    prepareAttachment: async ({ connection }) => {
      const preparation = {
        scriptPath: `/prepared/${preparations.length + 1}.R`,
        command: `source("/prepared/${preparations.length + 1}.R")`,
        endpoint: connection.endpoint,
        disposed: false,
        dispose() { this.disposed = true; },
      };
      preparations.push(preparation);
      return preparation;
    },
    activate: async (id, options) => {
      activations.push(id);
      activationOptions.push(options);
      return true;
    },
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
  return { create, host, extension, activations, activationOptions, warnings, commands, preparations,
    discoveries: () => discoveries, obsoleteFileAccesses: () => obsoleteFileAccesses };
}

test("sess startup uses opaque upstream attachment preparation per proxy", async (t) => {
  for (const plotBackend of ["auto", "standard", "httpgd", "jgd", "native"]) {
    await t.test(plotBackend, async (t) => {
      const fixture = integrationFixture(t, {
        protocolVersion: 2, endpoint: "upstream", plotBackend,
      });
      const integration = fixture.create();
      const env = { SESS_DISCOVERY_FILE: "inherited", SESS_ENDPOINT: "inherited", JGD_SOCKET: "old" };
      await integration.prepareStart(env);
      assert.equal(fixture.preparations.length, 1);
      assert.equal(fixture.preparations[0].endpoint, integration.connection.pipePath);
      assert.equal(env.R_CONSOLE_SESSION_BOOTSTRAP, fixture.preparations[0].scriptPath);
      assert.equal(env.SESS_ENDPOINT, undefined);
      assert.equal(env.SESS_DISCOVERY_FILE, undefined);
      assert.equal(env.JGD_SOCKET, undefined);
      assert.equal(fixture.discoveries(), 1);
      assert.deepEqual(fixture.warnings, []);
      fixture.host.rProcess = { sessionId: randomUUID() };
      integration.afterRuntimeStarted();
      assert.equal(fixture.preparations[0].disposed, false);
      integration.handleMainPrompt();
      assert.equal(fixture.preparations[0].disposed, true);
    });
  }
});

test("sess launch safely declines missing or unsupported upstream APIs", async (t) => {
  for (const info of [undefined, { protocolVersion: 2, endpoint: "" }]) {
    const fixture = integrationFixture(t, info);
    const env = { SESS_ENDPOINT: "inherited", SESS_DISCOVERY_FILE: "inherited", R_CONSOLE_SESSION_BOOTSTRAP: "old" };
    await fixture.create().prepareStart(env);
    assert.deepEqual(env, {});
    assert.equal(fixture.warnings.length, 1);
  }
  for (const api of [{}, { session: { getConnectionInfo: async () => ({ endpoint: "upstream" }), activate: async () => false } }]) {
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
  const firstTerminal = { name: "R Console first" };
  const activeTerminal = { name: "R Console active" };
  integration.setActive(true, firstTerminal);
  integration.setActive(false);
  integration.setActive(true, activeTerminal);
  integration.handleMainPrompt();
  assert.deepEqual(fixture.activations, []);
  const r = await connectR(t, env.SESS_ENDPOINT);
  send(r.socket, attach);
  await waitFor(() => fixture.activations.length === 1 && server.messages.length > 0);
  assert.deepEqual(fixture.activations, [attach.params.session_id]);
  assert.deepEqual(fixture.activationOptions, [{ terminal: activeTerminal }]);
  assert.deepEqual(server.messages[0], attach);
  assert.deepEqual(integration.getCachedWorkspaceData(), workspace);
  integration.disposeUi();
  const restored = fixture.create();
  restored.attachRuntime();
  const reattachedTerminal = { name: "R Console restored" };
  restored.setActive(true, reattachedTerminal);
  restored.handleMainPrompt();
  await waitFor(() => fixture.activations.length >= 2);
  assert.ok(fixture.activations.every((id) => id === attach.params.session_id));
  assert.deepEqual(fixture.activationOptions, [
    { terminal: activeTerminal },
    { terminal: reattachedTerminal },
  ]);
  assert.equal(fixture.discoveries(), 1);
  assert.deepEqual(fixture.commands, []);
});

test("restored runtime uses new preparation and waits for confirmed attach", async (t) => {
  const fixture = integrationFixture(t, {
    protocolVersion: 2, endpoint: "upstream", plotBackend: "jgd",
  });
  fixture.host.rProcess = { sessionId: randomUUID() };
  fixture.host.inputState.text = "unfinished";
  const integration = fixture.create();
  integration.setActive(true, { name: "R Console" });
  integration.handleMainPrompt();
  await delay(20);
  assert.deepEqual(fixture.commands, []);
  fixture.host.inputState.text = "";
  await waitFor(() => integration.connection?.pipePath);
  const waitingEndpoint = integration.connection.pipePath;
  integration.handleMainPrompt();
  integration.handleMainPrompt();
  await waitFor(() => fixture.commands.length === 1);
  assert.equal(integration.connection.pipePath, waitingEndpoint);
  assert.equal(fixture.commands[0].code, fixture.preparations[0].command);
  assert.equal(fixture.preparations[0].endpoint, integration.connection.pipePath);
  assert.equal(integration.reconnectPending, true);
  fixture.host.mode = "ready";
  integration.handleMainPrompt();
  assert.equal(fixture.preparations[0].disposed, true);
  assert.equal(integration.reconnectPending, true);
  assert.equal(integration.reconnectRetryBlocked, true);
  assert.equal(fixture.commands.length, 1);
  integration.setActive(false);
  integration.setActive(true);
  await waitFor(() => fixture.commands.length === 2);
  assert.equal(fixture.preparations.length, 2);
});

test("restored runtime rebinds its terminal after sess reconnect", { timeout: 10000 }, async (t) => {
  const server = await upstream(t);
  const fixture = integrationFixture(t, {
    protocolVersion: 2,
    endpoint: server.endpoint,
    plotBackend: "standard",
  });
  fixture.host.rProcess = { sessionId: randomUUID() };
  const integration = fixture.create();
  const terminal = { name: "R Console restored" };

  integration.setActive(true, terminal);
  integration.handleMainPrompt();
  await waitFor(() => fixture.commands.length === 1 && integration.connection?.pipePath);

  const r = await connectR(t, integration.connection.pipePath);
  send(r.socket, attachV2);
  await waitFor(() => fixture.activations.length === 1);

  assert.deepEqual(fixture.activations, [attachV2.params.session_id]);
  assert.deepEqual(fixture.activationOptions, [{ terminal }]);
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

test("disconnect invalidates cached connection and reconnects through a new proxy", { timeout: 10000 }, async (t) => {
  const server = await upstream(t);
  const fixture = integrationFixture(t, { protocolVersion: 2, endpoint: server.endpoint });
  const integration = fixture.create();
  const env = {};
  await integration.prepareStart(env);
  fixture.host.rProcess = { sessionId: randomUUID() };
  integration.afterRuntimeStarted();
  integration.setActive(true, { name: "R Console" });
  const r = await connectR(t, integration.connection.pipePath);
  send(r.socket, attachV2);
  await waitFor(() => fixture.activations.length === 1);
  integration.handleMainPrompt();
  const original = integration.connection.pipePath;
  r.socket.destroy();
  await waitFor(() => integration.reconnectPending);
  integration.handleMainPrompt();
  await waitFor(() => fixture.commands.length === 1);
  assert.notEqual(integration.connection.pipePath, original);
  assert.equal(fixture.preparations[1].endpoint, integration.connection.pipePath);
  assert.equal(integration.reconnectPending, true);
  const newR = await connectR(t, integration.connection.pipePath);
  send(newR.socket, attachV2);
  await waitFor(() => fixture.activations.length >= 2);
  assert.equal(integration.reconnectPending, false);
});

test("runtime exit releases unused prepared attachment", async (t) => {
  const fixture = integrationFixture(t, { endpoint: "upstream" });
  const integration = fixture.create();
  await integration.prepareStart({});
  assert.equal(fixture.preparations[0].disposed, false);
  integration.handleRuntimeExit();
  assert.equal(fixture.preparations[0].disposed, true);
});

test("proxy forwards protocol 2 attach metadata and keeps workspace and completion capabilities", { timeout: 10000 }, async (t) => {
  const server = await upstream(t);
  const { SessProxy } = loadSource("src/Runtime/VSCR/sess/sessProxy.ts");
  const proxy = new SessProxy({ upstreamPipePath: server.endpoint });
  t.after(() => proxy.dispose());

  const endpoint = await proxy.start();
  const r = await connectR(t, endpoint);
  send(r.socket, attachV2);
  await waitFor(() =>
    proxy.getSessionId() === attachV2.params.session_id &&
    server.messages.some((message) => message.method === "attach") &&
    proxy.getWorkspaceData()
  );

  assert.deepEqual(
    server.messages.find((message) => message.method === "attach"),
    attachV2
  );
  assert.deepEqual(proxy.getWorkspaceData(), workspace);

  const completion = proxy.requestMemberCompletions("x", "$");
  await waitFor(() => r.messages.some((message) => message.method === "completion"));
  const request = r.messages.find((message) => message.method === "completion");
  send(r.socket, {
    jsonrpc: "2.0",
    id: request.id,
    result: [{ name: "member", type: "numeric" }],
  });
  assert.deepEqual(await completion, [{ name: "member", type: "numeric" }]);
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
