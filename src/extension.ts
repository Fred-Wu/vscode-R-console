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

  // Reattach the terminal immediately so it remains visible while the user
  // answers the confirmation dialog. Without this, the tab closes before the
  // dialog appears because VSCode gives no before-close hook for terminals.
  const ctx = rTerminalToContext.get(rTerminal);
  if (ctx) {
    reattachRunningTerminal(rTerminal, ctx.inSideEditor);
    // Yield one UI turn so VS Code can attach and reveal the replacement tab
    // before the modal warning steals focus.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const result = await vscode.window.showWarningMessage(
    "Are you sure you want to close the R console?",
    { modal: true },
    "Close"
  );

  if (result === "Close") {
    rTerminalToContext.delete(rTerminal);
    rTerminal.forceClose();
    // Dispose the reattached vscode.Terminal to remove the tab. This fires
    // onDidCloseTerminal again, but rTerminal is no longer in the map so the
    // handler returns immediately without recursing.
    if (ctx) {
      for (const [terminal, rt] of terminalToRTerminal) {
        if (rt === rTerminal) {
          terminalToRTerminal.delete(terminal);
          terminal.dispose();
          break;
        }
      }
    }
    return;
  }

  // User cancelled — terminal is already reattached and visible, nothing to do.
  // If ctx was missing we couldn't reattach, so fall back to force-close.
  if (!ctx) {
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
  attachTerminal(rTerminal, inSideEditor, true, true);
}

function attachTerminal(
  rTerminal: RTerminal,
  inSideEditor: boolean,
  isReattach: boolean = false,
  preserveFocusOverride?: boolean
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
  const preserveFocus =
    preserveFocusOverride ?? alwaysUseActive === false;
  terminal.show(preserveFocus);
}

export function deactivate() {
  for (const rTerminal of terminalToRTerminal.values()) {
    rTerminal.forceClose();
  }
  terminalToRTerminal.clear();
  rTerminalToContext.clear();
}
