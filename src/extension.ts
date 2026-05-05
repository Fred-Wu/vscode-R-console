import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  RTerminal,
  type PersistedRTerminalState,
  type PersistedRTerminalOptions,
  resolveRTerminalOptions,
} from "./Terminal/rTerminal";
import { createRuntimeBackend } from "./Terminal/rTerminal/runtime";
import {
  discoverRBinaryPath,
  getPlatformRPathConfigEntry,
} from "./Terminal/options";

type TerminalContext =
  | { kind: "panel" }
  | { kind: "editor"; viewColumn: vscode.ViewColumn };

type ConsoleRecord = {
  rTerminal: RTerminal;
  location: TerminalContext;
  terminal?: vscode.Terminal;
  pid?: number;
  pidSubscription: vscode.Disposable;
};

type PersistedConsoleRecord = {
  terminal: PersistedRTerminalState;
  location: TerminalContext;
};

type PersistentSessionState = {
  sessions: PersistedConsoleRecord[];
};

type ManagedPersistentSession = {
  sessionId: string;
  entry: PersistedConsoleRecord;
  attachedRecord?: ConsoleRecord;
  pid?: number;
  attached: boolean;
};

type ManageAction = vscode.QuickPickItem & {
  action: "attach" | "attachAll" | "close" | "closeAll" | "refresh";
};

type ManagedSessionPick = vscode.QuickPickItem & {
  session: ManagedPersistentSession;
};

const terminalToRecord: Map<vscode.Terminal, ConsoleRecord> = new Map();
const rTerminalToRecord: Map<RTerminal, ConsoleRecord> = new Map();
const pidToRecord: Map<number, ConsoleRecord> = new Map();
const persistentSessionRecords: Map<string, PersistedConsoleRecord> = new Map();
const editorCloseInProgress: Set<number> = new Set();
const ignoredEditorClosePids: Set<number> = new Set();
const closeConfirmationInProgress = new WeakSet<ConsoleRecord>();
const ignoredTerminalCloseEvents = new WeakSet<vscode.Terminal>();
const R_CONSOLE_PID_LABEL_PATTERN = /^R Console \((\d+)\)$/;
const PERSIST_DEBOUNCE_MS = 250;
const PERSIST_HEARTBEAT_MS = 5000;
let extensionBaseUri: vscode.Uri | undefined;
let persistentSessionFilePath: string | undefined;
let legacyReloadSessionFilePath: string | undefined;
let persistDebounceTimer: NodeJS.Timeout | undefined;
let persistHeartbeatTimer: NodeJS.Timeout | undefined;
let extensionHostDeactivating = false;

function isVirtualWorkspace(): boolean {
  const folders = vscode.workspace.workspaceFolders;
  return Boolean(folders && folders.length > 0 && folders.every((folder) => folder.uri.scheme !== "file"));
}

function refreshTerminalAppearance(): void {
  for (const record of new Set(rTerminalToRecord.values())) {
    record.rTerminal.refreshAppearance();
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionHostDeactivating = false;
  context.subscriptions.push(
    new vscode.Disposable(() => {
      extensionHostDeactivating = true;
    })
  );
  extensionBaseUri = context.extensionUri;
  const sessionStorageUri = context.storageUri ?? context.globalStorageUri;
  persistentSessionFilePath = vscode.Uri.joinPath(
    sessionStorageUri,
    "persistent-sessions.json"
  ).fsPath;
  legacyReloadSessionFilePath = vscode.Uri.joinPath(
    sessionStorageUri,
    "reload-sessions.json"
  ).fsPath;
  void fs.promises.mkdir(sessionStorageUri.fsPath, { recursive: true }).catch(() => {});
  await initializePersistentSessionRegistry();
  startPersistentSessionRegistry(context);
  context.subscriptions.push(
    vscode.commands.registerCommand("r-console.createTerminal", () => {
      void createRTerminal(context);
    }),
    vscode.commands.registerCommand("r-console.createTerminalSide", () => {
      void createRTerminal(context, true);
    }),
    vscode.commands.registerCommand("r-console.managePersistentSessions", () => {
      void managePersistentSessions(context);
    }),
    vscode.window.onDidOpenTerminal(handleTerminalOpen),
    vscode.window.onDidChangeActiveTerminal(handleActiveTerminalChange),
    vscode.window.onDidCloseTerminal(handleTerminalClose),
    vscode.window.tabGroups.onDidChangeTabs(handleTerminalTabChange),
    vscode.window.onDidChangeActiveColorTheme(() => {
      refreshTerminalAppearance();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("r.console")) {
        refreshTerminalAppearance();
      }
      const bracketedPasteScope = getBracketedPasteConfigScope();
      if (event.affectsConfiguration("r.bracketedPaste", bracketedPasteScope)) {
        warnIfBracketedPasteDisabled();
      }
    })
  );

  disposeStalePersistentTerminalViews();
  syncTerminalRecordsFromWindow();
  void ensureConfiguredRPath();
}

