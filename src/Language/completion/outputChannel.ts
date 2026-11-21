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
export function logConsoleCompletionDecision(decision: CompletionDecision, context?: string): void {
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
