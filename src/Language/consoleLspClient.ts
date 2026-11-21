import { ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import { randomBytes } from "crypto";
import { authenticateLspSocket } from "./lspSocketAuth";
import { BACKEND_AUTH_TIMEOUT_MS } from "../Runtime/backendAuthentication";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { URL } from "url";
import * as vscode from "vscode";
import {
  CloseAction,
  DataCallback,
  CompletionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ErrorAction,
  LanguageClient,
  LanguageClientOptions,
  MessageTransports,
  RevealOutputChannelOn,
  StreamInfo,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageclient/node";
import type { CompletionPickItem, CompletionProvider, CompletionResult } from "./completion";
import { VirtualRDocument } from "./virtualRDocument";
import { getEnclosingCall } from "./completion/contextParser";
import { createCompletionParams } from "./completion/protocol";
import { PackageInventory, type PackageInventoryChange } from "./packageInventory";
import type { WorkspaceData } from "../Runtime/VSCR/types";

const CONSOLE_LSP_HOST = "127.0.0.1";
const lifecycleOutputChannel = vscode.window.createOutputChannel(
  "R Console Language Server"
);

function formatLogTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function disposeConsoleLspOutputChannel(): void {
  lifecycleOutputChannel.dispose();
}

type ConsoleLspClientOptions = {
  consoleId: string;
  extensionPath: string;
  rPath: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onPackagesChanged?: () => void;
  getCachedWorkspaceData?: () => WorkspaceData | undefined;
  getStaticAnalysisEnabled?: () => boolean;
};

type ConsoleLspSessionState = {
  attachedPackages: string[];
};

type SessionStateSyncResult = {
  synced: boolean;
  stateKey: string;
};

class SilentOutputChannel implements vscode.OutputChannel {
  constructor(public readonly name: string) {}

  append(_value: string): void {}

  appendLine(_value: string): void {}

  replace(_value: string): void {}

  clear(): void {}

  show(_columnOrPreserveFocus?: vscode.ViewColumn | boolean, _preserveFocus?: boolean): void {}

  hide(): void {}

  dispose(): void {}
}

class ConsoleLanguageClient extends LanguageClient {
  error(message: string, data?: unknown, _showNotification: boolean | "force" = true): void {
    super.error(message, data, false);
  }
}

export class ConsoleLspClient implements CompletionProvider {
  private readonly outputChannel: vscode.OutputChannel;
  private readonly workingDirectory: string;
  private readonly inputDocument: VirtualRDocument;

  private client: ConsoleLanguageClient | undefined;
  private startPromise: Promise<void> | undefined;
  private disposePromise: Promise<void> | undefined;
  private terminationPromise: Promise<boolean> | undefined;
  private disposed = false;
  private spawnedServer: ChildProcess | undefined;
  private pendingSocketServer: net.Server | undefined;
  private syncedDocuments = new Map<string, { document: vscode.TextDocument; version: number }>();
  private documentSyncPromise: Promise<void> = Promise.resolve();
  private sessionState: ConsoleLspSessionState | undefined;
  private syncedSessionStateKey: string | undefined;
  private sessionStateSyncPromise: Promise<SessionStateSyncResult> | undefined;
  private readonly packageInventory: PackageInventory;
  private packageRefreshPromise: Promise<void> | undefined;
  private packageRevision = 0;
  private runtimeRevision = 0;
  private restartPromise: Promise<void> | undefined;
  private readonly plannedRestarts = new WeakMap<ChildProcess, string>();

  constructor(private readonly options: ConsoleLspClientOptions) {
    this.inputDocument = new VirtualRDocument(options.consoleId);
    this.outputChannel = new SilentOutputChannel("R Console");
    // Keep the LSP workspace isolated from project indexing.
    this.workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-lsp-"));
    this.packageInventory = new PackageInventory(
      change => this.refreshPackages(change),
      message => lifecycleOutputChannel.appendLine(`[${formatLogTimestamp()}] ${message}`),
    );
  }

  async start(): Promise<void> {
    if (this.restartPromise) {
      await this.restartPromise;
      return;
    }
    await this.startClient();
  }

  private async startClient(): Promise<void> {
    if (this.disposed) {
      throw new Error("Cannot start a disposed console language server.");
    }
    if (this.client?.isRunning()) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    this.startPromise = (async () => {
      if (this.client || this.spawnedServer) {
        const staleClient = this.client;
        this.client = undefined;
        if (staleClient) {
          try {
            await staleClient.dispose();
          } catch {
          }
        }
        if (!(await this.terminateSpawnedServer())) {
          throw new Error("Cannot stop the previous console language server process.");
        }
        this.syncedDocuments.clear();
        this.syncedSessionStateKey = undefined;
        this.sessionStateSyncPromise = undefined;
      }
      if (this.disposed) {
        throw new Error("Cannot start a disposed console language server.");
      }
      await this.startInternal();
    })()
      .catch(async (error) => {
        if (!this.disposed) {
          this.logServerError(error);
        }
        const failedClient = this.client;
        this.client = undefined;
        this.closePendingSocketServer();
        await this.terminateSpawnedServer();
        if (failedClient) {
          try {
            await failedClient.dispose();
          } catch {
          }
        }
        throw error;
      })
      .finally(() => {
        this.startPromise = undefined;
      });
    await this.startPromise;
  }

  private async stop(): Promise<boolean> {
    const startPromise = this.startPromise;
    if (startPromise && !this.client?.isRunning()) {
      // Cancel startup before waiting for it, so a child that has not connected
      // cannot block disposal.
      this.closePendingSocketServer();
      if (!(await this.terminateSpawnedServer())) {
        return false;
      }
    }
    if (startPromise) {
      try {
        await startPromise;
      } catch {
      }
    }

    const client = this.client;
    this.client = undefined;
    if (!client) {
      this.closePendingSocketServer();
      if (!(await this.terminateSpawnedServer())) {
        return false;
      }
      this.syncedDocuments.clear();
      this.syncedSessionStateKey = undefined;
      this.sessionStateSyncPromise = undefined;
      return true;
    }

    for (const { document } of this.syncedDocuments.values()) {
      try {
        await client.sendNotification(
          DidCloseTextDocumentNotification.type,
          client.code2ProtocolConverter.asCloseTextDocumentParams(document)
        );
      } catch {
      }
    }
    this.syncedDocuments.clear();
    try {
      await client.stop();
    } catch {
    }
    try {
      await client.dispose();
    } catch {
    }
    this.closePendingSocketServer();
    if (!(await this.terminateSpawnedServer())) {
      return false;
    }
    this.syncedSessionStateKey = undefined;
    this.sessionStateSyncPromise = undefined;
    return true;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.disposed = true;
    this.packageInventory.dispose();
    this.disposePromise = (async () => {
      while (!(await this.stop())) {
        const child = this.spawnedServer;
        if (child && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            child.once("exit", resolve);
          });
        }
      }
      this.outputChannel.dispose();
      try {
        fs.rmSync(this.workingDirectory, { recursive: true, force: true });
      } catch {
      }
    })();
    return this.disposePromise;
  }

  getCallContext(doc: vscode.TextDocument, position: vscode.Position) {
    const projection = this.inputDocument.project(doc.getText(),
      this.options.getStaticAnalysisEnabled?.() === true, position);
    return getEnclosingCall(projection.document.getText(),
      projection.document.offsetAt(projection.toServerPosition(position)));
  }

  async provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string,
    contextPosition: vscode.Position = position
  ): Promise<CompletionResult | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.packageRefreshPromise;
      const revision = this.packageRevision;
      const client = await this.ensureClient();
      if (!client) {
        return undefined;
      }
      try {
        const staticAnalysis = this.options.getStaticAnalysisEnabled?.() === true;
        const projection = this.inputDocument.project(doc.getText(), staticAnalysis, contextPosition);
        await this.syncDocument(client, projection.document);
        await this.applySessionState(client);
        if (this.client !== client) {
          continue;
        }
        const context: vscode.CompletionContext = triggerCharacter
          ? {
              triggerKind: vscode.CompletionTriggerKind.TriggerCharacter,
              triggerCharacter,
            }
          : {
              triggerKind: vscode.CompletionTriggerKind.Invoke,
              triggerCharacter: undefined,
            };
        const serverPosition = projection.toServerPosition(position);
        const params = createCompletionParams(client, projection, serverPosition, contextPosition, context,
          staticAnalysis);
        const documentVersion = projection.document.version;
        const sessionState = this.sessionState;
        const runtimeRevision = this.runtimeRevision;
        // Use the already-published workspace snapshot; completion must not
        // query sess to resolve or inspect runtime objects.
        const globals = this.options.getCachedWorkspaceData?.()?.globalenv;
        if (params.rConsoleCall && globals && !params.rConsoleCall.includes("$") &&
            !params.rConsoleCall.includes("@") && !params.rConsoleCall.includes("::")) {
          const item = globals[params.rConsoleCall];
          if (item && ["closure", "builtin", "special"].includes(item.type) &&
              typeof item.str === "string" && /^\s*function\s*\(/.test(item.str)) {
            (params as typeof params & { rConsoleRuntimeSignature?: string }).rConsoleRuntimeSignature = item.str;
          }
        }
        const result = await client.sendRequest(CompletionRequest.type, params);
        if (this.client !== client || revision !== this.packageRevision) continue;
        const isCurrent = () => !this.disposed && this.client === client &&
          revision === this.packageRevision && runtimeRevision === this.runtimeRevision &&
          this.sessionState === sessionState &&
          this.syncedDocuments.get(projection.document.uri.toString())?.version === documentVersion;
        if (!isCurrent()) return undefined;
        const completions: CompletionResult | undefined = await client.protocol2CodeConverter.asCompletionResult(result);
        if (!isCurrent()) return undefined;
        // VS Code's converter preserves standard LSP fields only. Carry this
        // source decision separately so an empty signature stays authoritative.
        if (completions && (result as { rConsoleRuntimeOnly?: boolean } | null)?.rConsoleRuntimeOnly === true) {
          completions.rConsoleRuntimeOnly = true;
        }
        if (completions && (result as { rConsoleWorkspaceFunction?: boolean } | null)?.rConsoleWorkspaceFunction === true) {
          completions.rConsoleWorkspaceFunction = true;
        }
        if (completions && (result as { rConsoleLocalFunction?: boolean } | null)?.rConsoleLocalFunction === true) {
          completions.rConsoleLocalFunction = true;
        }
        if (completions && (result as { rConsoleMemberResolved?: boolean } | null)?.rConsoleMemberResolved === true) {
          completions.rConsoleMemberResolved = true;
        }
        if (completions && (result as { rConsoleNativeArguments?: boolean } | null)?.rConsoleNativeArguments === true) {
          completions.rConsoleNativeArguments = true;
        }
        if (completions && (result as { rConsoleArgumentsExhausted?: boolean } | null)?.rConsoleArgumentsExhausted === true) {
          completions.rConsoleArgumentsExhausted = true;
        }
        const mapRange = (range: vscode.Range): vscode.Range => new vscode.Range(
          projection.toConsolePosition(range.start), projection.toConsolePosition(range.end)
        );
        for (const item of Array.isArray(completions) ? completions : completions?.items ?? []) {
          if (item.range) {
            item.range = item.range instanceof vscode.Range
              ? mapRange(item.range)
              : { inserting: mapRange(item.range.inserting), replacing: mapRange(item.range.replacing) };
          }
        }
        if (this.client !== client || revision !== this.packageRevision) continue;
        if (!isCurrent()) return undefined;
        return completions;
      } catch {
        // A session update can replace the server at any await above. Reopen
        // the document and retry on that server, but do not retry input errors.
        if (this.client !== client || !client.isRunning()) {
          continue;
        }
        return undefined;
      }
    }
    return undefined;
  }

  async prepareDocument(doc: vscode.TextDocument): Promise<void> {
    const client = await this.ensureClient();
    if (!client) {
      return;
    }
    await this.applySessionState(client);
    const currentClient = this.client;
    if (currentClient?.isRunning()) {
      await this.syncDocument(currentClient, this.inputDocument.project(doc.getText(),
        this.options.getStaticAnalysisEnabled?.() === true).document);
    }
  }

  invalidateRuntimeCompletion(): void {
    this.runtimeRevision++;
  }

  updateInput(input: string): void {
    this.inputDocument.update(input);
  }

  recordCompletion(input: string, start: number, selection: CompletionPickItem): void {
    this.inputDocument.update(input);
    this.inputDocument.selectFunction(start, selection.insertText, selection.packageName);
  }

  async syncSessionState(state: ConsoleLspSessionState): Promise<void> {
    this.sessionState = state;
    const client = await this.ensureClient();
    if (!client) {
      return;
    }

    await this.applySessionState(client);
  }

  private async applySessionState(client: ConsoleLanguageClient): Promise<void> {
    if (!this.sessionState) {
      return;
    }
    if (this.client !== client) {
      if (this.client?.isRunning()) {
        await this.applySessionState(this.client);
      }
      return;
    }
    const state = this.sessionState;
    const stateKey = this.getSessionStateKey(state);
    if (this.syncedSessionStateKey === stateKey) {
      return;
    }

    let syncPromise = this.sessionStateSyncPromise;
    if (!syncPromise) {
      syncPromise = client.sendRequest<{ libraryPaths: string[] }>("rConsole/syncSessionState", state)
        .then((reply) => {
          if (this.client === client && typeof reply === "object" && Array.isArray(reply?.libraryPaths)) {
            this.packageInventory.setLibraryPaths(reply.libraryPaths);
          }
          const synced = this.client === client;
          if (synced) {
            this.syncedSessionStateKey = stateKey;
          }
          return { synced, stateKey };
        })
        .catch(() => ({ synced: false, stateKey }))
        .finally(() => {
          if (this.sessionStateSyncPromise === syncPromise) {
            this.sessionStateSyncPromise = undefined;
          }
        });
      this.sessionStateSyncPromise = syncPromise;
    }

    const result = await syncPromise;
    if (!this.sessionState || this.client !== client) {
      return;
    }
    const currentStateKey = this.getSessionStateKey(this.sessionState);
    if (
      this.syncedSessionStateKey !== currentStateKey &&
      (result.synced || result.stateKey !== currentStateKey)
    ) {
      await this.applySessionState(client);
    }
  }

  private getSessionStateKey(state: ConsoleLspSessionState): string {
    return JSON.stringify(state.attachedPackages);
  }

  private async restartClient(client: ConsoleLanguageClient, reason: string): Promise<void> {
    if (this.restartPromise) {
      await this.restartPromise;
      return;
    }
    if (this.client !== client) {
      return;
    }

    if (this.spawnedServer) this.plannedRestarts.set(this.spawnedServer, reason);
    // Completion and startup callers join the same background replacement.
    const refresh = (async () => {
      if (!(await this.stop())) {
        throw new Error("Cannot restart the console language server.");
      }
      if (!this.disposed) {
        await this.startClient();
      }
    })();
    this.restartPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.restartPromise === refresh) {
        this.restartPromise = undefined;
      }
    }
  }

  private async refreshPackages(change: PackageInventoryChange): Promise<void> {
    const refresh = (async () => {
      if (!change.isCurrent()) return;
      const previousClient = this.client;
      let client = await this.ensureClient();
      if (!client?.isRunning() || this.disposed) throw new Error("Language server is not running");
      if (!change.isCurrent()) return;
      await this.applySessionState(client);
      if (this.client !== client) throw new Error("Language server changed during package refresh");
      if (!change.isCurrent()) return;
      if (change.changed.length) {
        this.packageRevision++;
        this.options.onPackagesChanged?.();
      }
      const params = {
        libraryPaths: change.libraries.map(library => library.path),
        installations: Object.fromEntries([...change.packages].map(([name, item]) => [name, item.path])),
        // A recovered server already loaded the current installations.
        changed: client === previousClient ? change.changed : [],
      };
      const result = await client.sendRequest<{ restart: string[] }>("rConsole/refreshPackages", params);
      if (this.disposed || this.client !== client) throw new Error("Language server changed during package refresh");
      if (!change.isCurrent()) return;
      if (result.restart.length) {
        if (!change.changed.length) {
          this.packageRevision++;
          this.options.onPackagesChanged?.();
        }
        const reason = result.restart.map(name =>
          `${name} (${change.packages.has(name) ? "installation changed" : "removed"})`).join(", ");
        lifecycleOutputChannel.appendLine(`[${formatLogTimestamp()}] [Completion] Restarting language server: ${reason}; clearing packages loaded in the server.`);
        await this.restartClient(client, reason);
        client = this.client;
        if (!client?.isRunning() || this.disposed) return;
        await this.applySessionState(client);
        if (!change.isCurrent()) return;
        await client.sendRequest("rConsole/refreshPackages", { ...params, changed: [] });
      } else if (change.changed.length) {
        lifecycleOutputChannel.appendLine(`[${formatLogTimestamp()}] [Completion] Refreshed package metadata; language server retained`);
      }
      if (result.restart.length) {
        try {
          const projection = this.inputDocument.project(this.inputDocument.getText(),
            this.options.getStaticAnalysisEnabled?.() === true);
          await this.syncDocument(client, projection.document);
          const position = projection.document.positionAt(projection.document.getText().length);
          await client.sendRequest(CompletionRequest.type, createCompletionParams(client, projection,
            position, position, { triggerKind: vscode.CompletionTriggerKind.Invoke, triggerCharacter: undefined }));
        } catch {
          // Incomplete console input must not turn a successful refresh into a restart loop.
        }
      }
    })();
    this.packageRefreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.packageRefreshPromise === refresh) this.packageRefreshPromise = undefined;
    }
  }

  private async ensureClient(): Promise<ConsoleLanguageClient | undefined> {
    if (this.disposed) {
      return undefined;
    }
    if (this.restartPromise) {
      try {
        await this.restartPromise;
      } catch {
        return undefined;
      }
    }
    if (this.disposed) {
      return undefined;
    }
    if (this.client?.isRunning()) {
      return this.client;
    }
    try {
      await this.start();
    } catch {
      return undefined;
    }
    if (this.disposed) {
      return undefined;
    }
    return this.client?.isRunning() ? this.client : undefined;
  }

  private async startInternal(): Promise<void> {
    const config = vscode.workspace.getConfiguration("r");
    const scriptPath = this.resolveLanguageServerScriptPath();
    const args = this.buildServerArgs(config, scriptPath);
    const env = this.buildServerEnv(config);
    const useStdio = config.get<boolean>("lsp.use_stdio") === true && process.platform !== "win32";

    const clientOptions: LanguageClientOptions = {
      workspaceFolder: {
        uri: vscode.Uri.file(this.workingDirectory),
        name: "R Console",
        index: 0,
      },
      documentSelector: [
        // We synchronize console completion documents manually to guarantee
        // notification ordering before completion requests.
      ],
      uriConverters: {
        code2Protocol: (uri: vscode.Uri) => new URL(uri.toString(true)).toString(),
        protocol2Code: (uri: string) => vscode.Uri.parse(uri),
      },
      outputChannel: this.outputChannel,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      errorHandler: {
        error: (error) => {
          if (this.client) {
            this.logServerError(error);
          }
          return { action: ErrorAction.Continue, handled: true };
        },
        closed: () => {
          if (this.client) {
            this.logServerError("connection closed unexpectedly");
          }
          return { action: CloseAction.DoNotRestart, handled: true };
        },
      },
    };

    const client = new ConsoleLanguageClient(
      `r-console-${this.options.consoleId}`,
      "R Console",
      useStdio
        ? () => this.createStdioTransport(args, env)
        : () => this.createSocketTransport(args, env),
      clientOptions
    );
    this.client = client;
    this.syncedSessionStateKey = undefined;
    this.sessionStateSyncPromise = undefined;
    await client.start();
    await this.disableConsoleDiagnostics(client);
    const libraries = await client.sendRequest<string[]>("rConsole/libraryPaths", {});
    if (this.client === client && !this.disposed && !this.syncedSessionStateKey) {
      this.packageInventory.setLibraryPaths(libraries);
    }
  }

  private createStdioTransport(args: string[], env: NodeJS.ProcessEnv): Promise<StreamInfo> {
    return new Promise<StreamInfo>((resolve, reject) => {
      let settled = false;
      let child: ChildProcess;
      try {
        child = spawn(this.options.rPath, args, {
          cwd: this.options.cwd ?? this.workingDirectory,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      this.spawnedServer = child;
      this.forwardServerStderr(child);
      child.once("spawn", () => {
        this.logServerStarted();
        if (settled) {
          return;
        }
        if (!child.stdout || !child.stdin) {
          settled = true;
          reject(new Error("Console language server started without stdio streams."));
          return;
        }
        settled = true;
        resolve({ reader: child.stdout, writer: child.stdin });
      });
      child.once("error", (error) => {
        if (settled) {
          this.logServerError(error);
        }
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once("exit", (code, signal) => {
        this.logServerStopped(code, signal, child);
        if (code === 10) {
          void vscode.window.showWarningMessage(
            "R package {languageserver} is required for console autocompletion."
          );
        }
        if (this.spawnedServer === child) {
          this.spawnedServer = undefined;
        }
        if (!settled) {
          settled = true;
          reject(new Error(
            `Console language server exited before stdio startup completed (${
              signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
            }).`
          ));
        }
      });
    });
  }

  private createSocketTransport(args: string[], baseEnv: NodeJS.ProcessEnv): Promise<MessageTransports> {
    return new Promise<MessageTransports>((resolve, reject) => {
      let settled = false;
      const authToken = randomBytes(32).toString("hex");
      const clientNonce = randomBytes(32).toString("hex");
      let pendingAuth = 0;
      const server = net.createServer((socket) => {
        if (settled || pendingAuth >= 8) {
          socket.destroy();
          return;
        }
        pendingAuth += 1;
        void authenticateLspSocket(socket, authToken, BACKEND_AUTH_TIMEOUT_MS, clientNonce).then((accepted) => {
          pendingAuth -= 1;
          if (!accepted || settled) {
            socket.destroy();
            return;
          }
          settled = true;
          if (this.pendingSocketServer === server) this.pendingSocketServer = undefined;
          const child = this.spawnedServer;
          socket.on("error", (error) => this.logServerError(error, child));
          server.close();
          // Authentication leaves the socket paused, possibly with early LSP
          // bytes buffered. Resume only after JSON-RPC installs its reader.
          const reader = new class extends StreamMessageReader {
            override listen(callback: DataCallback): vscode.Disposable {
              const subscription = super.listen(callback);
              socket.resume();
              return subscription;
            }
          }(socket);
          resolve({ reader, writer: new StreamMessageWriter(socket) });
        });
      });
      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.pendingSocketServer === server) {
          this.pendingSocketServer = undefined;
        }
        if (server.listening) {
          server.close();
        }
        reject(error);
      };

      this.pendingSocketServer = server;
      server.once("error", (error) => {
        rejectOnce(error);
      });
      server.once("close", () => {
        rejectOnce(new Error("Console language server socket closed before connection."));
      });

      server.listen(0, CONSOLE_LSP_HOST, () => {
        if (settled || this.pendingSocketServer !== server) {
          rejectOnce(new Error("Console language server startup was cancelled."));
          return;
        }
        const address = server.address();
        if (!address || typeof address === "string") {
          rejectOnce(new Error("Failed to allocate loopback port for console language server."));
          return;
        }
        const env: NodeJS.ProcessEnv = {
          ...baseEnv,
          VSCR_LSP_HOST: CONSOLE_LSP_HOST,
          VSCR_LSP_PORT: String(address.port),
          VSCR_LSP_AUTH_TOKEN: authToken,
          VSCR_LSP_AUTH_TIMEOUT_SECONDS: String(BACKEND_AUTH_TIMEOUT_MS / 1_000),
          VSCR_LSP_CLIENT_NONCE: clientNonce,
        };
        let child: ChildProcess;
        try {
          child = spawn(this.options.rPath, args, {
            cwd: this.options.cwd ?? this.workingDirectory,
            env,
            stdio: ["ignore", "ignore", "pipe"],
            shell: false,
          });
        } catch (error) {
          rejectOnce(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.spawnedServer = child;
        this.forwardServerStderr(child);
        child.once("spawn", () => {
          this.logServerStarted();
        });
        child.once("error", (error) => {
          if (settled) {
            this.logServerError(error);
          }
          rejectOnce(error);
        });
        child.once("exit", (code, signal) => {
          this.logServerStopped(code, signal, child);
          if (code === 10) {
            void vscode.window.showWarningMessage(
              "R package {languageserver} is required for console autocompletion."
            );
          }
          if (this.spawnedServer === child) {
            this.spawnedServer = undefined;
          }
          rejectOnce(new Error(
            `Console language server exited before connecting (${
              signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
            }).`
          ));
        });
      });
    });
  }

  private buildServerArgs(config: vscode.WorkspaceConfiguration, scriptPath: string): string[] {
    const userArgs = config.get<string[]>("lsp.args") ?? [];
    return [
      ...userArgs,
      "--silent",
      "--no-echo",
      "--no-save",
      "--no-restore",
      "-e",
      "base::source(base::commandArgs(TRUE))",
      "--args",
      scriptPath,
    ];
  }

  private syncDocument(client: LanguageClient, document: vscode.TextDocument): Promise<void> {
    const syncPromise = this.documentSyncPromise.then(async () => {
      const key = document.uri.toString();
      const existing = this.syncedDocuments.get(key);
      if (!existing) {
        const version = document.version;
        const params = client.code2ProtocolConverter.asOpenTextDocumentParams(document);
        await client.sendNotification(
          DidOpenTextDocumentNotification.type,
          params
        );
        if (this.client !== client || !client.isRunning()) {
          throw new Error("Console language server changed during document synchronization.");
        }
        this.syncedDocuments.set(key, { document, version });
        return;
      }

      if (existing.version !== document.version) {
        const version = document.version;
        const params = client.code2ProtocolConverter.asChangeTextDocumentParams(document);
        await client.sendNotification(
          DidChangeTextDocumentNotification.type,
          params
        );
        if (this.client !== client || !client.isRunning()) {
          throw new Error("Console language server changed during document synchronization.");
        }
        this.syncedDocuments.set(key, { document, version });
        return;
      }

      if (existing.document !== document) {
        this.syncedDocuments.set(key, { document, version: document.version });
      }
    });
    this.documentSyncPromise = syncPromise.catch(() => {});
    return syncPromise;
  }

  private buildServerEnv(config: vscode.WorkspaceConfiguration): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.options.env };
    const useRenvLibPath = config.get<boolean>("useRenvLibPath") === true;
    const lang = config.get<string>("lsp.lang") ?? "";
    const libPaths = config.get<string[]>("libPaths") ?? [];

    // Keep languageserver's verbose tracing out of the lifecycle channel.
    env.VSCR_LSP_DEBUG = "FALSE";
    env.VSCR_USE_RENV_LIB_PATH = useRenvLibPath ? "TRUE" : "FALSE";
    env.VSCR_LIB_PATHS = libPaths.join("\n");
    if (lang) {
      env.LANG = lang;
    } else if (!env.LANG) {
      env.LANG = "en_US.UTF-8";
    }
    return env;
  }

  private resolveLanguageServerScriptPath(): string {
    const scriptPath = path.join(this.options.extensionPath, "resources", "r", "console-language-server.R");
    if (fs.existsSync(scriptPath)) {
      return scriptPath;
    }
    throw new Error(
      `Cannot locate console language server script at ${scriptPath}`
    );
  }

  private closePendingSocketServer(): void {
    const server = this.pendingSocketServer;
    this.pendingSocketServer = undefined;
    if (!server) {
      return;
    }
    try {
      server.close();
    } catch {
    }
  }

  private logServerStarted(): void {
    const timestamp = formatLogTimestamp();
    lifecycleOutputChannel.appendLine(
      `[${timestamp}] R Console language server started`
    );
    lifecycleOutputChannel.appendLine(
      `[${timestamp}] R executable: "${this.options.rPath}"`
    );
  }

  private logServerError(error: unknown, child?: ChildProcess): void {
    const reason = child && this.plannedRestarts.get(child);
    if (reason && (error as NodeJS.ErrnoException | null)?.code === "ECONNRESET") {
      lifecycleOutputChannel.appendLine(
        `[${formatLogTimestamp()}] R Console language server connection closed during planned restart: ${reason} (ECONNRESET)`
      );
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    lifecycleOutputChannel.appendLine(
      `[Error - ${formatLogTimestamp()}] ${message}`
    );
  }

  private forwardServerStderr(child: ChildProcess): void {
    if (!child.stderr) {
      return;
    }
    const lines = readline.createInterface({ input: child.stderr });
    lines.on("line", (line) => {
      lifecycleOutputChannel.appendLine(
        `[${formatLogTimestamp()}] ${line}`
      );
    });
  }

  private logServerStopped(
    code: number | null,
    signal: NodeJS.Signals | null,
    child: ChildProcess
  ): void {
    const result = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    const reason = this.plannedRestarts.get(child);
    lifecycleOutputChannel.appendLine(
      `[${formatLogTimestamp()}] R Console language server stopped (${result}${reason ? `; planned restart: ${reason}` : ""})`
    );
  }

  private terminateSpawnedServer(): Promise<boolean> {
    if (this.terminationPromise) {
      return this.terminationPromise;
    }

    const child = this.spawnedServer;
    if (!child) {
      return Promise.resolve(true);
    }

    const terminationPromise = (async (): Promise<boolean> => {
      if (child.exitCode !== null || child.signalCode !== null) {
        if (this.spawnedServer === child) {
          this.spawnedServer = undefined;
        }
        return true;
      }
      const pid = child.pid;
      if (!pid) {
        if (this.spawnedServer === child) {
          this.spawnedServer = undefined;
        }
        return true;
      }

      let resolveExit!: () => void;
      const exitPromise = new Promise<void>((resolve) => {
        resolveExit = resolve;
        child.once("exit", resolveExit);
      });
      try {
        if (process.platform === "win32") {
          const result = spawnSync("taskkill", ["/pid", pid.toString(), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            shell: false,
          });
          if (result.status !== 0 && child.exitCode === null && child.signalCode === null) {
            let processHasExited = false;
            try {
              process.kill(pid, 0);
            } catch (error) {
              processHasExited = (error as NodeJS.ErrnoException).code === "ESRCH";
            }
            if (!processHasExited && !child.kill()) {
              child.removeListener("exit", resolveExit);
              return false;
            }
          }
        } else {
          process.kill(pid, "SIGKILL");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          child.removeListener("exit", resolveExit);
          return false;
        }
      }

      await exitPromise;
      if (this.spawnedServer === child) {
        this.spawnedServer = undefined;
      }
      return true;
    })();
    this.terminationPromise = terminationPromise;
    void terminationPromise.finally(() => {
      if (this.terminationPromise === terminationPromise) {
        this.terminationPromise = undefined;
      }
    });
    return terminationPromise;
  }

  private async disableConsoleDiagnostics(client: ConsoleLanguageClient): Promise<void> {
    try {
      await client.sendNotification("workspace/didChangeConfiguration", {
        settings: {
          r: {
            lsp: {
              diagnostics: false,
            },
          },
        },
      });
    } catch {
    }
  }
}