async function initializePersistentSessionRegistry(): Promise<void> {
  persistentSessionRecords.clear();
  const records = await loadPersistentSessionsFromDisk();
  for (const entry of records) {
    persistentSessionRecords.set(entry.terminal.runtime.sessionId, entry);
  }
  if (records.length > 0) {
    persistPersistentSessions();
  }
}

async function loadPersistentSessionsFromDisk(): Promise<PersistedConsoleRecord[]> {
  const records = new Map<string, PersistedConsoleRecord>();

  for (const filePath of [persistentSessionFilePath, legacyReloadSessionFilePath]) {
    if (!filePath) {
      continue;
    }
    for (const entry of await readPersistentSessionFile(filePath)) {
      records.set(entry.terminal.runtime.sessionId, entry);
    }
  }

  const liveRecords = [...records.values()].filter(hasLivePersistedRuntime);
  if (liveRecords.length === 0) {
    await removePersistentSessionFiles();
  }
  return liveRecords;
}

async function readPersistentSessionFile(filePath: string): Promise<PersistedConsoleRecord[]> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const sessions = parsePersistentSessionState(parsed);
    return sessions ? sessions.filter(hasLivePersistedRuntime) : [];
  } catch {
    return [];
  }
}

async function removePersistentSessionFiles(): Promise<void> {
  await Promise.all(
    [persistentSessionFilePath, legacyReloadSessionFilePath]
      .filter((filePath): filePath is string => typeof filePath === "string")
      .map((filePath) => fs.promises.rm(filePath, { force: true }).catch(() => {}))
  );
}

function buildPersistentTerminalOptions(
  persistedOptions: PersistedRTerminalOptions
): ReturnType<typeof resolveRTerminalOptions> {
  const currentOptions = resolveRTerminalOptions();
  if (!currentOptions) {
    return undefined;
  }
  return {
    ...currentOptions,
    ...persistedOptions,
    rArgs: [...persistedOptions.rArgs],
  };
}

function disposeStalePersistentTerminalViews(): void {
  const persistentPids = new Set<number>();
  for (const entry of persistentSessionRecords.values()) {
    const pid = getPersistedRuntimePid(entry.terminal);
    if (typeof pid === "number") {
      persistentPids.add(pid);
    }
  }
  if (persistentPids.size === 0) {
    return;
  }

  const ignoredPids = new Set<number>();
  for (const terminal of vscode.window.terminals) {
    if (resolveRecordFromTerminal(terminal)) {
      continue;
    }
    const pid = parseConsolePidFromTerminal(terminal);
    if (typeof pid !== "number" || !persistentPids.has(pid)) {
      continue;
    }
    ignoredTerminalCloseEvents.add(terminal);
    ignoredEditorClosePids.add(pid);
    ignoredPids.add(pid);
    terminal.dispose();
  }

  if (ignoredPids.size > 0) {
    setTimeout(() => {
      for (const pid of ignoredPids) {
        ignoredEditorClosePids.delete(pid);
      }
    }, 1000);
  }
}

function getPersistedRuntimePid(state: PersistedRTerminalState): number | undefined {
  const runtimePid = state.runtime.pid;
  if (isPositiveInteger(runtimePid)) {
    return runtimePid;
  }

  const backendChildPid = state.ui.backendChildPid;
  return isPositiveInteger(backendChildPid) ? backendChildPid : undefined;
}

function hasLivePersistedRuntime(entry: PersistedConsoleRecord): boolean {
  const pid = getPersistedRuntimePid(entry.terminal);
  return typeof pid !== "number" || isProcessAlive(pid);
}

function isPersistedConsoleRecord(value: unknown): value is PersistedConsoleRecord {
  if (!isObjectRecord(value)) {
    return false;
  }
  if (!isPersistedRTerminalState(value.terminal)) {
    return false;
  }
  if (!isPersistedTerminalContext(value.location)) {
    return false;
  }
  return true;
}

