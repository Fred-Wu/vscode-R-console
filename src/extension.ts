import * as vscode from "vscode";
import {
  RTerminal,
  resolveRTerminalOptions,
} from "./Terminal/rTerminal";
import {
  discoverRBinaryPath,
  getPlatformRPathConfigEntry,
} from "./Terminal/options";

const terminalToRTerminal: Map<vscode.Terminal, RTerminal> = new Map();
const rTerminalToContext: Map<RTerminal, { inSideEditor: boolean }> = new Map();
const VSCODE_R_TERMINAL_NAME = "R Console";

function isVirtualWorkspace(): boolean {
  const folders = vscode.workspace.workspaceFolders;
  return Boolean(folders && folders.length > 0 && folders.every((folder) => folder.uri.scheme !== "file"));
}

function refreshTerminalAppearance(): void {
  for (const rTerminal of terminalToRTerminal.values()) {
    rTerminal.refreshAppearance();
  }
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("r-console.createTerminal", () => {
      createRTerminal(context);
    }),
    vscode.commands.registerCommand("r-console.createTerminalSide", () => {
      createRTerminal(context, true);
    }),
    vscode.window.onDidCloseTerminal(handleTerminalClose),
    vscode.window.onDidChangeActiveColorTheme(() => {
      refreshTerminalAppearance();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("r.console")) {
        refreshTerminalAppearance();
      }
    })
  );

  void ensureConfiguredRPath();
}

async function handleTerminalClose(closedTerminal: vscode.Terminal): Promise<void> {
  const rTerminal = terminalToRTerminal.get(closedTerminal);
  if (!rTerminal) return;

  terminalToRTerminal.delete(closedTerminal);

  if (!rTerminal.isRunning()) {
    rTerminalToContext.delete(rTerminal);
    return;
  }

  const result = await vscode.window.showWarningMessage(
    "Are you sure you want to close the R console?",
    { modal: true },
    "Close"
  );

  if (result === "Close") {
    rTerminalToContext.delete(rTerminal);
    rTerminal.forceClose();
    return;
  }

  const ctx = rTerminalToContext.get(rTerminal);
  if (ctx && rTerminal.isRunning()) {
    reattachRunningTerminal(rTerminal, ctx.inSideEditor);
  } else {
    rTerminalToContext.delete(rTerminal);
    rTerminal.forceClose();
  }
}

function createRTerminal(context: vscode.ExtensionContext, inSideEditor: boolean = false): void {
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

  const options = resolveRTerminalOptions();
  if (!options) {
    return;
  }

  const rTerminal = new RTerminal(options, context.extensionPath);
  rTerminalToContext.set(rTerminal, { inSideEditor });
  
  attachTerminal(rTerminal, inSideEditor);
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

function reattachRunningTerminal(rTerminal: RTerminal, inSideEditor: boolean): void {
  rTerminal.reattachToNewTerminal();
  attachTerminal(rTerminal, inSideEditor, true);
}

function attachTerminal(
  rTerminal: RTerminal,
  inSideEditor: boolean,
  isReattach: boolean = false
): void {
  const terminalOptions: vscode.ExtensionTerminalOptions = {
    name: VSCODE_R_TERMINAL_NAME,
    pty: rTerminal,
    iconPath: new vscode.ThemeIcon("terminal")
  };

  if (inSideEditor) {
    const viewColumn = isReattach ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
    (terminalOptions as any).location = { viewColumn };
  }

  const terminal = vscode.window.createTerminal(terminalOptions);
  terminalToRTerminal.set(terminal, rTerminal);

  const alwaysUseActive = vscode.workspace.getConfiguration("r").get<boolean>("alwaysUseActiveTerminal");
  terminal.show(alwaysUseActive === false);
}

export function deactivate() {
  for (const rTerminal of terminalToRTerminal.values()) {
    rTerminal.forceClose();
  }
  terminalToRTerminal.clear();
  rTerminalToContext.clear();
}
