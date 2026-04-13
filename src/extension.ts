import * as vscode from "vscode";
import {
  RTerminal,
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
  pid?: number;
  pidSubscription: vscode.Disposable;
};

const terminalToRecord: Map<vscode.Terminal, ConsoleRecord> = new Map();
const rTerminalToRecord: Map<RTerminal, ConsoleRecord> = new Map();
const pidToRecord: Map<number, ConsoleRecord> = new Map();
const editorCloseInProgress: Set<number> = new Set();
const VSCODE_R_TERMINAL_NAME = "R Console";

function isVirtualWorkspace(): boolean {
  const folders = vscode.workspace.workspaceFolders;
  return Boolean(folders && folders.length > 0 && folders.every((folder) => folder.uri.scheme !== "file"));
}

function refreshTerminalAppearance(): void {
  for (const record of new Set(rTerminalToRecord.values())) {
    record.rTerminal.refreshAppearance();
  }
}

export function activate(context: vscode.ExtensionContext) {
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

  syncTerminalRecordsFromWindow();
  void ensureConfiguredRPath();
}

async function handleTerminalClose(closedTerminal: vscode.Terminal): Promise<void> {
  const record = resolveRecordFromTerminal(closedTerminal);
  if (!record) return;

  terminalToRecord.delete(closedTerminal);

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
    syncTerminalRecordForPid(pid);
    syncConsoleRecordLocationFromTabs(record);
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
}

function reattachRunningTerminal(record: ConsoleRecord): vscode.Terminal {
  record.rTerminal.reattachToNewTerminal();
  return attachTerminal(record, true);
}

async function handleRunningConsoleClose(record: ConsoleRecord): Promise<void> {
  if (!record.rTerminal.isRunning()) {
    disposeConsoleRecord(record);
    return;
  }

  const reattachedTerminal = reattachRunningTerminal(record);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const result = await vscode.window.showWarningMessage(
    "Are you sure you want to close the R console?",
    { modal: true },
    "Close"
  );

  if (result === "Close") {
    disposeConsoleRecord(record);
    record.rTerminal.forceClose();
    terminalToRecord.delete(reattachedTerminal);
    reattachedTerminal.dispose();
  }
}

function attachTerminal(
  record: ConsoleRecord,
  preserveFocusOverride?: boolean
): vscode.Terminal {
  const terminalOptions: vscode.ExtensionTerminalOptions = {
    name: VSCODE_R_TERMINAL_NAME,
    pty: record.rTerminal,
    iconPath: new vscode.ThemeIcon("terminal")
  };

  if (record.location.kind === "editor") {
    terminalOptions.location = { viewColumn: record.location.viewColumn };
  }

  const terminal = vscode.window.createTerminal(terminalOptions);
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

  const pid = parseConsolePidFromTerminal(terminal);
  if (typeof pid !== "number") {
    return undefined;
  }

  const record = pidToRecord.get(pid);
  if (record) {
    terminalToRecord.set(terminal, record);
  }
  return record;
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

function syncTerminalRecordForPid(pid: number): void {
  const record = pidToRecord.get(pid);
  if (!record) {
    return;
  }

  for (const terminal of vscode.window.terminals) {
    if (terminalToRecord.has(terminal)) {
      continue;
    }
    if (parseConsolePidFromTerminal(terminal) !== pid) {
      continue;
    }
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
  const match = label.match(/^R Console \((\d+)\)$/);
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
  for (const record of new Set(rTerminalToRecord.values())) {
    record.pidSubscription.dispose();
    record.rTerminal.forceClose();
  }
  terminalToRecord.clear();
  rTerminalToRecord.clear();
  pidToRecord.clear();
}