function parsePersistentSessionState(value: unknown): PersistedConsoleRecord[] | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  const sessions =
    Array.isArray(value.sessions)
      ? value.sessions
      : Array.isArray(value.consoles)
        ? value.consoles
        : undefined;
  if (!sessions || !sessions.every(isPersistedConsoleRecord)) {
    return undefined;
  }
  return sessions;
}

function isPersistedRTerminalState(value: unknown): value is PersistedRTerminalState {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    isPersistedRTerminalOptions(value.options) &&
    isRuntimeSessionReconnectInfo(value.runtime) &&
    isPersistedUiSnapshot(value.ui)
  );
}

function isPersistedRTerminalOptions(value: unknown): value is PersistedRTerminalOptions {
  if (!isObjectRecord(value)) {
    return false;
  }
  if (typeof value.rPath !== "string" || value.rPath.trim().length === 0) {
    return false;
  }
  if (!Array.isArray(value.rArgs) || value.rArgs.some((entry) => typeof entry !== "string")) {
    return false;
  }
  if (typeof value.sessionWatcherEnabled !== "boolean") {
    return false;
  }
  if (
    value.sessionMode !== undefined &&
    value.sessionMode !== "sess" &&
    value.sessionMode !== "legacy" &&
    value.sessionMode !== "disabled"
  ) {
    return false;
  }
  if (typeof value.watcherDir !== "string" || value.watcherDir.trim().length === 0) {
    return false;
  }
  if (value.vscodeRSessionInitPath !== undefined && typeof value.vscodeRSessionInitPath !== "string") {
    return false;
  }
  if (typeof value.bracketedPaste !== "boolean") {
    return false;
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    return false;
  }
  return true;
}

function isRuntimeSessionReconnectInfo(
  value: unknown
): value is PersistedRTerminalState["runtime"] {
  if (!isObjectRecord(value)) {
    return false;
  }
  if (typeof value.sessionId !== "string" || value.sessionId.trim().length === 0) {
    return false;
  }
  if (!isPositiveInteger(value.port)) {
    return false;
  }
  if (value.pid !== undefined && !isPositiveInteger(value.pid)) {
    return false;
  }
  return true;
}

function isPersistedUiSnapshot(value: unknown): value is PersistedRTerminalState["ui"] {
  if (!isObjectRecord(value) || !isPersistedReplaySnapshot(value.replay)) {
    return false;
  }
  if (!isPositiveInteger(value.replayColumns) || !isPositiveInteger(value.replayRows)) {
    return false;
  }
  if (!["starting", "ready", "executing", "reply", "closed"].includes(String(value.mode))) {
    return false;
  }
  if (!["main", "cont"].includes(String(value.promptKind))) {
    return false;
  }
  if (
    typeof value.promptReady !== "boolean" ||
    typeof value.promptVisible !== "boolean" ||
    typeof value.replyPromptText !== "string" ||
    typeof value.pendingPromptToken !== "boolean" ||
    typeof value.pendingInitialPromptGap !== "boolean" ||
    typeof value.lastWriteEndedWithNewline !== "boolean" ||
    typeof value.hasReceivedOutput !== "boolean" ||
    typeof value.inputText !== "string" ||
    !isNonNegativeInteger(value.inputCursorPosition)
  ) {
    return false;
  }
  if (value.backendChildPid !== undefined && !isPositiveInteger(value.backendChildPid)) {
    return false;
  }
  return true;
}

function isPersistedReplaySnapshot(
  value: unknown
): value is PersistedRTerminalState["ui"]["replay"] {
  if (!isObjectRecord(value)) {
    return false;
  }
  if (!Array.isArray(value.lines) || value.lines.some((line) => typeof line !== "string")) {
    return false;
  }
  return (
    isNonNegativeInteger(value.finalRow) &&
    isNonNegativeInteger(value.cursorRow) &&
    isNonNegativeInteger(value.cursorCol)
  );
}

