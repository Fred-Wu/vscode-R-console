import { ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { URL } from "url";
import * as vscode from "vscode";
import {
  CloseAction,
  CompletionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ErrorAction,
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn,
  StreamInfo,
} from "vscode-languageclient/node";
import type { CompletionProvider } from "./completion";

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
};

type ConsoleLspSessionState = {
  attachedPackages: string[];
  loadedNamespaces: string[];
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

  constructor(private readonly options: ConsoleLspClientOptions) {
    this.outputChannel = new SilentOutputChannel("R Console");
    // A client removes only its own cwd after its R process has stopped.
    this.workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-lsp-"));
  }

  async start(): Promise<void> {
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
    return true;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.disposed = true;
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

  async provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string
  ): Promise<vscode.CompletionList | vscode.CompletionItem[] | undefined> {
    const client = await this.ensureClient();
    if (!client) {
      return undefined;
    }
    try {
      await this.syncDocument(client, doc);
      await this.applySessionState(client);
      const context: vscode.CompletionContext = triggerCharacter
        ? {
            triggerKind: vscode.CompletionTriggerKind.TriggerCharacter,
            triggerCharacter,
          }
        : {
            triggerKind: vscode.CompletionTriggerKind.Invoke,
            triggerCharacter: undefined,
          };
      const params = client.code2ProtocolConverter.asCompletionParams(doc, position, context);
      const result = await client.sendRequest(CompletionRequest.type, params);
      return await client.protocol2CodeConverter.asCompletionResult(result);
    } catch {
      return undefined;
    }
  }

  async prepareDocument(doc: vscode.TextDocument): Promise<void> {
    const client = await this.ensureClient();
    if (!client) {
      return;
    }
    await this.syncDocument(client, doc);
    await this.applySessionState(client);
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
    const stateKey = this.getSessionStateKey(this.sessionState);
    if (this.syncedSessionStateKey === stateKey) {
      return;
    }

    try {
      await client.sendRequest("rConsole/syncSessionState", this.sessionState);
      this.syncedSessionStateKey = stateKey;
    } catch {
    }
  }

  private getSessionStateKey(state: ConsoleLspSessionState): string {
    return [
      state.attachedPackages.join("\u0000"),
      state.loadedNamespaces.join("\u0000"),
    ].join("\u0001");
  }

  private async ensureClient(): Promise<ConsoleLanguageClient | undefined> {
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
    await client.start();
    await this.disableConsoleDiagnostics(client);
  }

  private createStdioTransport(args: string[], env: NodeJS.ProcessEnv): Promise<StreamInfo> {
    return new Promise<StreamInfo>((resolve, reject) => {
      let settled = false;
      let child: ChildProcess;
      try {
        child = spawn(this.options.rPath, args, {
          cwd: this.workingDirectory,
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
        this.logServerStopped(code, signal);
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

  private createSocketTransport(args: string[], baseEnv: NodeJS.ProcessEnv): Promise<StreamInfo> {
    return new Promise<StreamInfo>((resolve, reject) => {
      let settled = false;
      const server = net.createServer((socket) => {
        if (settled) {
          socket.destroy();
          return;
        }
        settled = true;
        if (this.pendingSocketServer === server) {
          this.pendingSocketServer = undefined;
        }
        socket.on("error", (error) => {
          this.logServerError(error);
        });
        server.close();
        resolve({ reader: socket, writer: socket });
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
        };
        let child: ChildProcess;
        try {
          child = spawn(this.options.rPath, args, {
            cwd: this.workingDirectory,
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
          this.logServerStopped(code, signal);
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

    // The lifecycle channel reports errors only; languageserver writes its
    // debug and info entries to the same stderr stream as errors.
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
      `[Info - ${timestamp}] R Console language server started`
    );
    lifecycleOutputChannel.appendLine(
      `[Info - ${timestamp}] R executable: "${this.options.rPath}"`
    );
  }

  private logServerError(error: unknown): void {
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
        `[R stderr - ${formatLogTimestamp()}] ${line}`
      );
    });
  }

  private logServerStopped(
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    const result = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    lifecycleOutputChannel.appendLine(
      `[Info - ${formatLogTimestamp()}] stopped (${result})`
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
