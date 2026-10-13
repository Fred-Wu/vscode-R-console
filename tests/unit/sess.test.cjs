const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
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
  const terminalIntegrations = new Map();
  const connectionListeners = new Set();
  let discoveries = 0;
  const session = {
    getConnectionInfo: async () => { discoveries++; return info; },
    prepareAttachment: async ({ connection, autoActivate }) => {
      assert.equal(autoActivate, false, "console-owned terminals must avoid native PID association");
      const preparation = {
        scriptPath: `/prepared/${preparations.length + 1}.R`,
        command: `source("/prepared/${preparations.length + 1}.R")`,
        attachmentId: `prep-${preparations.length + 1}`,
        endpoint: connection.endpoint,
        disposed: false,
        dispose() { this.disposed = true; },
      };
      preparations.push(preparation);
      return preparation;
    },
    getSessionReference: (sessionId) => ({
      sessionId, connectionId: `conn-${sessionId}`,
      attachmentId: preparations.at(-1)?.attachmentId,
    }),
    onDidChangeSessionConnection: (listener) => {
      connectionListeners.add(listener);
      return { dispose: () => connectionListeners.delete(listener) };
    },
    registerTerminalIntegration: (terminal, integration) => {
      if (terminalIntegrations.has(terminal)) { throw new Error("duplicate registration"); }
      terminalIntegrations.set(terminal, integration);
      return { dispose: () => terminalIntegrations.delete(terminal) };
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
  const create = (runtimeHost = host) => {
    const integration = new SessVscodeRIntegration(runtimeHost);
    integrations.push(integration);
    return integration;
  };
  t.after(() => integrations.forEach((integration) => integration.handleRuntimeExit()));
  return { create, host, extension, activations, activationOptions, warnings, commands, preparations,
    terminalIntegrations,
    emitConnection: (change) => { for (const listener of connectionListeners) listener(change); },
    discoveries: () => discoveries };
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
      assert.equal(fixture.preparations[0].attachmentId, "prep-1");
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
  const r = await connectR(t, integration.connection.pipePath);
  send(r.socket, attach);
  await waitFor(() => fixture.activations.length === 1 && server.messages.length > 0);
  assert.deepEqual(fixture.activations, [attach.params.session_id]);
  assert.deepEqual(fixture.activationOptions, [{
    terminal: activeTerminal, connectionId: "conn-stable-r-session", select: true,
  }]);
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
    { terminal: activeTerminal, connectionId: "conn-stable-r-session", select: true },
    { terminal: reattachedTerminal, connectionId: "conn-stable-r-session", select: true },
  ]);
  assert.ok(fixture.discoveries() >= 1);
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
  assert.deepEqual(fixture.activationOptions, [{
    terminal, connectionId: "conn-protocol-2-session", select: true,
  }]);
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
  integration.setActive(true, { name: "R Console focused" });
  const r = await connectR(t, integration.connection.pipePath, false);
  send(r.socket, attach);
  await waitFor(() => activations.length === 1 && r.messages.some((message) => message.method === "workspace"));
  const workspaceRequest = r.messages.find((message) => message.method === "workspace");
  send(r.socket, { jsonrpc: "2.0", id: workspaceRequest.id, result: workspace });
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

test("cached proxy connection is not reused after transport loss before disconnect callback", { timeout: 10000 }, async (t) => {
  const server = await upstream(t);
  const fixture = integrationFixture(t, { protocolVersion: 2, endpoint: server.endpoint });
  const integration = fixture.create();
  await integration.prepareStart({});
  const firstProxy = integration.proxy;
  const firstEndpoint = integration.connection.pipePath;
  const r = await connectR(t, firstEndpoint);
  send(r.socket, attachV2);
  await waitFor(() => integration.proxyWasAttached);
  // Simulate a lost transport before the socket's close listener is delivered.
  firstProxy.isConnected = () => false;
  await integration.resolveCurrentConnection();
  assert.notEqual(integration.connection.pipePath, firstEndpoint);
  assert.notEqual(integration.proxy, firstProxy);
});