function isPersistedTerminalContext(value: unknown): value is TerminalContext {
  if (!isObjectRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "panel") {
    return true;
  }
  return value.kind === "editor" && typeof value.viewColumn === "number";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isObjectRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function handleTerminalClose(closedTerminal: vscode.Terminal): Promise<void> {
  if (ignoredTerminalCloseEvents.has(closedTerminal)) {
    ignoredTerminalCloseEvents.delete(closedTerminal);
    terminalToRecord.delete(closedTerminal);
    return;
  }

  const record = resolveRecordFromTerminal(closedTerminal);
  if (!record) return;

  detachTerminalFromRecord(record, closedTerminal);

  if (extensionHostDeactivating) {
    return;
  }

  if (record.location.kind === "editor") {
    return;
  }

  await handleRunningConsoleClose(record);
}

async function createRTerminal(
  context: vscode.ExtensionContext,
  inSideEditor: boolean = false
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showErrorMessage(
      "R Console requires a trusted workspace because it launches local R executables."
    );
    return;
  }

  if (isVirtualWorkspace()) {
    void vscode.window.showErrorMessage(
      "R Console requires local file-system workspace access and is unavailable in virtual workspaces."
    );
    return;
  }

  warnIfBracketedPasteDisabled(true);

  const options = resolveRTerminalOptions();
  if (!options) {
    return;
  }

  const rTerminal = new RTerminal(options, context.extensionPath);
  const record = createConsoleRecord(
    rTerminal,
    inSideEditor
      ? { kind: "editor", viewColumn: vscode.ViewColumn.Beside }
      : { kind: "panel" }
  );

  attachTerminal(record);
  schedulePersistPersistentSessions();
}

async function managePersistentSessions(context: vscode.ExtensionContext): Promise<void> {
  let sessions = await refreshManagedPersistentSessions();
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage("No persistent R console sessions are running.");
    return;
  }

  while (true) {
    const action = await pickManageAction(sessions);
    if (!action) {
      return;
    }

    if (action.action === "refresh") {
      sessions = await refreshManagedPersistentSessions();
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage("No persistent R console sessions are running.");
        return;
      }
      continue;
    }

    if (action.action === "attachAll") {
      await attachPersistentSessions(sessions.filter((session) => !session.attached), context);
      return;
    }

    if (action.action === "attach") {
      const selected = await pickPersistentSessions(
        sessions.filter((session) => !session.attached),
        "Select persistent R console sessions to attach"
      );
      if (selected.length > 0) {
        await attachPersistentSessions(selected, context);
      }
      return;
    }

    if (action.action === "closeAll") {
      await closePersistentSessions(sessions, context);
      return;
    }

    const selected = await pickPersistentSessions(
      sessions,
      "Select persistent R console sessions to close permanently"
    );
    if (selected.length > 0) {
      await closePersistentSessions(selected, context);
    }
    return;
  }
}

async function refreshManagedPersistentSessions(): Promise<ManagedPersistentSession[]> {
  for (const entry of await loadPersistentSessionsFromDisk()) {
    persistentSessionRecords.set(entry.terminal.runtime.sessionId, entry);
  }
  prunePersistentSessionRegistry();
  const sessions = collectManagedPersistentSessions();
  persistPersistentSessions();
  return sessions;
}

function collectManagedPersistentSessions(): ManagedPersistentSession[] {
  const sessions = new Map<string, ManagedPersistentSession>();

  for (const entry of persistentSessionRecords.values()) {
    const sessionId = entry.terminal.runtime.sessionId;
    sessions.set(sessionId, {
      sessionId,
      entry,
      pid: getPersistedRuntimePid(entry.terminal),
      attached: false,
    });
  }

  for (const record of new Set(rTerminalToRecord.values())) {
    if (!record.rTerminal.isRunning()) {
      continue;
    }
    const terminal = record.rTerminal.exportPersistentState();
    if (!terminal) {
      continue;
    }
    const sessionId = terminal.runtime.sessionId;
    const entry: PersistedConsoleRecord = {
      terminal,
      location: record.location,
    };
    persistentSessionRecords.set(sessionId, entry);
    sessions.set(sessionId, {
      sessionId,
      entry,
      attachedRecord: record,
      pid: getPersistedRuntimePid(terminal),
      attached: true,
    });
  }

  return [...sessions.values()]
    .filter((session) => hasLivePersistedRuntime(session.entry))
    .sort((left, right) => formatManagedSessionLabel(left).localeCompare(formatManagedSessionLabel(right)));
}

function prunePersistentSessionRegistry(): void {
  for (const [sessionId, entry] of persistentSessionRecords) {
    if (!hasLivePersistedRuntime(entry)) {
      persistentSessionRecords.delete(sessionId);
    }
  }
}

