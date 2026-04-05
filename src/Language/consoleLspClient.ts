import { ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
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
  SignatureHelpRequest,
  StreamInfo,
} from "vscode-languageclient/node";
import { SemanticTokensRequest } from "vscode-languageserver-protocol";
import type { CompletionProvider } from "./completion";
import type { SessionMemberCompletionItem } from "../Runtime/sessionWatcher";

type ConsoleLspClientOptions = {
  consoleId: string;
  rPath: string;
  requestMemberCompletions?: (
    expression: string,
    operator: "$" | "@"
  ) => Promise<SessionMemberCompletionItem[] | undefined>;
};

export type DocumentSemanticTokensResult = {
  legend: {
    tokenTypes: string[];
    tokenModifiers: string[];
  };
  data: number[];
};

class ConsoleLanguageClient extends LanguageClient {
  private suppressShutdownCloseMessage = false;

  setSuppressShutdownCloseMessage(value: boolean): void {
    this.suppressShutdownCloseMessage = value;
  }

  protected async handleConnectionClosed(): Promise<void> {
    if (this.suppressShutdownCloseMessage) {
      return;
    }
    await super.handleConnectionClosed();
  }

  error(message: string, data?: unknown, _showNotification: boolean | "force" = true): void {
    // Console-LSP failures are surfaced in the output channel, not as global popups.
    super.error(message, data, false);
  }
}

export class ConsoleLspClient implements CompletionProvider {
  private readonly outputChannel: vscode.OutputChannel;
  private readonly workingDirectory: string;

  private client: ConsoleLanguageClient | undefined;
  private suppressShutdownCloseMessage = false;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> = Promise.resolve();
  private spawnedServer: ChildProcess | undefined;
  private pendingSocketServer: net.Server | undefined;
  private syncedDocuments = new Map<string, { document: vscode.TextDocument; version: number }>();

  constructor(private readonly options: ConsoleLspClientOptions) {
    this.outputChannel = vscode.window.createOutputChannel(
      `R Console LSP (${this.options.consoleId.slice(0, 8)})`
    );
    this.workingDirectory = path.join(os.tmpdir(), "r-console", "lsp", this.options.consoleId);
    fs.mkdirSync(this.workingDirectory, { recursive: true });
  }