test("runtime exit releases unused prepared attachment", async (t) => {
  const fixture = integrationFixture(t, { endpoint: "upstream" });
  const integration = fixture.create();
  await integration.prepareStart({});
  assert.equal(fixture.preparations[0].disposed, false);
  integration.handleRuntimeExit();
  assert.equal(fixture.preparations[0].disposed, true);
});

test("background consoles bind without selecting and terminal registrations are disposed on UI detach", { timeout: 10000 }, async (t) => {
  const server = await upstream(t);
  const fixture = integrationFixture(t, { protocolVersion: 2, endpoint: server.endpoint });
  const integration = fixture.create();
  await integration.prepareStart({});
  fixture.host.rProcess = { sessionId: randomUUID() };
  integration.afterRuntimeStarted();
  const terminal = { name: "R Console background" };
  integration.setTerminal(terminal);
  await waitFor(() => fixture.terminalIntegrations.has(terminal));
  const r = await connectR(t, integration.connection.pipePath);
  send(r.socket, attachV2);
  await waitFor(() => fixture.activations.length === 1 && !integration.reconnectPending);
  assert.deepEqual(fixture.activationOptions[0], {
    terminal, connectionId: "conn-protocol-2-session", select: false,
  });
  integration.setActive(true, terminal);
  await waitFor(() => fixture.activations.length === 2);
  assert.equal(fixture.activationOptions[1].select, true);
  integration.disposeUi();
  assert.equal(fixture.terminalIntegrations.has(terminal), false);
});