async function pickManageAction(
  sessions: readonly ManagedPersistentSession[]
): Promise<ManageAction | undefined> {
  const detachedCount = sessions.filter((session) => !session.attached).length;
  const actions: ManageAction[] = [];

  if (detachedCount > 0) {
    actions.push(
      {
        label: "Attach Session...",
        description: `${detachedCount} detached`,
        action: "attach",
      },
      {
        label: "Attach All Detached Sessions",
        description: `${detachedCount} detached`,
        action: "attachAll",
      }
    );
  }

  actions.push(
    {
      label: "Close Session...",
      description: `${sessions.length} running`,
      action: "close",
    },
    {
      label: "Close All Sessions",
      description: `${sessions.length} running`,
      action: "closeAll",
    },
    {
      label: "Refresh",
      action: "refresh",
    }
  );

  return vscode.window.showQuickPick(actions, {
    placeHolder: "Manage persistent R console sessions",
  });
}

async function pickPersistentSessions(
  sessions: readonly ManagedPersistentSession[],
  placeHolder: string
): Promise<ManagedPersistentSession[]> {
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage("No matching persistent R console sessions are running.");
    return [];
  }

  const picks = sessions.map((session): ManagedSessionPick => ({
    label: formatManagedSessionLabel(session),
    description: session.attached ? "attached" : "detached",
    detail: formatManagedSessionDetail(session),
    session,
  }));

  const selected = await vscode.window.showQuickPick(picks, {
    canPickMany: true,
    placeHolder,
  });
  return selected?.map((pick) => pick.session) ?? [];
}

async function attachPersistentSessions(
  sessions: readonly ManagedPersistentSession[],
  context: vscode.ExtensionContext
): Promise<void> {
  for (const session of sessions) {
    if (session.attachedRecord) {
      revealConsoleRecord(session.attachedRecord);
      continue;
    }

    if (!hasLivePersistedRuntime(session.entry)) {
      persistentSessionRecords.delete(session.sessionId);
      continue;
    }

    const options = buildPersistentTerminalOptions(session.entry.terminal.options);
    if (!options) {
      continue;
    }

    const rTerminal = new RTerminal(options, context.extensionPath, session.entry.terminal);
    const record = createConsoleRecord(rTerminal, session.entry.location);
    attachTerminal(record, true);
  }
  schedulePersistPersistentSessions();
}

function revealConsoleRecord(record: ConsoleRecord): void {
  if (record.terminal) {
    record.terminal.show(false);
    return;
  }
  reattachRunningTerminal(record);
}

async function closePersistentSessions(
  sessions: readonly ManagedPersistentSession[],
  context: vscode.ExtensionContext
): Promise<void> {
  const liveSessions = sessions.filter((session) => hasLivePersistedRuntime(session.entry));
  if (liveSessions.length === 0) {
    void vscode.window.showInformationMessage("No selected persistent R console sessions are still running.");
    return;
  }

  const result = await vscode.window.showWarningMessage(
    `Close ${liveSessions.length} persistent R console session${liveSessions.length === 1 ? "" : "s"} permanently?`,
    { modal: true },
    "Close"
  );
  if (result !== "Close") {
    return;
  }

  const detachedSessions = liveSessions.filter((session) => !session.attachedRecord);
  closeDetachedPersistentSessions(detachedSessions, context);

  for (const session of liveSessions) {
    if (session.attachedRecord) {
      closeConsoleRecordPermanently(session.attachedRecord);
    }
  }

  persistPersistentSessions();
}

function closeDetachedPersistentSessions(
  sessions: readonly ManagedPersistentSession[],
  context: vscode.ExtensionContext
): void {
  if (sessions.length === 0) {
    return;
  }

  const backend = createRuntimeBackend(context.extensionPath);
  if (!backend) {
    void vscode.window.showErrorMessage("R Console sidecar backend not found; detached sessions could not be closed.");
    return;
  }

  for (const session of sessions) {
    const handle = backend.reconnect(session.entry.terminal.runtime);
    backend.close(handle);
    persistentSessionRecords.delete(session.sessionId);
  }
}

function formatManagedSessionLabel(session: ManagedPersistentSession): string {
  return typeof session.pid === "number"
    ? `R Console (${session.pid})`
    : `R Console (${session.sessionId.slice(0, 8)})`;
}

function formatManagedSessionDetail(session: ManagedPersistentSession): string {
  const cwd = session.entry.terminal.options.cwd || "default working directory";
  return `cwd: ${cwd} | session: ${session.sessionId}`;
}

async function ensureConfiguredRPath(): Promise<void> {
  const config = vscode.workspace.getConfiguration("r");
  const configEntry = getPlatformRPathConfigEntry();
  const configured = (config.get<string>(configEntry) || "").trim();
  if (configured.length > 0) {
    return;
  }

  const discovered = discoverRBinaryPath();
  if (!discovered) {
    return;
  }

  await config.update(configEntry, discovered, vscode.ConfigurationTarget.Global);
}

