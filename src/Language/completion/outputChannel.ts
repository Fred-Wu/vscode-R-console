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
let lastContext: string | undefined;
let currentContext: string | undefined;
// A new completion target starts a new decision. Keep a growing member prefix
// in one context so it does not emit the same refusal on every keystroke.
export function noteConsoleCompletionContext(context: string): void {
  if (context === currentContext) return;
  currentContext = context;
  lastContext = undefined;
}

export function logConsoleCompletionDecision(decision: CompletionDecision, context?: string): void {
  if (context !== undefined) noteConsoleCompletionContext(context);
  const message = formatCompletionDecision(decision);
  const now = Date.now();
  const identity = context === undefined ? undefined : message + "\u0000" + context;
  if (identity !== undefined && identity === lastContext) return;
  if (identity === undefined && now - (lastDecision.get(message) ?? -Infinity) < 1500) return;
  lastContext = identity;
  lastDecision.set(message, now);
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = new Date();
  const timestamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  lifecycleOutputChannel.appendLine(`[${timestamp}] ${message}`);
}
