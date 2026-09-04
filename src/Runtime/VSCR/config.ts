import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { VscodeRIntegrationOptions } from "./types";

const VSCODE_R_EXTENSION_ID = "REditorSupport.r";
const LEGACY_WATCHER_DIR = path.join(os.homedir(), ".vscode-R");

function extensionContributesCommand(
  extension: vscode.Extension<unknown>,
  command: string
): boolean {
  const packageJson = extension.packageJSON as {
    contributes?: { commands?: Array<{ command?: unknown }> };
  };
  return packageJson.contributes?.commands?.some((entry) => entry.command === command) ?? false;
}

export function resolveVscodeRIntegrationOptions(
  enabled: boolean
): VscodeRIntegrationOptions {
  if (!enabled) {
    return { kind: "disabled" };
  }

  const extension = vscode.extensions.getExtension(VSCODE_R_EXTENSION_ID);
  if (!extension) {
    void vscode.window.showWarningMessage(
      "R Console could not find vscode-R; session integration will be disabled."
    );
    return { kind: "disabled" };
  }

  if (extensionContributesCommand(extension, "r.connectToSession")) {
    return { kind: "sess" };
  }

  const initPath = path.join(extension.extensionPath, "R", "session", "init.R");
  if (fs.existsSync(initPath)) {
    return {
      kind: "legacy",
      initPath,
      watcherDir: LEGACY_WATCHER_DIR,
    };
  }

  return { kind: "sess" };
}

export function sanitizeVscodeRIntegrationEnv(env: NodeJS.ProcessEnv): void {
  delete env.VSCODE_INIT_R;
  delete env.VSCODE_WATCHER_DIR;
  delete env.R_CONSOLE_SESSION_MODE;
  delete env.R_CONSOLE_SESSION_BOOTSTRAP;
  delete env.SESS_PIPE;
  delete env.SESS_PORT;
  delete env.SESS_TOKEN;
  delete env.SESS_HOST;
  delete env.SESS_RSTUDIOAPI;
  delete env.SESS_USE_HTTPGD;
  delete env.SESS_USE_JGD;
}