function warnIfBracketedPasteDisabled(force: boolean = false): void {
  if (!force && rTerminalToRecord.size === 0) {
    return;
  }

  const enabled = vscode.workspace
    .getConfiguration("r", getBracketedPasteConfigScope())
    .get<boolean>("bracketedPaste", false);
  if (enabled) {
    return;
  }

  void vscode.window.showWarningMessage(
    "Set r.bracketedPaste to true for correct editor-send behavior in R Console.",
    "Open Settings"
  ).then((selection) => {
    if (selection === "Open Settings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "r.bracketedPaste");
    }
  });
}

function getBracketedPasteConfigScope(): vscode.ConfigurationScope | undefined {
  const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
  if (activeDocumentUri && activeDocumentUri.scheme === "file") {
    return activeDocumentUri;
  }

  return vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === "file")?.uri;
}

function createConsoleRecord(
  rTerminal: RTerminal,
  location: TerminalContext
): ConsoleRecord {
  const record: ConsoleRecord = {
    rTerminal,
    location,
    pidSubscription: new vscode.Disposable(() => {}),
  };

  record.pidSubscription = rTerminal.onDidChangePid((pid) => {
    updateConsoleRecordPid(record, pid);
    schedulePersistPersistentSessions();
  });

  rTerminalToRecord.set(rTerminal, record);
  updateConsoleRecordPid(record, rTerminal.getPid());
  schedulePersistPersistentSessions();
  return record;
}

function updateConsoleRecordPid(
  record: ConsoleRecord,
  pid: number | undefined
): void {
  if (record.pid === pid) {
    return;
  }

  if (typeof record.pid === "number") {
    pidToRecord.delete(record.pid);
  }

  record.pid = pid;

  if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
    pidToRecord.set(pid, record);
    syncConsoleRecordLocationFromTabs(record);
  }
  schedulePersistPersistentSessions();
}

function detachTerminalFromRecord(
  record: ConsoleRecord,
  terminal: vscode.Terminal
): void {
  terminalToRecord.delete(terminal);
  if (record.terminal === terminal) {
    record.terminal = undefined;
  }
  schedulePersistPersistentSessions();
}

function disposeConsoleRecord(record: ConsoleRecord): void {
  if (typeof record.pid === "number") {
    pidToRecord.delete(record.pid);
  }
  record.pid = undefined;
  record.pidSubscription.dispose();
  rTerminalToRecord.delete(record.rTerminal);

  for (const [terminal, mappedRecord] of terminalToRecord) {
    if (mappedRecord === record) {
      terminalToRecord.delete(terminal);
    }
  }
  record.terminal = undefined;
  schedulePersistPersistentSessions();
}

function closeConsoleRecordPermanently(
  record: ConsoleRecord,
  terminalToDispose: vscode.Terminal | undefined = record.terminal
): void {
  forgetPersistentSessionForRecord(record);
  disposeConsoleRecord(record);
  record.rTerminal.forceClose();
  if (terminalToDispose) {
    terminalToRecord.delete(terminalToDispose);
    terminalToDispose.dispose();
  }
}

function forgetPersistentSessionForRecord(record: ConsoleRecord): void {
  const sessionId = getPersistentSessionIdForRecord(record);
  if (sessionId) {
    persistentSessionRecords.delete(sessionId);
  }
}

function getPersistentSessionIdForRecord(record: ConsoleRecord): string | undefined {
  const state = record.rTerminal.exportPersistentState();
  if (state?.runtime.sessionId) {
    return state.runtime.sessionId;
  }

  if (typeof record.pid !== "number") {
    return undefined;
  }
  for (const [sessionId, entry] of persistentSessionRecords) {
    if (getPersistedRuntimePid(entry.terminal) === record.pid) {
      return sessionId;
    }
  }
  return undefined;
}

function reattachRunningTerminal(record: ConsoleRecord): vscode.Terminal {
  record.rTerminal.reattachToNewTerminal();
  return attachTerminal(record, true);
}

async function handleRunningConsoleClose(record: ConsoleRecord): Promise<void> {
  if (closeConfirmationInProgress.has(record)) {
    return;
  }

  if (!record.rTerminal.requiresCloseConfirmation()) {
    forgetPersistentSessionForRecord(record);
    disposeConsoleRecord(record);
    return;
  }

  closeConfirmationInProgress.add(record);
  try {
    const reattachedTerminal = reattachRunningTerminal(record);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await vscode.window.showWarningMessage(
      "Are you sure you want to close the R console?",
      { modal: true },
      "Close"
    );

    if (result === "Close") {
      closeConsoleRecordPermanently(record, reattachedTerminal);
    }
  } finally {
    closeConfirmationInProgress.delete(record);
  }
}

