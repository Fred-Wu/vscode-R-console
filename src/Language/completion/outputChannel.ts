import * as vscode from "vscode";
import { formatCompletionDecision, type CompletionDecision } from "./diagnostics";

// Created lazily so headless terminal tests and ordinary console startup do
// not load the language-client runtime just to record a decision.
let outputChannel: vscode.OutputChannel | undefined;
function channel(): vscode.OutputChannel | undefined {
  if (!outputChannel && vscode.window?.createOutputChannel) {
    outputChannel = vscode.window.createOutputChannel("R Console Language Server");
  }
  return outputChannel;
}

export const lifecycleOutputChannel = {
  appendLine(message: string): void { channel()?.appendLine(message); },
  dispose(): void { outputChannel?.dispose(); outputChannel = undefined; },
};

const lastDecision = new Map<string, number>();
const scopedState = new Map<string, { context?: string; lastIdentity?: string }>();

export function clearCompletionDiagnosticsScope(scope: string): void {
  scopedState.delete(scope);
}

// A growing prefix belongs to one completion target in one console.
export function noteConsoleCompletionContext(context: string, scope = ""): void {
  const state = scopedState.get(scope);
  if (state?.context === context) return;
  scopedState.set(scope, { context });
}

export function logConsoleCompletionDecision(
  decision: CompletionDecision, context?: string, scope = ""
): void {
  if (context !== undefined) noteConsoleCompletionContext(context, scope);
  const message = formatCompletionDecision(decision);
  const now = Date.now();
  const identity = context === undefined ? undefined : message + "\u0000" + context;
  const state = scopedState.get(scope);
  if (identity !== undefined && identity === state?.lastIdentity) return;
  if (identity === undefined && now - (lastDecision.get(message) ?? -Infinity) < 1500) return;
  if (identity !== undefined) scopedState.set(scope, { ...state, lastIdentity: identity });
  lastDecision.set(message, now);
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = new Date();
  const timestamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  lifecycleOutputChannel.appendLine(`[${timestamp}] ${message}`);
}
