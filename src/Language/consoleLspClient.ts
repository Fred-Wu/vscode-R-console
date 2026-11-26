import { ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import { randomBytes } from "crypto";
import { authenticateLspSocket } from "./lspSocketAuth";
import { decodeStartupState, readStartupAcknowledgement, writeStartupState, type LspStartupStateStore } from "./lspStartupState";
import { BACKEND_AUTH_TIMEOUT_MS } from "../Runtime/backendAuthentication";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { URL } from "url";
import * as vscode from "vscode";
import {
  CancellationTokenSource,
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
import type { CompletionAnalysisMode, CompletionPickItem, CompletionProvider, CompletionResult, RuntimeFunctionArgumentsRequester } from "./completion";
import type { MemberInspectionResult } from "../Runtime/backendProtocol";
import { VirtualRDocument } from "./virtualRDocument";
import { getEnclosingCall } from "./completion/contextParser";
import { createCompletionParams } from "./completion/protocol";
import { backtickRName } from "./completion/rText";
import { parseRuntimeMemberQuery } from "./completion/runtimeMembers";
import { PackageInventory, type PackageInventoryChange } from "./packageInventory";
import type { WorkspaceData } from "../Runtime/VSCR/types";
import { workspaceStrings } from "../Runtime/VSCR/workspaceMetadata";
import { lifecycleOutputChannel } from "./completion/outputChannel";
import { staticCompletionUnavailableReason } from "./completion/diagnostics";
import { provideNativeStaticCompletion, type NativeSourceBinding } from "./completion/nativeStaticProvider";

const CONSOLE_LSP_HOST = "127.0.0.1";

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
  requestRuntimeFunctionArguments?: RuntimeFunctionArgumentsRequester;
  getStartupStateStore?: () => Promise<LspStartupStateStore>;
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
  private readonly argumentInspections = new WeakMap<object, {
    expression: string;
    isCurrent: () => boolean;
    result: MemberInspectionResult | undefined;
  }>();
  private readonly outputChannel: vscode.OutputChannel;
  private readonly workingDirectory: string;
  private readonly inputDocument: VirtualRDocument;
  private readonly packageDocument: VirtualRDocument;

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
  private startupPackages: string[] = [];
  private preparedPackages: {
    client: ConsoleLanguageClient;
    stateKey: string;
    staticAnalysis: boolean;
    startupPackages: string[];
    pending: Promise<void>;
  } | undefined;
  private readonly packageInventory: PackageInventory;
  private runtimeLibraryPaths: string[] | undefined;
  private serverLibraryPaths: string[] | undefined;
  private syncedLibraryPaths: { client: ConsoleLanguageClient; key: string } | undefined;
  private libraryPathsSyncPromise: Promise<void> | undefined;
  private libraryPathsRetry: NodeJS.Timeout | undefined;
  private libraryPathsRetryDelay = 1000;
  private packageRefreshPromise: Promise<void> | undefined;
  private packageRevision = 0;
  private runtimeRevision = 0;
  private restartPromise: Promise<void> | undefined;
  private startupState: Buffer | undefined;
  private startupStore: LspStartupStateStore | undefined;
  private startupStateLoaded = false;
  private startupStateSaved = false;
  private readonly plannedRestarts = new WeakMap<ChildProcess, string>();

  constructor(private readonly options: ConsoleLspClientOptions) {
    this.inputDocument = new VirtualRDocument(options.consoleId);
    this.packageDocument = new VirtualRDocument(`${options.consoleId}-packages`);
    this.outputChannel = new SilentOutputChannel("R Console");
    // Keep the LSP workspace isolated from project indexing.
    this.workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-lsp-"));
    // Restrict the isolated workspace to this user.
    if (process.platform !== "win32") fs.chmodSync(this.workingDirectory, 0o700);
    this.packageInventory = new PackageInventory(
      change => this.refreshPackages(change),
      message => lifecycleOutputChannel.appendLine(`[${formatLogTimestamp()}] ${message}`),
    );
  }

  async start(): Promise<void> {
    if (this.restartPromise) {
      await this.restartPromise;
    } else {
      await this.startClient();
    }
    await this.syncLibraryPaths();
  }

  private async startClient(): Promise<void> {
    if (this.disposed) {
      throw new Error("Cannot start a disposed console language server.");
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.client?.isRunning()) {
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
        this.preparedPackages = undefined;
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
      this.preparedPackages = undefined;
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
    this.preparedPackages = undefined;
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
    clearTimeout(this.libraryPathsRetry);
    this.startupState?.fill(0);
    this.startupState = undefined;
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

  provideStaticCompletion(request: import("./completion/types").StaticCompletionRequest) {
    if (!request.bindings.isCurrent()) return Promise.resolve({ status: "pending" as const, reason: "analysis-pending" as const });
    // Start readiness and provider-owned dependency discovery together. Observe
    // startup rejection immediately, even while a binding read is still pending.
    const ready = this.start().then(() => true, () => false);
    return provideNativeStaticCompletion(async binding => {
      if (!await ready || !request.bindings.isCurrent()) return undefined;
      return this.provideCompletionItems(request.document, request.position, request.triggerCharacter,
        request.contextPosition, undefined, "static", request.requestScope, binding, request.bindings.signal);
    }, request);
  }

  async provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string,
    contextPosition: vscode.Position = position,
    runtimeBracketKind?: "data.frame" | "data.table" | null,
    analysisMode?: CompletionAnalysisMode,
    requestScope: object = {},
    sourceBinding?: NativeSourceBinding,
    signal?: AbortSignal
  ): Promise<CompletionResult | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) return undefined;
      await this.packageRefreshPromise;
      if (signal?.aborted) return undefined;
      const revision = this.packageRevision;
      const client = await this.ensureClient();
      if (!client || signal?.aborted) {
        return undefined;
      }
      try {
        const staticAnalysis = analysisMode === undefined
          ? this.options.getStaticAnalysisEnabled?.() === true : analysisMode === "static";
        await this.applySessionState(client);
        if (signal?.aborted) return undefined;
        if (this.client !== client) {
          continue;
        }
        const projection = this.inputDocument.project(doc.getText(), staticAnalysis, contextPosition,
          staticAnalysis ? sourceBinding : undefined);
        await this.syncDocument(client, projection.document, signal);
        if (signal?.aborted) return undefined;
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
          staticAnalysis, sourceBinding);
        const documentVersion = projection.document.version;
        const sessionState = this.sessionState;
        const runtimeRevision = this.runtimeRevision;
        const snapshotCurrent = () => !this.disposed && this.client === client &&
          revision === this.packageRevision && runtimeRevision === this.runtimeRevision &&
          this.sessionState === sessionState &&
          this.syncedDocuments.get(projection.document.uri.toString())?.version === documentVersion;
        const isCurrent = () => !signal?.aborted && snapshotCurrent();
        // Use the already-published workspace snapshot; completion must not
        // query sess to resolve or inspect runtime objects.
        const globals = this.options.getCachedWorkspaceData?.()?.globalenv;
        // A verified native result supplies the actual stored receiver class,
        // even without a sess workspace snapshot (including nested receivers).
        // Without it, only an existing cached top-level binding may contribute.
        // The receiver grammar never evaluates calls, indices or assignments.
        const bracketReceiver = !staticAnalysis && params.rConsoleSubscriptOperator === "[" &&
          params.rConsoleDataObject ? parseRuntimeMemberQuery(params.rConsoleDataObject) : undefined;
        if (bracketReceiver) {
          const primaryClass = runtimeBracketKind !== undefined ? runtimeBracketKind :
            bracketReceiver.steps.length === 0 && globals &&
              Object.hasOwn(globals, bracketReceiver.root)
              ? workspaceStrings(globals[bracketReceiver.root].class)[0] : undefined;
          if (primaryClass === "data.table" || primaryClass === "data.frame") {
            (params as typeof params & { rConsoleSubscriptClass?: "data.table" | "data.frame" })
              .rConsoleSubscriptClass = primaryClass;
          }
        }
        let cachedSignature: string | undefined;
        if (params.rConsoleCall && globals && !params.rConsoleCall.includes("$") &&
            !params.rConsoleCall.includes("@") && !params.rConsoleCall.includes("::")) {
          const name = Object.hasOwn(globals, params.rConsoleCall)
            ? params.rConsoleCall
            : Object.keys(globals).find(key => backtickRName(key) === params.rConsoleCall);
          const item = name === undefined ? undefined : globals[name];
          if (item && ["closure", "builtin", "special"].includes(item.type) &&
              typeof item.str === "string" && /^\s*function\s*\(/.test(item.str)) {
            cachedSignature = item.str;
            (params as typeof params & { rConsoleRuntimeSignature?: string }).rConsoleRuntimeSignature = cachedSignature;
          }
        }
        // Stored functions share one argument-name reader regardless of class.
        // Retain ordinary cached signatures (including literal default choices),
        // but never parse class-specific display text to recover a signature.
        // Source bindings take precedence and native snapshots stay request-local.
        const functionQuery = params.rConsoleCall ? parseRuntimeMemberQuery(params.rConsoleCall, "arguments") : undefined;
        let functionInspection: MemberInspectionResult | undefined;
        if (functionQuery && (functionQuery.steps.length || !cachedSignature) &&
            this.options.requestRuntimeFunctionArguments) {
          const cached = this.argumentInspections.get(requestScope);
          if (cached) {
            if (cached.expression !== params.rConsoleCall || !cached.isCurrent()) return undefined;
            functionInspection = cached.result;
          } else {
            try {
              // A requester can decline an inspection (busy session, missing
              // capability or queue limit) without returning a status.
              functionInspection = (await this.options.requestRuntimeFunctionArguments(params.rConsoleCall!)) ??
                { status: "unavailable" };
            } catch { functionInspection = { status: "unavailable" }; }
            if (!isCurrent()) return undefined;
            this.argumentInspections.set(requestScope, { expression: params.rConsoleCall!,
              isCurrent: snapshotCurrent, result: functionInspection });
          }
          if (functionInspection?.status === "arguments") {
            Object.assign(params, { rConsoleRuntimeArgumentNames: functionInspection.names,
              rConsoleRuntimeArgumentRoot: functionQuery.root });
          } else if (functionInspection?.status === "suppressed" ||
              functionInspection?.status === "opaque" || functionInspection?.status === "unavailable" ||
              functionInspection?.status === "not-callable") {
            // Preserve unknown live callable identity, including unsupported
            // primitives and inspection limits. Only verified package/missing
            // outcomes authorize package inference without a source override.
            Object.assign(params, { rConsoleRuntimeArgumentsRefused: true });
          }
        }
        if (signal?.aborted) return undefined;
        const cancellation = signal ? new CancellationTokenSource() : undefined;
        const cancel = () => cancellation?.cancel();
        signal?.addEventListener("abort", cancel, { once: true });
        const result = await (async () => {
          try {
            return await client.sendRequest(CompletionRequest.type, params, cancellation?.token);
          } finally {
            signal?.removeEventListener("abort", cancel);
            cancellation?.dispose();
          }
        })();
        if (signal?.aborted) return undefined;
        if (this.client !== client || revision !== this.packageRevision) continue;
        if (!isCurrent()) return undefined;
        const completions: CompletionResult | undefined = await client.protocol2CodeConverter.asCompletionResult(result);
        if (!isCurrent()) return undefined;
        // VS Code's converter preserves standard LSP fields only. Carry this
        // source decision separately so an empty signature stays authoritative.
        for (const key of ["rConsoleRuntimeOnly", "rConsoleWorkspaceFunction", "rConsoleLocalFunction",
          "rConsoleMemberResolved", "rConsoleNativeArguments", "rConsoleArgumentsExhausted"] as const) {
          if (completions && (result as CompletionResult | null)?.[key] === true) completions[key] = true;
        }
        const staticReason = staticCompletionUnavailableReason(
          (result as { rConsoleStaticUnavailableReason?: unknown } | null)?.rConsoleStaticUnavailableReason);
        if (completions && staticReason) completions.rConsoleStaticUnavailableReason = staticReason;
        const argumentsResolved = (result as { rConsoleArgumentsResolved?: unknown } | null)?.rConsoleArgumentsResolved;
        if (completions && typeof argumentsResolved === "boolean") {
          completions.rConsoleArgumentsResolved = argumentsResolved;
        }
        if (completions && functionInspection?.status === "suppressed" &&
            (result as { rConsoleRuntimeArgumentsIgnored?: boolean } | null)?.rConsoleRuntimeArgumentsIgnored !== true) {
          completions.rConsoleArgumentSuppressionReason = functionInspection.reason;
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

  // The R console owns this ordered list. It may change after startup without
  // any change to the language server's working directory or attached packages.
  updateRuntimeLibraryPaths(paths: string[]): void {
    if (this.disposed) return;
    if (JSON.stringify(this.runtimeLibraryPaths) === JSON.stringify(paths)) return;
    const before = this.runtimeLibraryPaths ?? this.serverLibraryPaths ?? [];
    this.runtimeLibraryPaths = [...paths];
    this.runtimeRevision++;
    if (!this.disposed && this.client?.isRunning()) {
      lifecycleOutputChannel.appendLine(`[${formatLogTimestamp()}] [Libraries] R Console library search order changed: ${paths.join(" | ")}`);
      const removed = before.filter(path => !paths.includes(path));
      for (const library of removed) {
        lifecycleOutputChannel.appendLine(`[${formatLogTimestamp()}] [Libraries] Removed from search order: ${library}`);
      }
      this.packageInventory.setLibraryPaths(paths);
      this.scheduleLibraryPathsSync();
    }
  }

  resetRuntimeLibraryPaths(): void {
    if (!this.runtimeLibraryPaths) return;
    this.runtimeLibraryPaths = undefined;
    this.runtimeRevision++;
    if (this.client?.isRunning() && this.serverLibraryPaths) {
      this.packageInventory.setLibraryPaths(this.serverLibraryPaths);
      this.scheduleLibraryPathsSync();
    }
  }

  private scheduleLibraryPathsSync(): void {
    clearTimeout(this.libraryPathsRetry);
    this.libraryPathsRetry = undefined;
    void this.syncLibraryPaths().catch(() => {});
  }

  // This queue depends only on the R snapshot and the authenticated LSP
  // connection. Filesystem discovery can be slow, unavailable or disabled.
  private syncLibraryPaths(): Promise<void> {
    if (this.libraryPathsSyncPromise) return this.libraryPathsSyncPromise;
    if (this.disposed || !(this.runtimeLibraryPaths ?? this.serverLibraryPaths)) return Promise.resolve();
    const sync = (async () => {
      await this.startPromise;
      await this.restartPromise;
      if (!this.disposed && !this.client?.isRunning()) await this.startClient();
      while (!this.disposed && this.client?.isRunning()) {
        const client = this.client;
        const paths = this.runtimeLibraryPaths ?? this.serverLibraryPaths;
        if (!paths) return;
        const key = JSON.stringify(paths);
        if (this.syncedLibraryPaths?.client === client && this.syncedLibraryPaths.key === key) break;
        await this.closeCompletionDocuments(client);
        this.preparedPackages = undefined;
        const reply = await client.sendRequest<{ changed: boolean }>("rConsole/syncLibraryPaths", { libraryPaths: paths });
        if (this.disposed) return;
        if (this.client !== client) continue;
        if (typeof reply?.changed !== "boolean") throw new Error("Invalid library synchronization response");
        if (reply.changed) {
          // All namespace and metadata caches belong to the old library order.
          // A fresh process also drops namespaces loaded by completion workers.
          this.packageRevision++;
          this.options.onPackagesChanged?.();
          lifecycleOutputChannel.appendLine(`[${formatLogTimestamp()}] [Libraries] Library search order synchronized; refreshing language server.`);
          await this.restartClient(client, "library search order changed");
        } else {
          this.syncedLibraryPaths = { client, key };
        }
        // A newer snapshot may have arrived during the request or replacement.
      }
      clearTimeout(this.libraryPathsRetry);
      this.libraryPathsRetry = undefined;
      this.libraryPathsRetryDelay = 1000;
    })().catch(error => {
      if (!this.disposed && !this.libraryPathsRetry) {
        lifecycleOutputChannel.appendLine(`[${formatLogTimestamp()}] [Libraries] Library search order synchronization failed; retrying.`);
        this.libraryPathsRetry = setTimeout(() => {
          this.libraryPathsRetry = undefined;
          this.scheduleLibraryPathsSync();
        }, this.libraryPathsRetryDelay);
        this.libraryPathsRetry.unref();
        this.libraryPathsRetryDelay = Math.min(this.libraryPathsRetryDelay * 2, 30000);
      }
      throw error;
    }).finally(() => {
      if (this.libraryPathsSyncPromise === sync) this.libraryPathsSyncPromise = undefined;
    });
    this.libraryPathsSyncPromise = sync;
    return sync;
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
    await this.syncLibraryPaths();
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
      await this.prepareAttachedPackages(client, state);
      return;
    }

    let syncPromise = this.sessionStateSyncPromise;
    if (!syncPromise) {
      syncPromise = (async () => {
        // Retire documents and their pending metadata tasks before changing
        // the search path. Completion reopens the current input afterwards.
        await this.closeCompletionDocuments(client);
        return client.sendRequest<{ libraryPaths: string[]; startupPackages?: string[] }>("rConsole/syncSessionState", state);
      })()
        .then((reply) => {
          if (this.client === client && typeof reply === "object" && Array.isArray(reply?.libraryPaths)) {
            this.packageInventory.setLibraryPaths(this.runtimeLibraryPaths ?? reply.libraryPaths);
          }
          const synced = this.client === client;
          if (synced) {
            this.startupPackages = Array.isArray(reply?.startupPackages) ? reply.startupPackages : [];
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
    if (this.syncedSessionStateKey === currentStateKey) {
      await this.prepareAttachedPackages(client, this.sessionState);
    }
  }

  private async prepareAttachedPackages(client: ConsoleLanguageClient, state: ConsoleLspSessionState): Promise<void> {
    if (this.disposed || this.client !== client || this.sessionState !== state) return;
    const stateKey = this.getSessionStateKey(state);
    const staticAnalysis = this.options.getStaticAnalysisEnabled?.() === true;
    const previous = this.preparedPackages;
    if (previous?.client === client && previous.stateKey === stateKey &&
        previous.staticAnalysis === staticAnalysis && previous.startupPackages === this.startupPackages) {
      await previous.pending;
      return;
    }
    // Namespace references start languageserver's own asynchronous metadata
    // tasks without attaching packages in its workers. The sentinel needs no
    // matching export: this document requests metadata, never completions or
    // evaluation. Keep it stable to reuse native tasks and disk caches.
    const packages = staticAnalysis
      ? [...new Set(state.attachedPackages)].filter(name =>
        !this.startupPackages.includes(name) && /^[A-Za-z][A-Za-z0-9.]*$/.test(name)).reverse()
      : [];
    this.packageDocument.update(packages.map(name => `${name}::\`.__r_console_metadata__\``).join("\n"));
    const prepared = { client, stateKey, staticAnalysis, startupPackages: this.startupPackages,
      pending: Promise.resolve() };
    this.preparedPackages = prepared;
    prepared.pending = (packages.length
      ? this.syncDocument(client, this.packageDocument as unknown as vscode.TextDocument)
      : this.closeCompletionDocuments(client, this.packageDocument.uri.toString()))
      .catch(error => {
        if (this.preparedPackages === prepared) this.preparedPackages = undefined;
        throw error;
      });
    await prepared.pending;
  }

  private closeCompletionDocuments(client: ConsoleLanguageClient, uri?: string): Promise<void> {
    const close = this.documentSyncPromise.then(async () => {
      for (const [key, { document }] of this.syncedDocuments) {
        if (uri !== undefined && key !== uri) continue;
        if (this.client !== client) return;
        await client.sendNotification(DidCloseTextDocumentNotification.type,
          client.code2ProtocolConverter.asCloseTextDocumentParams(document));
        if (this.client === client) this.syncedDocuments.delete(key);
      }
    });
    this.documentSyncPromise = close.catch(() => {});
    return close;
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
      client = this.client;
      if (!client?.isRunning() || this.disposed) throw new Error("Language server changed during package refresh");
      if (!change.isCurrent()) return;
      if (change.changed.length) {
        this.packageRevision++;
        this.options.onPackagesChanged?.();
      }
      const params = {
        installations: Object.fromEntries([...change.packages].map(([name, item]) => [name, item.path])),
        deferred: change.libraries.flatMap(library => [...(library.deferred?.values() ?? [])].flat()),
        // A recovered server already loaded the current installations.
        changed: client === previousClient ? change.changed : [],
        changedInstallations: client === previousClient ? change.changedInstallations ?? change.changed : [],
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
        if (this.disposed) return;
        if (!client?.isRunning()) throw new Error("Replacement language server is not running");
        await this.applySessionState(client);
        if (!change.isCurrent()) return;
        const verified = await client.sendRequest<{ restart: string[] }>("rConsole/refreshPackages",
          { ...params, changed: [], changedInstallations: [] });
        if (this.disposed || this.client !== client) throw new Error("Language server changed during package refresh");
        if (!change.isCurrent()) return;
        if (verified.restart.length) {
          // Keep this inventory unpublished so recovery can retry the change.
          throw new Error(`Replacement language server retained stale packages: ${verified.restart.join(", ")}`);
        }
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
    // Session metadata may arrive while the initial library query is in flight.
    // It can use the running client once the snapshot's storage is acknowledged.
    const snapshotReady = this.startupState && (!this.startupStore || this.startupStateSaved);
    if (this.client?.isRunning() && (!this.startPromise || snapshotReady)) {
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
    if (this.options.getStartupStateStore && !this.startupStateLoaded) {
      this.startupStore ??= await this.options.getStartupStateStore();
      const state = await this.startupStore.load();
      if (this.disposed) {
        state?.fill(0);
        throw new Error("Console disposed during startup state retrieval");
      }
      this.startupState = state;
      this.startupStateSaved = state !== undefined;
      this.startupStateLoaded = true;
    }
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
    if (!this.startupState) {
      const state = decodeStartupState(await client.sendRequest<unknown>("rConsole/takeStartupState", {}));
      if (this.disposed || this.client !== client) {
        state.fill(0);
        throw new Error("Language server changed during startup state transfer");
      }
      this.startupState = state;
    }
    if (this.startupStore && !this.startupStateSaved) {
      await this.startupStore.save(this.startupState);
      if (this.disposed || this.client !== client) throw new Error("Console changed during startup state storage");
      this.startupStateSaved = true;
    }
    await this.disableConsoleDiagnostics(client);
    const libraries = await client.sendRequest<string[]>("rConsole/libraryPaths", {});
    if (this.client === client && !this.disposed) {
      this.serverLibraryPaths = [...libraries];
      this.syncedLibraryPaths = { client, key: JSON.stringify(libraries) };
      if (!this.syncedSessionStateKey) {
        this.packageInventory.setLibraryPaths(this.runtimeLibraryPaths ?? libraries);
      }
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
        if (this.startupState) {
          const ready = readStartupAcknowledgement(child.stdout);
          void ready.then(() => {
            if (settled) return;
            settled = true;
            resolve({ reader: child.stdout!, writer: child.stdin! });
          }, error => {
            if (!settled) { settled = true; reject(error); }
          });
          try {
            writeStartupState(child, this.startupState, error => {
              if (!settled) { settled = true; reject(error); }
            });
          } catch (error) {
            settled = true;
            reject(error);
          }
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
            stdio: [this.startupState ? "pipe" : "ignore", "ignore", "pipe"],
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
          if (this.startupState) {
            try {
              writeStartupState(child, this.startupState, rejectOnce);
              child.stdin!.end();
            } catch (error) {
              rejectOnce(error instanceof Error ? error : new Error("Startup state transfer failed"));
            }
          }
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
      ...(this.startupState ? ["--no-environ", "--no-site-file", "--no-init-file"] : []),
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

  private syncDocument(client: LanguageClient, document: vscode.TextDocument, signal?: AbortSignal): Promise<void> {
    const syncPromise = this.documentSyncPromise.then(async () => {
      if (signal?.aborted) return;
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
    // Each child gets fresh transport settings. Inherited settings must never
    // redirect a stdio child to another process's socket or state transport.
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith("VSCR_LSP_")) delete env[key];
    }
    const lang = config.get<string>("lsp.lang") ?? "";

    // Keep languageserver's verbose tracing out of the lifecycle channel.
    env.VSCR_LSP_DEBUG = "FALSE";
    // On a replacement server, apply the last console snapshot before loading namespaces.
    env.VSCR_RUNTIME_LIB_PATHS = (this.runtimeLibraryPaths ??
      (this.startupState ? this.serverLibraryPaths : undefined))?.join("\n") ?? "";
    env.VSCR_LSP_RESTORE_STARTUP = this.startupState ? "TRUE" : "FALSE";
    // The entry point restores the effective startup environment after R has
    // started without profiles or automatic default-package loading.
    if (this.startupState) env.R_DEFAULT_PACKAGES = "NULL";
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