  async start(): Promise<void> {
    this.suppressShutdownCloseMessage = false;
    if (this.client) {
      this.client.setSuppressShutdownCloseMessage(false);
    }
    if (this.client?.isRunning()) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    this.startPromise = this.startInternal()
      .catch((error) => {
        const failedClient = this.client;
        this.client = undefined;
        if (failedClient) {
          try {
            failedClient.dispose();
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

  async stop(): Promise<void> {
    this.suppressShutdownCloseMessage = true;
    if (this.client) {
      this.client.setSuppressShutdownCloseMessage(true);
    }
    this.stopPromise = this.stopPromise.then(async () => {
      if (this.startPromise) {
        try {
          await this.startPromise;
        } catch {
        }
      }

      const client = this.client;
      this.client = undefined;
      if (!client) {
        this.closePendingSocketServer();
        this.terminateSpawnedServer();
        this.syncedDocuments.clear();
        return;
      }

      for (const { document } of this.syncedDocuments.values()) {
        try {
          client.sendNotification(
            DidCloseTextDocumentNotification.type,
            client.code2ProtocolConverter.asCloseTextDocumentParams(document)
          );
        } catch {
        }
      }
      this.syncedDocuments.clear();
      client.setSuppressShutdownCloseMessage(true);
      try {
        await client.stop();
      } catch {
      }
      try {
        client.dispose();
      } catch {
      }
      this.closePendingSocketServer();
      this.terminateSpawnedServer();
    });
    await this.stopPromise;
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.outputChannel.dispose();
    try {
      fs.rmSync(this.workingDirectory, { recursive: true, force: true });
    } catch {
    }
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
    this.syncDocument(client, doc);
    const context: vscode.CompletionContext = triggerCharacter
      ? {
          triggerKind: vscode.CompletionTriggerKind.TriggerCharacter,
          triggerCharacter,
        }
      : {
          triggerKind: vscode.CompletionTriggerKind.Invoke,
          triggerCharacter: undefined,
        };

    try {
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
    this.syncDocument(client, doc);
  }

  closeDocument(doc: vscode.TextDocument): void {
    const client = this.client;
    if (!client) {
      return;
    }

    const key = doc.uri.toString();
    if (!this.syncedDocuments.has(key)) {
      return;
    }

    try {
      client.sendNotification(
        DidCloseTextDocumentNotification.type,
        client.code2ProtocolConverter.asCloseTextDocumentParams(doc)
      );
    } catch {
    }

    this.syncedDocuments.delete(key);
  }

  async provideSignatureHelp(
    doc: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string
  ): Promise<vscode.SignatureHelp | undefined> {
    const client = await this.ensureClient();
    if (!client) {
      return undefined;
    }
    this.syncDocument(client, doc);
    const context: vscode.SignatureHelpContext = triggerCharacter
      ? {
          triggerKind: vscode.SignatureHelpTriggerKind.TriggerCharacter,
          triggerCharacter,
          isRetrigger: false,
          activeSignatureHelp: undefined,
        }
      : {
          triggerKind: vscode.SignatureHelpTriggerKind.Invoke,
          triggerCharacter: undefined,
          isRetrigger: false,
          activeSignatureHelp: undefined,
        };

    try {
      const params = client.code2ProtocolConverter.asSignatureHelpParams(doc, position, context);
      const result = await client.sendRequest(SignatureHelpRequest.type, params);
      return await client.protocol2CodeConverter.asSignatureHelp(result);
    } catch {
      return undefined;
    }
  }

  async provideDocumentSemanticTokens(
    doc: vscode.TextDocument
  ): Promise<DocumentSemanticTokensResult | undefined> {
    const client = await this.ensureClient();
    if (!client) {
      return undefined;
    }
    this.syncDocument(client, doc);

    const provider = client.initializeResult?.capabilities.semanticTokensProvider;
    const legend = provider?.legend;
    if (!legend) {
      return undefined;
    }

    try {
      const result = await client.sendRequest(SemanticTokensRequest.type, {
        textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(doc),
      });
      if (!result?.data) {
        return undefined;
      }
      return {
        legend: {
          tokenTypes: [...legend.tokenTypes],
          tokenModifiers: [...legend.tokenModifiers],
        },
        data: Array.from(result.data),
      };
    } catch {
      return undefined;
    }
  }

  async provideMemberCompletionItems(
    expression: string,
    operator: "$" | "@"
  ): Promise<SessionMemberCompletionItem[] | undefined> {
    if (!this.options.requestMemberCompletions) {
      return undefined;
    }
    try {
      return await this.options.requestMemberCompletions(expression, operator);
    } catch {
      return undefined;
    }
  }

  private async ensureClient(): Promise<ConsoleLanguageClient | undefined> {
    if (this.client?.isRunning()) {
      return this.client;
    }
    try {
      await this.start();
    } catch (error) {
      this.outputChannel.appendLine(`Failed to start console language server: ${String(error)}`);
      return undefined;
    }
    return this.client;
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
        // notification ordering before completion/signature requests.
      ],
      uriConverters: {
        code2Protocol: (uri: vscode.Uri) => new URL(uri.toString(true)).toString(),
        protocol2Code: (uri: string) => vscode.Uri.parse(uri),
      },
      outputChannel: this.outputChannel,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      errorHandler: {
        error: () => ({ action: ErrorAction.Continue, handled: true }),
        closed: () => ({ action: CloseAction.DoNotRestart, handled: true }),
      },
    };

    const client = new ConsoleLanguageClient(
      `r-console-${this.options.consoleId}`,
      "R Console Language Server",
      useStdio
        ? {
            command: this.options.rPath,
            args,
            options: {
              cwd: this.workingDirectory,
              env,
            },
          }
        : () => this.createSocketTransport(args, env),
      clientOptions
    );
    client.setSuppressShutdownCloseMessage(this.suppressShutdownCloseMessage);
    this.client = client;
    await client.start();
  }

  private createSocketTransport(args: string[], baseEnv: NodeJS.ProcessEnv): Promise<StreamInfo> {
    return new Promise<StreamInfo>((resolve, reject) => {
      let settled = false;
      const resolveOnce = (value: StreamInfo): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      const server = net.createServer((socket) => {
        this.pendingSocketServer = undefined;
        server.close();
        socket.on("error", (error) => {
          this.outputChannel.appendLine(`LSP socket error: ${error.message}`);
        });
        resolveOnce({ reader: socket, writer: socket });
      });

      this.pendingSocketServer = server;
      server.on("error", (error) => {
        this.pendingSocketServer = undefined;
        rejectOnce(error);
      });
      server.on("close", () => {
        this.pendingSocketServer = undefined;
        rejectOnce(new Error("Console language server socket closed before connection."));
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          this.pendingSocketServer = undefined;
          server.close();
          rejectOnce(new Error("Failed to allocate loopback port for console language server."));
          return;
        }
        const env: NodeJS.ProcessEnv = {
          ...baseEnv,
          VSCR_LSP_PORT: String(address.port),
        };
        const child = spawn(this.options.rPath, args, {
          cwd: this.workingDirectory,
          env,
          stdio: ["ignore", "ignore", "pipe"],
          shell: false,
        });
        this.spawnedServer = child;
        this.outputChannel.appendLine(`R Console Language Server (${child.pid ?? "unknown"}) started`);
        child.stderr?.on("data", (data: Buffer | string) => {
          this.outputChannel.appendLine(data.toString());
        });
        child.on("error", (error) => {
          this.outputChannel.appendLine(`R Console Language Server process error: ${error.message}`);
        });
        child.on("exit", (code, signal) => {
          this.outputChannel.appendLine(
            `R Console Language Server (${child.pid ?? "unknown"}) exited ${
              signal ? `from signal ${signal}` : `with exit code ${code ?? "null"}`
            }`
          );
          if (code === 10) {
            void vscode.window.showWarningMessage(
              "R package {languageserver} is required for console autocompletion."
            );
          }
          if (this.spawnedServer === child) {
            this.spawnedServer = undefined;
          }
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

  private syncDocument(client: LanguageClient, document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.syncedDocuments.get(key);
    if (!existing) {
      try {
        client.sendNotification(
          DidOpenTextDocumentNotification.type,
          client.code2ProtocolConverter.asOpenTextDocumentParams(document)
        );
      } catch {
      }
      this.syncedDocuments.set(key, { document, version: document.version });
      return;
    }

    if (existing.version !== document.version) {
      try {
        client.sendNotification(
          DidChangeTextDocumentNotification.type,
          client.code2ProtocolConverter.asChangeTextDocumentParams(document)
        );
      } catch {
      }
      this.syncedDocuments.set(key, { document, version: document.version });
      return;
    }

    if (existing.document !== document) {
      this.syncedDocuments.set(key, { document, version: document.version });
    }
  }

  private buildServerEnv(config: vscode.WorkspaceConfiguration): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = Object.create(process.env);
    const debug = config.get<boolean>("lsp.debug") === true;
    const useRenvLibPath = config.get<boolean>("useRenvLibPath") === true;
    const lang = config.get<string>("lsp.lang") ?? "";
    const libPaths = config.get<string[]>("libPaths") ?? [];

    env.VSCR_LSP_DEBUG = debug ? "TRUE" : "FALSE";
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
    const extension = vscode.extensions.getExtension("REditorSupport.r");
    const extensionPath = extension?.extensionPath;
    if (!extensionPath) {
      throw new Error("Cannot locate extension REditorSupport.r.");
    }
    const scriptPath = path.join(extensionPath, "R", "languageServer.R");
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Cannot locate language server script at ${scriptPath}`);
    }
    return scriptPath;
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

  private terminateSpawnedServer(): void {
    const child = this.spawnedServer;
    this.spawnedServer = undefined;
    if (!child) {
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const pid = child.pid;
    if (!pid) {
      return;
    }

    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", pid.toString(), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          shell: false,
        });
        return;
      }

      process.kill(pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }, 1000);
    } catch {
    }
  }
}
