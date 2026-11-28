import * as vscode from "vscode";
import { closeLegacySession } from "../Runtime/legacySession";
import { getPersistedRuntimePid, isProcessAlive, type LegacyConsoleRecord, type PersistentSessionRegistry } from "../Runtime/persistentSessionRegistry";

const NOTICE_KEY = "rConsole.legacySessionUpgradeNotice";
const CLOSE = "Close Old Session";
const MESSAGE = "The R Console connection protocol has changed. Sessions started with an older version cannot reconnect. Close the old session and start a new R Console.";

function label(entry: LegacyConsoleRecord): string {
  return `R Console (${getPersistedRuntimePid(entry.terminal) ?? "unknown PID"})`;
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
      picked: true,
      entry,
    })), { placeHolder: "Select the old R Console sessions to close", canPickMany: true, ignoreFocusOut: true }
  ))?.map((item) => item.entry);
  if (!selected?.length) return;

  for (const entry of selected) await closeSelectedLegacySession(registry, entry);
}

const closing = new Map<string, Promise<void>>();
const confirming = new Set<string>();

async function closeSelectedLegacySession(registry: PersistentSessionRegistry, entry: LegacyConsoleRecord): Promise<void> {
  const id = entry.terminal.runtime.sessionId;
  const pending = closing.get(id);
  if (pending) return pending;
  const operation = (async () => {
    try {
      await closeLegacySession(entry);
      if (!await registry.forgetLegacySession(entry)) {
        throw new Error("The process has stopped, but its saved shutdown credentials could not be removed.");
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not close ${label(entry)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  closing.set(id, operation);
  try { await operation; }
  finally { closing.delete(id); }
}

/** A surviving old console view can request shutdown, never reattachment. */
export async function closeLegacyConsoleView(registry: PersistentSessionRegistry, pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const matches = registry.legacySessions.filter(entry => getPersistedRuntimePid(entry.terminal) === pid);
  if (matches.length !== 1) return;
  const entry = matches[0];
  const id = entry.terminal.runtime.sessionId;
  if (closing.has(id) || confirming.has(id)) return;
  confirming.add(id);
  try {
    const action = await vscode.window.showWarningMessage(
      `Close old ${label(entry)} permanently? This session cannot be reattached under the current protocol.`,
      { modal: true }, CLOSE);
    if (action === CLOSE) await closeSelectedLegacySession(registry, entry);
  } finally { confirming.delete(id); }
}
