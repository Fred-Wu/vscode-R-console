import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  RTerminal,
  type PersistedRTerminalState,
  type PersistedRTerminalOptions,
  resolveRTerminalOptions,
} from "./Terminal/rTerminal";
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

type PersistedReloadState = {
  sessionId: string;
  consoles: PersistedConsoleRecord[];
};

type RestoredConsoleRecord = {
  persisted: PersistedConsoleRecord;
  record: ConsoleRecord;
  terminal: vscode.Terminal;
};

const terminalToRecord: Map<vscode.Terminal, ConsoleRecord> = new Map();
const rTerminalToRecord: Map<RTerminal, ConsoleRecord> = new Map();
const pidToRecord: Map<number, ConsoleRecord> = new Map();
const editorCloseInProgress: Set<number> = new Set();
const ignoredEditorClosePids: Set<number> = new Set();
const closeConfirmationInProgress = new WeakSet<ConsoleRecord>();
const ignoredTerminalCloseEvents = new WeakSet<vscode.Terminal>();
const R_CONSOLE_PID_LABEL_PATTERN = /^R Console \((\d+)\)$/;
let extensionBaseUri: vscode.Uri | undefined;
let persistedSessionFilePath: string | undefined;

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
  extensionBaseUri = context.extensionUri;
  const reloadStorageUri = context.storageUri ?? context.globalStorageUri;
  persistedSessionFilePath = vscode.Uri.joinPath(
    reloadStorageUri,
    "reload-sessions.json"
  ).fsPath;
  void fs.promises.mkdir(reloadStorageUri.fsPath, { recursive: true }).catch(() => {});
  context.subscriptions.push(
    vscode.commands.registerCommand("r-console.createTerminal", () => {
      void createRTerminal(context);
    }),
    vscode.commands.registerCommand("r-console.createTerminalSide", () => {
      void createRTerminal(context, true);
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

  await activateVscodeRExtension();
  await restorePersistedSessions(context);
  syncTerminalRecordsFromWindow();
  void ensureConfiguredRPath();
}

async function activateVscodeRExtension(): Promise<void> {
  const extension = vscode.extensions.getExtension("REditorSupport.r");
  if (!extension || extension.isActive) {
    return;
  }
  try {
    await extension.activate();
  } catch {
  }
}

async function restorePersistedSessions(context: vscode.ExtensionContext): Promise<void> {
  const persisted = await loadPersistedSessions(vscode.env.sessionId);
  if (persisted.length === 0) {
    return;
  }

  const restored: RestoredConsoleRecord[] = [];
  const restoringPids = new Set<number>();

  try {
    for (const entry of persisted) {
      const options = buildRestoredTerminalOptions(entry.terminal.options);
      if (!options) {
        continue;
      }

      const pid = getPersistedRuntimePid(entry.terminal);
      if (typeof pid === "number") {
        restoringPids.add(pid);
        ignoredEditorClosePids.add(pid);
      }

      const rTerminal = new RTerminal(options, context.extensionPath, entry.terminal);
      const record = createConsoleRecord(rTerminal, entry.location);
      const terminal = attachTerminal(record, true);
      restored.push({
        persisted: entry,
        record,
        terminal,
      });
    }

    if (restored.length === 0) {
      return;
    }

    const disposedStalePids = disposeStalePersistedTerminals(restored);
    if (disposedStalePids.size > 0) {
      await waitForStalePersistedTerminalsDisposed(restored);
    }
    if (restoringPids.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    for (const pid of restoringPids) {
      ignoredEditorClosePids.delete(pid);
    }
  }
}

function buildRestoredTerminalOptions(
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

function disposeStalePersistedTerminals(restored: readonly RestoredConsoleRecord[]): Set<number> {
  const restoredPids = new Set<number>();
  const replacementTerminals = new Set<vscode.Terminal>();
  for (const entry of restored) {
    const pid = getPersistedRuntimePid(entry.persisted.terminal);
    if (typeof pid === "number") {
      restoredPids.add(pid);
    }
    replacementTerminals.add(entry.terminal);
  }

  if (restoredPids.size === 0) {
    return new Set<number>();
  }

  const disposedPids = new Set<number>();
  for (const terminal of vscode.window.terminals) {
    if (replacementTerminals.has(terminal)) {
      continue;
    }
    const pid = parseConsolePidFromTerminal(terminal);
    if (typeof pid !== "number" || !restoredPids.has(pid)) {
      continue;
    }
    ignoredTerminalCloseEvents.add(terminal);
    ignoredEditorClosePids.add(pid);
    terminal.dispose();
    disposedPids.add(pid);
  }
  return disposedPids;
}

async function waitForStalePersistedTerminalsDisposed(
  restored: readonly RestoredConsoleRecord[]
): Promise<void> {
  const restoredPids = new Set<number>();
  const replacementTerminals = new Set<vscode.Terminal>();
  for (const entry of restored) {
    const pid = getPersistedRuntimePid(entry.persisted.terminal);
    if (typeof pid === "number") {
      restoredPids.add(pid);
    }
    replacementTerminals.add(entry.terminal);
  }

  if (restoredPids.size === 0) {
    return;
  }

  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const stillVisible = vscode.window.terminals.some((terminal) => {
      if (replacementTerminals.has(terminal)) {
        return false;
      }
      const pid = parseConsolePidFromTerminal(terminal);
      return typeof pid === "number" && restoredPids.has(pid);
    });
    if (!stillVisible) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
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

async function loadPersistedSessions(currentSessionId: string): Promise<PersistedConsoleRecord[]> {
  if (!persistedSessionFilePath) {
    return [];
  }
  try {
    const raw = await fs.promises.readFile(persistedSessionFilePath, "utf8");
    await fs.promises.rm(persistedSessionFilePath, { force: true });
    const parsed = JSON.parse(raw);
    if (!isPersistedReloadState(parsed)) {
      return [];
    }
    if (parsed.sessionId !== currentSessionId) {
      return [];
    }
    return parsed.consoles;
  } catch {
    return [];
  }
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

function isPersistedReloadState(value: unknown): value is PersistedReloadState {
  if (!isObjectRecord(value)) {
    return false;
  }
  if (typeof value.sessionId !== "string" || value.sessionId.trim().length === 0) {
    return false;
  }
  if (!Array.isArray(value.consoles)) {
    return false;
  }
  return value.consoles.every(isPersistedConsoleRecord);
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
  if (typeof value.watcherDir !== "string" || value.watcherDir.trim().length === 0) {
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
  });

  rTerminalToRecord.set(rTerminal, record);
  updateConsoleRecordPid(record, rTerminal.getPid());
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
}

function detachTerminalFromRecord(
  record: ConsoleRecord,
  terminal: vscode.Terminal
): void {
  terminalToRecord.delete(terminal);
  if (record.terminal === terminal) {
    record.terminal = undefined;
  }
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
}

function reattachRunningTerminal(record: ConsoleRecord): vscode.Terminal {
  record.rTerminal.reattachToNewTerminal();
  return attachTerminal(record, true);
}

async function handleRunningConsoleClose(record: ConsoleRecord): Promise<void> {
  if (closeConfirmationInProgress.has(record)) {
    return;
  }

  if (!record.rTerminal.isRunning()) {
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
      const suppressVscodeSessionDetach = record.rTerminal.shouldSuppressShutdownDetach();
      disposeConsoleRecord(record);
      record.rTerminal.forceClose({ suppressVscodeSessionDetach });
      terminalToRecord.delete(reattachedTerminal);
      reattachedTerminal.dispose();
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
  persistRunningSessionsForReload();
  for (const record of new Set(rTerminalToRecord.values())) {
    record.pidSubscription.dispose();
  }
  terminalToRecord.clear();
  rTerminalToRecord.clear();
  pidToRecord.clear();
}

function persistRunningSessionsForReload(): void {
  if (!persistedSessionFilePath) {
    return;
  }

  const persisted: PersistedConsoleRecord[] = [];
  for (const record of new Set(rTerminalToRecord.values())) {
    if (!record.rTerminal.isRunning()) {
      continue;
    }
    const terminal = record.rTerminal.exportPersistentState();
    if (!terminal) {
      continue;
    }
    persisted.push({
      terminal,
      location: record.location,
    });
  }

  if (persisted.length === 0) {
    try {
      fs.rmSync(persistedSessionFilePath, { force: true });
    } catch {
    }
    return;
  }

  try {
    fs.mkdirSync(path.dirname(persistedSessionFilePath), {
      recursive: true,
    });
    const reloadState: PersistedReloadState = {
      sessionId: vscode.env.sessionId,
      consoles: persisted,
    };
    fs.writeFileSync(persistedSessionFilePath, JSON.stringify(reloadState), "utf8");
  } catch {
  }
}