test("manual attach delegates through the same sess proxy and explicitly binds before success", { timeout: 10000 }, async (t) => {
  const server = await upstream(t);
  const fixture = integrationFixture(t, { protocolVersion: 2, endpoint: server.endpoint });
  const integration = fixture.create();
  await integration.prepareStart({});
  fixture.host.rProcess = { sessionId: randomUUID() };
  integration.afterRuntimeStarted();
  const terminal = { name: "R Console recovery" };
  integration.setTerminal(terminal);
  await waitFor(() => fixture.terminalIntegrations.has(terminal));
  const hook = fixture.terminalIntegrations.get(terminal);
  integration.handleMainPrompt();
  const pending = hook.attach({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  await waitFor(() => fixture.commands.length === 1);
  assert.equal(fixture.commands[0].code, fixture.preparations[1].command);
  assert.equal(fixture.preparations[1].endpoint, integration.connection.pipePath);
  const r = await connectR(t, integration.connection.pipePath);
  send(r.socket, attachV2);
  assert.equal(await pending, true);
  assert.deepEqual(fixture.activationOptions.at(-1), {
    terminal, connectionId: "conn-protocol-2-session", select: false,
  });
});

test("replaced attachment references do not bind stale sessions", { timeout: 10000 }, async (t) => {
  const server = await upstream(t);
  let reference;
  const fixture = integrationFixture(t, { protocolVersion: 2, endpoint: server.endpoint }, {
    getSessionReference: () => reference,
  });
  const integration = fixture.create();
  await integration.prepareStart({});
  const terminal = { name: "R Console" };
  integration.setActive(true, terminal);
  await waitFor(() => fixture.terminalIntegrations.has(terminal));
  const r = await connectR(t, integration.connection.pipePath);
  send(r.socket, attachV2);
  await waitFor(() => integration.proxy?.getSessionId());
  const sessionId = attachV2.params.session_id;
  fixture.emitConnection({ kind: "connected", session: {
    sessionId, connectionId: "stale", attachmentId: "not-ours",
  } });
  await delay(20);
  assert.deepEqual(fixture.activations, []);
  reference = { sessionId, connectionId: "current", attachmentId: fixture.preparations[0].attachmentId };
  fixture.emitConnection({ kind: "connected", session: reference });
  await waitFor(() => fixture.activations.length === 1);
  assert.equal(fixture.activationOptions[0].connectionId, "current");
});

test("two concurrent consoles retain independent proxy bindings and switch only on focus", { timeout: 10000 }, async (t) => {
  const server = await upstream(t);
  const references = new Map();
  const fixture = integrationFixture(t, { protocolVersion: 2, endpoint: server.endpoint }, {
    getSessionReference: (sessionId) => references.get(sessionId),
  });
  const firstHost = fixture.host;
  const secondHost = { ...firstHost };
  const first = fixture.create(firstHost);
  const second = fixture.create(secondHost);
  await first.prepareStart({});
  await second.prepareStart({});
  firstHost.rProcess = { sessionId: randomUUID() };
  secondHost.rProcess = { sessionId: randomUUID() };
  first.afterRuntimeStarted();
  second.afterRuntimeStarted();
  const firstTerminal = { name: "R Console A" };
  const secondTerminal = { name: "R Console B" };
  first.setTerminal(firstTerminal);
  second.setTerminal(secondTerminal);
  await waitFor(() => fixture.terminalIntegrations.size === 2);
  const firstSocket = await connectR(t, first.connection.pipePath);
  const secondSocket = await connectR(t, second.connection.pipePath);
  const firstId = "console-a";
  const secondId = "console-b";
  references.set(firstId, { sessionId: firstId, connectionId: "a1", attachmentId: fixture.preparations[0].attachmentId });
  references.set(secondId, { sessionId: secondId, connectionId: "b1", attachmentId: fixture.preparations[1].attachmentId });
  send(firstSocket.socket, { ...attachV2, params: { ...attachV2.params, session_id: firstId } });
  send(secondSocket.socket, { ...attachV2, params: { ...attachV2.params, session_id: secondId } });
  await waitFor(() => fixture.activations.length === 2 && !first.reconnectPending && !second.reconnectPending);
  const bindings = new Map(fixture.activationOptions.slice(0, 2).map((options) => [options.terminal, options]));
  assert.deepEqual(bindings.get(firstTerminal), { terminal: firstTerminal, connectionId: "a1", select: false });
  assert.deepEqual(bindings.get(secondTerminal), { terminal: secondTerminal, connectionId: "b1", select: false });
  first.setActive(true, firstTerminal);
  await waitFor(() => fixture.activations.length === 3);
  assert.equal(fixture.activations[2], firstId);
  assert.equal(fixture.activationOptions[2].select, true);
  first.setActive(false);
  second.setActive(true, secondTerminal);
  await waitFor(() => fixture.activations.length === 4);
  assert.equal(fixture.activations[3], secondId);
  assert.equal(fixture.activationOptions[3].select, true);
});

test("cancelled manual recovery does not submit R code after preparation resolves", { timeout: 10000 }, async (t) => {
  let resolvePreparation;
  let preparationStarted = false;
  const fixture = integrationFixture(t, { protocolVersion: 2, endpoint: "upstream" }, {
    prepareAttachment: () => {
      preparationStarted = true;
      return new Promise((resolve) => { resolvePreparation = resolve; });
    },
  });
  fixture.host.rProcess = { sessionId: randomUUID() };
  const integration = fixture.create();
  const terminal = { name: "R Console recovery" };
  integration.setTerminal(terminal);
  integration.handleMainPrompt();
  await waitFor(() => fixture.terminalIntegrations.has(terminal));
  let cancelled = false;
  let onCancel;
  const token = {
    get isCancellationRequested() { return cancelled; },
    onCancellationRequested: (fn) => { onCancel = fn; return { dispose() {} }; },
  };
  const pending = fixture.terminalIntegrations.get(terminal).attach(token);
  await waitFor(() => preparationStarted);
  cancelled = true;
  onCancel();
  assert.equal(await pending, false);
  const preparation = {
    attachmentId: "cancelled-prep", command: 'source("cancelled")', scriptPath: "/cancelled",
    disposed: false, dispose() { this.disposed = true; },
  };
  resolvePreparation(preparation);
  await waitFor(() => preparation.disposed);
  assert.deepEqual(fixture.commands, []);
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
