import * as vscode from "vscode";
import { closeLegacySession } from "../Runtime/legacySession";
import { getPersistedRuntimePid, isProcessAlive, type LegacyConsoleRecord, type PersistentSessionRegistry } from "../Runtime/persistentSessionRegistry";

const NOTICE_KEY = "rConsole.legacySessionUpgradeNotice";
const CLOSE = "Close Old Session";
const MESSAGE = "The R Console connection protocol has changed. Sessions started with an older version cannot reconnect. Close the old session and start a new R Console.";

function label(entry: LegacyConsoleRecord): string {
  return entry.terminalName || `R Console (${getPersistedRuntimePid(entry.terminal) ?? "unknown PID"})`;
}

function processDescription(entry: LegacyConsoleRecord): string {
  const pid = getPersistedRuntimePid(entry.terminal);
  return pid ? `Recorded PID ${pid}: ${isProcessAlive(pid) ? "running" : "not running"}` : "No recorded PID";
}

export async function showLegacySessionNotice(state: vscode.Memento, registry: PersistentSessionRegistry): Promise<void> {
  const seen = state.get<string[]>(NOTICE_KEY, []);
  const unseen = registry.legacySessions.filter((entry) => {
    const pid = getPersistedRuntimePid(entry.terminal);
    return !seen.includes(entry.terminal.runtime.sessionId) && (!pid || isProcessAlive(pid));
  });
  if (!unseen.length) return;
  // Remember detection even when the user dismisses the notification.
  await state.update(NOTICE_KEY, [...new Set([...seen, ...unseen.map((entry) => entry.terminal.runtime.sessionId)])]);
  await manageLegacySessions(registry);
}

export async function manageLegacySessions(
  registry: PersistentSessionRegistry,
  entries: LegacyConsoleRecord[] = registry.legacySessions
): Promise<void> {
  if (!entries.length) return;
  const action = await vscode.window.showWarningMessage(MESSAGE, CLOSE, "Cancel");
  if (action !== CLOSE) return;
  const selected = entries.length === 1 ? entries : (await vscode.window.showQuickPick(
    entries.map((entry) => ({
      label: label(entry), description: processDescription(entry),
      detail: `Saved startup directory: ${entry.terminal.options.cwd || "not recorded"}`,
      picked: true,
      entry,
    })), { placeHolder: "Select the old R Console sessions to close", canPickMany: true, ignoreFocusOut: true }
  ))?.map((item) => item.entry);
  if (!selected?.length) return;

  for (const entry of selected) {
    try {
      await closeLegacySession(entry);
      if (!registry.forgetLegacySession(entry)) {
        throw new Error("The process has stopped, but its saved record could not be removed.");
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not close ${label(entry)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
