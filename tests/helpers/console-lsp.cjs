const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const rpc = require("vscode-languageserver-protocol/node");
const loadSource = require("./load-source.cjs");

class Position {
  constructor(line, character) { Object.assign(this, { line, character }); }
}
class Range {
  constructor(start, end) { Object.assign(this, { start, end }); }
}
const uri = (value) => ({ toString: () => value });

// Replace only the VS Code host adapter. Use the production client lifecycle,
// R launcher, authentication, JSON-RPC streams, and console-language-server.R.
// Existing static-inference integration fixtures request it explicitly via
// this helper's default. The extension setting and production default are off.
function createConsoleLsp(t, { libraries = [], afterResponse, cwd, args = ["--vanilla"], env = process.env,
  staticAnalysis = true, requestRuntimeFunctionArguments, useStdio = false, getStartupStateStore } = {}) {
  const instances = [];
  const logs = [];
  const runtimeSignatures = new Map();
  let staticMode = staticAnalysis;
  class HostClientAdapter {
    constructor(_id, _name, serverOptions, options) {
      Object.assign(this, { serverOptions, options, running: false, requests: [], opened: [] });
      instances.push(this);
      const identifier = (doc) => ({ uri: doc.uri.toString() });
      this.code2ProtocolConverter = {
        asOpenTextDocumentParams: (doc) => ({ textDocument: {
          ...identifier(doc), languageId: "r", version: doc.version, text: doc.getText(),
        } }),
        asChangeTextDocumentParams: (doc) => ({
          textDocument: { ...identifier(doc), version: doc.version },
          contentChanges: [{ text: doc.getText() }],
        }),
        asCloseTextDocumentParams: (doc) => ({ textDocument: identifier(doc) }),
        asCompletionParams: (doc, position, context) => ({ textDocument: identifier(doc), position, context }),
      };
      this.protocol2CodeConverter = { asCompletionResult: async (result) => {
        for (const item of Array.isArray(result) ? result : result?.items ?? []) {
          if (item.textEdit) {
            item.range = new Range(item.textEdit.range.start, item.textEdit.range.end);
            item.insertText = item.insertTextFormat === 2 ? { value: item.textEdit.newText } : item.textEdit.newText;
          }
        }
        return result;
      } };
    }
    isRunning() { return this.running; }
    async start() {
      this.transport = await this.serverOptions();
      this.connection = rpc.createMessageConnection(this.transport.reader, this.transport.writer);
      this.connection.onError((error) => logs.push("JSON-RPC: " + String(error)));
      this.connection.listen();
      const rootUri = this.options.workspaceFolder.uri.toString();
      await this.connection.sendRequest("initialize", {
        processId: process.pid, rootUri,
        workspaceFolders: [{ uri: rootUri, name: "R Console" }],
        capabilities: {
          workspace: { workspaceFolders: true },
          textDocument: { completion: { completionItem: { snippetSupport: true } } },
        },
      });
      await this.connection.sendNotification("initialized", {});
      this.running = true;
    }
    async sendNotification(method, params) {
      if (!this.running) throw new Error("Client is not running");
      if (method === rpc.DidOpenTextDocumentNotification.type) this.opened.push(params.textDocument.uri);
      return this.connection.sendNotification(method, params);
    }
    async sendRequest(method, params, token) {
      if (!this.running) throw new Error("Client is not running");
      this.requests.push({ method, params });
      const result = await (token
        ? this.connection.sendRequest(method, params, token)
        : this.connection.sendRequest(method, params));
      await afterResponse?.(method, this);
      return result;
    }
    async stop() {
      if (!this.running) return;
      this.running = false;
      await this.connection.sendRequest("shutdown", null);
      await this.connection.sendNotification("exit", null);
    }
    async dispose() {
      try {
        await this.stop();
      } finally {
        this.connection?.dispose();
        this.transport?.writer.end();
        this.running = false;
      }
    }
    error() {}
  }
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode: {
      Position, Range,
      Uri: { parse: uri, file: (file) => uri(pathToFileURL(file).href) },
      CompletionTriggerKind: { Invoke: 1, TriggerCharacter: 2 },
      window: {
        createOutputChannel: () => ({ appendLine: (line) => logs.push(line), dispose() {} }),
        showWarningMessage: (message) => { logs.push(`Warning: ${message}`); },
      },
      workspace: { getConfiguration: () => ({ get: (key) => {
        if (key === "lsp.args") return args;
        if (key === "lsp.use_stdio") return useStdio;
        if (key === "libPaths" || key === "useRenvLibPath") {
          throw new Error("R Console must not read vscode-R library settings");
        }
        return undefined;
      } }) },
    },
    "vscode-languageclient/node": {
      ...rpc, LanguageClient: HostClientAdapter,
      RevealOutputChannelOn: { Never: 4 },
      CloseAction: { DoNotRestart: 1 }, ErrorAction: { Continue: 1 },
    },
  });
  const client = new ConsoleLspClient({
    consoleId: "real-lifecycle-test", extensionPath: path.resolve(__dirname, "../.."),
    rPath: process.env.R_TEST_EXECUTABLE || "R", env: { ...env }, cwd,
    getCachedWorkspaceData: () => ({ globalenv: Object.fromEntries(
      [...runtimeSignatures].map(([name, str]) => [name, { type: "closure", str }])) }),
    getStaticAnalysisEnabled: () => staticMode,
    requestRuntimeFunctionArguments,
    getStartupStateStore,
  });
  // Model the full .libPaths() result from an interactive session, not just
  // its added libraries. R's ordinary libraries must remain available to the
  // language server, including the one containing languageserver itself.
  if (libraries.length) {
    const defaults = execFileSync("Rscript",
      ["--vanilla", "-e", 'cat(.libPaths(), sep = "\\n")'],
      { cwd: cwd ?? process.cwd(), env, encoding: "utf8", timeout: 15000 })
      .split(/\r?\n/).filter(Boolean);
    client.updateRuntimeLibraryPaths([...new Set([...libraries, ...defaults])]);
  }
  t.after(async () => {
    try { await client.dispose(); }
    finally { if (!t.passed) t.diagnostic(logs.join("\n")); }
  });
  const complete = async (text = "stats::l") => {
    const result = await client.provideCompletionItems({ getText: () => text }, new Position(0, text.length));
    return Array.isArray(result) ? result : result?.items;
  };
  // Test-only session fixture: no synthetic workspace functions are sent to LSP.
  client.setRuntimeSignatures = signatures => {
    runtimeSignatures.clear();
    for (const [name, signature] of Object.entries(signatures)) runtimeSignatures.set(name, signature);
  };
  client.setStaticAnalysis = enabled => { staticMode = enabled; };
  return { client, instances, logs, complete };
}

module.exports = { createConsoleLsp };