function attachTerminal(
  record: ConsoleRecord,
  preserveFocusOverride?: boolean
): vscode.Terminal {
  const terminalOptions: vscode.ExtensionTerminalOptions = {
    name: record.rTerminal.getTerminalName(),
    pty: record.rTerminal,
    iconPath: extensionBaseUri
      ? vscode.Uri.joinPath(extensionBaseUri, "images", "Rlogo.png")
      : new vscode.ThemeIcon("terminal"),
    isTransient: true,
  };

  if (record.location.kind === "editor") {
    terminalOptions.location = { viewColumn: record.location.viewColumn };
  }

  const terminal = vscode.window.createTerminal(terminalOptions);
  if (record.terminal) {
    terminalToRecord.delete(record.terminal);
  }
  record.terminal = terminal;
  terminalToRecord.set(terminal, record);

  const alwaysUseActive = vscode.workspace.getConfiguration("r").get<boolean>("alwaysUseActiveTerminal");
  const preserveFocus =
    preserveFocusOverride ?? alwaysUseActive === false;
  terminal.show(preserveFocus);
  return terminal;
}

function handleTerminalOpen(terminal: vscode.Terminal): void {
  syncTerminalRecord(terminal);
}

function handleActiveTerminalChange(terminal: vscode.Terminal | undefined): void {
  if (!terminal) {
    return;
  }
  syncTerminalRecord(terminal);
  resolveRecordFromTerminal(terminal)?.rTerminal.activateVscodeRSession();
}

function resolveRecordFromTerminal(
  terminal: vscode.Terminal
): ConsoleRecord | undefined {
  const directRecord = terminalToRecord.get(terminal);
  if (directRecord) {
    return directRecord;
  }

  const rTerminal = resolveRTerminalFromCreationOptions(terminal);
  if (rTerminal) {
    const record = rTerminalToRecord.get(rTerminal);
    if (record) {
      terminalToRecord.set(terminal, record);
      return record;
    }
  }

  return undefined;
}

function syncTerminalRecordsFromWindow(): void {
  for (const terminal of vscode.window.terminals) {
    syncTerminalRecord(terminal);
  }
}

function syncTerminalRecord(terminal: vscode.Terminal): void {
  if (terminalToRecord.has(terminal)) {
    return;
  }

  const record = resolveRecordFromTerminal(terminal);
  if (record) {
    terminalToRecord.set(terminal, record);
  }
}

function resolveRTerminalFromCreationOptions(
  terminal: vscode.Terminal
): RTerminal | undefined {
  const options = terminal.creationOptions;
  if (!("pty" in options) || !(options.pty instanceof RTerminal)) {
    return undefined;
  }
  return options.pty;
}

function parseConsolePidFromTerminal(
  terminal: vscode.Terminal
): number | undefined {
  for (const name of getTerminalCandidateNames(terminal)) {
    const pid = parseConsolePidFromLabel(name);
    if (typeof pid === "number") {
      return pid;
    }
  }
  return undefined;
}

function getTerminalCandidateNames(terminal: vscode.Terminal): string[] {
  const names = new Set<string>();
  if (terminal.name.length > 0) {
    names.add(terminal.name);
  }
  const options = terminal.creationOptions;
  if ("name" in options && typeof options.name === "string" && options.name.length > 0) {
    names.add(options.name);
  }
  return [...names];
}

