const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { test } = require("node:test");
const rpc = require("vscode-languageserver-protocol/node");
const loadSource = require("../helpers/load-source.cjs");

test("production TCP transport delivers buffered LSP messages and initialize responses", { timeout: 5000 }, async (t) => {
  let peer;
  let peerConnection;
  let connection;
  let transport;
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode: {
      Uri: { parse: (value) => ({ toString: () => value }) },
      window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
    },
    // Keep the real JSON-RPC stream reader/writer; only the VS Code host and
    // R process launcher are mocked. Exercise createSocketTransport itself.
    "vscode-languageclient/node": { ...rpc, LanguageClient: class {} },
    child_process: {
      spawn(_file, _args, { env }) {
        const child = new EventEmitter();
        peer = net.createConnection({ host: env.VSCR_LSP_HOST, port: Number(env.VSCR_LSP_PORT) });
        const nonce = Buffer.from(env.VSCR_LSP_CLIENT_NONCE, "hex");
        let challenge = Buffer.alloc(0);
        const mac = (context, serverNonce) => createHmac("sha256", env.VSCR_LSP_AUTH_TOKEN)
          .update(context).update(nonce).update(serverNonce).digest();
        const onChallenge = (chunk) => {
          challenge = Buffer.concat([challenge, chunk]);
          if (challenge.length < 64) return;
          const serverNonce = challenge.subarray(0, 32);
          assert.deepEqual(challenge.subarray(32, 64), mac("rconsole-lsp-server-v2", serverNonce));
          peer.off("data", onChallenge);
          peerConnection = rpc.createMessageConnection(peer, peer);
          peerConnection.onRequest("initialize", () => ({ capabilities: { completionProvider: {} } }));
          peerConnection.listen();
          const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "early", params: { ready: true } }));
          peer.write(Buffer.concat([
            mac("rconsole-lsp-client-v2", serverNonce),
            Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body,
          ]));
        };
        peer.on("data", onChallenge);
        peer.once("connect", () => peer.write(nonce));
        return child;
      },
    },
  });
  const client = new ConsoleLspClient({ consoleId: "transport-regression", rPath: "mock-R", env: {} });
  t.after(() => {
    connection?.dispose();
    peerConnection?.dispose();
    transport?.writer.end();
    peer?.destroy();
    client.pendingSocketServer?.close();
    fs.rmSync(client.workingDirectory, { recursive: true, force: true });
  });
  transport = await client.createSocketTransport([], {});
  // Handoff may take more than a microtask. Early messages must stay buffered
  // until the consumer calls listen(), without a test-only socket.resume().
  await nextTurn();
  const early = [];
  connection = rpc.createMessageConnection(transport.reader, transport.writer);
  connection.onNotification("early", (params) => early.push(params));
  connection.listen();
  assert.deepEqual(await connection.sendRequest("initialize", {}), {
    capabilities: { completionProvider: {} },
  });
  assert.deepEqual(early, [{ ready: true }]);
});