function parseConsolePidFromLabel(label: string): number | undefined {
  const match = label.match(R_CONSOLE_PID_LABEL_PATTERN);
  if (!match) {
    return undefined;
  }

  const pid = Number.parseInt(match[1], 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function handleTerminalTabChange(event: vscode.TabChangeEvent): void {
  syncTerminalRecordsFromWindow();

  for (const tab of [...event.opened, ...event.changed]) {
    if (!(tab.input instanceof vscode.TabInputTerminal)) {
      continue;
    }

    const pid = parseConsolePidFromLabel(tab.label);
    if (typeof pid !== "number") {
      continue;
    }

    const record = pidToRecord.get(pid);
    if (!record) {
      continue;
    }

    record.location = {
      kind: "editor",
      viewColumn: tab.group.viewColumn,
    };
    schedulePersistPersistentSessions();
  }

  for (const tab of event.closed) {
    if (!(tab.input instanceof vscode.TabInputTerminal)) {
      continue;
    }

    const pid = parseConsolePidFromLabel(tab.label);
    if (typeof pid !== "number") {
      continue;
    }

    void handleEditorTerminalTabClosed(pid);
  }
}

async function handleEditorTerminalTabClosed(pid: number): Promise<void> {
  if (ignoredEditorClosePids.has(pid)) {
    return;
  }

  if (editorCloseInProgress.has(pid)) {
    return;
  }

  const record = pidToRecord.get(pid);
  if (!record || record.location.kind !== "editor") {
    return;
  }

  editorCloseInProgress.add(pid);

  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    syncTerminalRecordsFromWindow();

    if (findEditorTabByPid(pid)) {
      syncConsoleRecordLocationFromTabs(record);
      return;
    }

    await handleRunningConsoleClose(record);
  } finally {
    editorCloseInProgress.delete(pid);
  }
}

function syncConsoleRecordLocationFromTabs(record: ConsoleRecord): void {
  if (typeof record.pid !== "number") {
    return;
  }

  const tab = findEditorTabByPid(record.pid);
  if (!tab) {
    return;
  }

  record.location = {
    kind: "editor",
    viewColumn: tab.group.viewColumn,
  };
  schedulePersistPersistentSessions();
}

function findEditorTabByPid(pid: number): vscode.Tab | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputTerminal)) {
        continue;
      }
      if (parseConsolePidFromLabel(tab.label) !== pid) {
        continue;
      }
      return tab;
    }
  }

  return undefined;
}

export function deactivate() {
  extensionHostDeactivating = true;
  flushPersistPersistentSessions();
  for (const record of new Set(rTerminalToRecord.values())) {
    record.pidSubscription.dispose();
    record.rTerminal.dispose();
  }
  terminalToRecord.clear();
  rTerminalToRecord.clear();
  pidToRecord.clear();
}

function startPersistentSessionRegistry(context: vscode.ExtensionContext): void {
  persistHeartbeatTimer = setInterval(() => {
    if (rTerminalToRecord.size > 0 || persistentSessionRecords.size > 0) {
      persistPersistentSessions();
    }
  }, PERSIST_HEARTBEAT_MS);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (persistHeartbeatTimer) {
        clearInterval(persistHeartbeatTimer);
        persistHeartbeatTimer = undefined;
      }
      if (persistDebounceTimer) {
        clearTimeout(persistDebounceTimer);
        persistDebounceTimer = undefined;
      }
    })
  );
}

function schedulePersistPersistentSessions(): void {
  if (!persistentSessionFilePath || persistDebounceTimer) {
    return;
  }
  persistDebounceTimer = setTimeout(() => {
    persistDebounceTimer = undefined;
    persistPersistentSessions();
  }, PERSIST_DEBOUNCE_MS);
}

function flushPersistPersistentSessions(): void {
  if (persistDebounceTimer) {
    clearTimeout(persistDebounceTimer);
    persistDebounceTimer = undefined;
  }
  persistPersistentSessions();
}

function persistPersistentSessions(): void {
  if (!persistentSessionFilePath) {
    return;
  }

  const sessionMap = new Map(persistentSessionRecords);
  for (const record of new Set(rTerminalToRecord.values())) {
    if (!record.rTerminal.isRunning()) {
      continue;
    }
    const terminal = record.rTerminal.exportPersistentState();
    if (!terminal) {
      continue;
    }
    sessionMap.set(terminal.runtime.sessionId, {
      terminal,
      location: record.location,
    });
  }

  const persisted = [...sessionMap.values()].filter(hasLivePersistedRuntime);
  persistentSessionRecords.clear();
  for (const entry of persisted) {
    persistentSessionRecords.set(entry.terminal.runtime.sessionId, entry);
  }

  if (persisted.length === 0) {
    try {
      fs.rmSync(persistentSessionFilePath, { force: true });
      if (legacyReloadSessionFilePath) {
        fs.rmSync(legacyReloadSessionFilePath, { force: true });
      }
    } catch {
    }
    return;
  }

  try {
    fs.mkdirSync(path.dirname(persistentSessionFilePath), {
      recursive: true,
    });
    const sessionState: PersistentSessionState = {
      sessions: persisted,
    };
    fs.writeFileSync(persistentSessionFilePath, JSON.stringify(sessionState), "utf8");
    if (legacyReloadSessionFilePath) {
      fs.rmSync(legacyReloadSessionFilePath, { force: true });
    }
  } catch {
  }
}
