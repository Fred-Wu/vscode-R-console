import * as vscode from "vscode";
import { createGuardedBindingResolver } from "./bindings";
import { requestStaticCompletion } from "./staticProvider";
import { adaptNativeCompletionResult } from "./nativeMetadata";
import type { CompletionAnalysisMode, CompletionCandidate, CompletionContext, CompletionEntry, CompletionProvider, StaticCompletionAccess, StaticCompletionOutcome } from "./types";
import { allowsSymbolCompletions } from "./policy";
import { completionMatch } from "../completionMatch";
import { staticCompletionUnavailableReason, type StaticCompletionUnavailableReason, type CompletionSuppressionReason } from "./diagnostics";
import { isCallableName } from "./contextParser";
import { getFieldInsertText, isCallableCompletionKind } from "./candidates";
import { backtickRName, escapeRControls, quoteRNameIfNeeded } from "./rText";

export async function getLanguageServerCompletions(
  context: CompletionContext,
  doc: vscode.TextDocument,
  position: vscode.Position,
  multilineBuffer: string[],
  completionProvider?: CompletionProvider,
  runtimeBracketKind?: "data.frame" | "data.table" | null,
  analysisMode?: CompletionAnalysisMode,
  staticAccess?: StaticCompletionAccess
): Promise<{ entries: CompletionEntry[]; isIncomplete: boolean; staticStatus?: StaticCompletionOutcome["status"]; rConsoleLocalFunction?: boolean; runtimeOnly?: boolean; memberResolved?: boolean; staticUnavailableReason?: StaticCompletionUnavailableReason; bindingSuppressionReason?: CompletionSuppressionReason; workspaceFunction?: boolean; nativeArguments?: boolean; argumentsExhausted?: boolean; argumentsResolved?: boolean; argumentSuppressionReason?: CompletionSuppressionReason }> {
  if (!completionProvider) {
    return { entries: [], isIncomplete: false, staticUnavailableReason: "provider-unavailable" };
  }
  try {
    const requestScope = {};
    const input = doc.getText();
    const inputLines = input.split("\n");
    const lineOffsets: number[] = [];
    let offset = 0;
    for (const line of inputLines) {
      lineOffsets.push(offset);
      offset += line.length + 1;
    }
    const access = staticAccess ?? { bindings: createGuardedBindingResolver() };
    const query = (queryPosition: vscode.Position) => analysisMode === "static"
      ? requestStaticCompletion(completionProvider, {
          ...access, document: doc, input,
          cursor: lineOffsets[position.line] + position.character,
          position: queryPosition, contextPosition: position,
          triggerCharacter: context.triggerCharacter, requestScope,
        })
      : Promise.resolve(completionProvider.provideCompletionItems?.(doc, queryPosition, context.triggerCharacter,
          position, runtimeBracketKind, analysisMode, requestScope)).then(result => result && adaptNativeCompletionResult(result, context));
    let result = await query(position);
    let runtimeOnly = result?.rConsoleRuntimeOnly === true;
    let localFunction = result?.rConsoleLocalFunction === true;
    let workspaceFunction = result?.rConsoleWorkspaceFunction === true;
    let memberResolved = result?.rConsoleMemberResolved === true;
    let staticReason = staticCompletionUnavailableReason(result?.rConsoleStaticUnavailableReason);
    let nativeArguments = result?.rConsoleNativeArguments === true;
    let argumentsExhausted = result?.rConsoleArgumentsExhausted === true;
    let argumentsResolved = result?.rConsoleArgumentsResolved;
    let argumentSuppressionReason = result?.rConsoleArgumentSuppressionReason;

    let items = Array.isArray(result) ? result : result?.items || [];
    const usable = (item: CompletionCandidate): boolean =>
      !(workspaceFunction && !context.argumentValue && item.role === "value") &&
      isLanguageServerCompletionItem(context, item, doc.uri?.toString()) &&
      (context.kind !== "static" || (result?.rConsoleStaticStatus === "resolved" && validStaticEdit(item, inputLines, position))) &&
      (analysisMode !== "static" || !item.range || validStaticEdit(item, inputLines, position, false));
    // Some R language servers only return contiguous matches. If that lookup
    // has no usable candidates, request at the first prefix character and
    // apply our matcher to the returned candidates. Keep the real document and
    // its replacement start intact; never rewrite code to manufacture results.
    // Independent expression symbols can broaden even when parameters are
    // unavailable. The native adapter retains the parameter barrier on retries.
    const structuralFailure = (context.kind === "member" || context.kind === "bracket") &&
      staticReason !== undefined && [
      "receiver-unresolved", "unresolved-dispatch", "unsupported-context",
      "analysis-limit", "inference-cycle", "no-receiver-members",
    ].includes(staticReason);
    const expressionSymbols = analysisMode === "static" && context.kind === "argument" && allowsSymbolCompletions(context);
    if (result?.rConsoleStaticStatus !== "resolved-empty" && result?.rConsoleStaticStatus !== "unresolved" &&
        result?.rConsoleStaticStatus !== "pending" && !structuralFailure && context.prefix.length > 1 &&
        (argumentsResolved !== false || expressionSymbols) && !memberResolved &&
        !argumentsExhausted && !restrictsBracketSymbols(context) &&
        !items.some(item => usable(item) &&
          completionMatch(getCompletionLabel(item), context.prefix))) {
      const firstCharacter = [...context.prefix][0];
      result = await query(new vscode.Position(position.line, context.replaceStart + firstCharacter.length));
      runtimeOnly ||= result?.rConsoleRuntimeOnly === true;
      localFunction ||= result?.rConsoleLocalFunction === true;
      workspaceFunction ||= result?.rConsoleWorkspaceFunction === true;
      memberResolved ||= result?.rConsoleMemberResolved === true;
      staticReason = staticCompletionUnavailableReason(result?.rConsoleStaticUnavailableReason);
      nativeArguments ||= result?.rConsoleNativeArguments === true;
      argumentsExhausted ||= result?.rConsoleArgumentsExhausted === true;
      argumentsResolved = result?.rConsoleArgumentsResolved ?? argumentsResolved;
      argumentSuppressionReason = result?.rConsoleArgumentSuppressionReason;
      items = Array.isArray(result) ? result : result?.items || [];
    }

    const filteredItems = items.filter((item) =>
      usable(item)
    );

    return {
      entries: filteredItems.map((item) => ({
        label: getCompletionLabel(item),
        insertText: getCompletionInsertText(item, context),
        kind: item.kind,
        detail: item.detail,
        role: item.role,
        ...(item.bracketSpecial ? { bracketSpecial: true } : {}),
        source: "lsp",
        replaceStart: getCompletionReplaceStart(item, context, multilineBuffer),
        ...getCompletionReplaceEnd(item, lineOffsets, position),
        packageName: getCompletionPackage(item),
      })),
      isIncomplete: result?.rConsoleStaticStatus === "pending" || (!Array.isArray(result) && result?.isIncomplete === true),
      staticStatus: result?.rConsoleStaticStatus,
      rConsoleLocalFunction: localFunction,
      runtimeOnly,
      memberResolved: memberResolved || result?.rConsoleStaticStatus === "resolved-empty",
      staticUnavailableReason: result == null ? "no-response" : staticReason,
      bindingSuppressionReason: result?.rConsoleBindingSuppressionReason,
      workspaceFunction,
      nativeArguments,
      argumentsExhausted,
      argumentsResolved,
      argumentSuppressionReason,
    };
  } catch {
    return { entries: [], isIncomplete: false, staticUnavailableReason: "request-failed" };
  }
}

function getCompletionPackage(item: CompletionCandidate): string | undefined {
  if (!isCallableCompletionKind(item.kind)) {
    return undefined;
  }
  return item.packageName && /^[A-Za-z][A-Za-z0-9.]*$/.test(item.packageName) ? item.packageName : undefined;
}

function restrictsBracketSymbols(context: CompletionContext): boolean {
  return context.kind === "bracket" &&
    (context.bracketOperator === "[[" || !!context.bracketQuote || !context.prefix);
}

function isLanguageServerCompletionItem(
  context: CompletionContext,
  item: CompletionCandidate,
  documentUri?: string
): boolean {
  const role = item.role;
  const subscriptParameter = context.kind === "bracket" && item.subscriptParameter === true;
  if (context.suppressAutomatic) return false;
  if (item.kind === vscode.CompletionItemKind.Text) {
    return false;
  }

  if (item.workspaceOrigin) {
    // Only definitions from this console's virtual document are authoritative.
    // Other workspace/editor symbols must not leak into the console session.
    if (!(isCallableCompletionKind(item.kind) && documentUri !== undefined &&
      item.workspaceOrigin.definitionUri === documentUri && item.workspaceOrigin.contextUri === documentUri)) return false;
  }

  // Generic static contexts use the provider's explicit resolution and edits.
  if (context.kind === "static") return true;
  if (context.kind !== "member" && context.kind !== "package" && !allowsSymbolCompletions(context) &&
      role !== "argument" && role !== "value" && role !== "member" &&
      !(role === "scope" && item.kind === vscode.CompletionItemKind.Field)) return false;
  if (role === "argument" && !context.argumentTags && !subscriptParameter) return false;
  if (role === "value" && !context.argumentTags && !context.argumentValue) return false;
  // Native call detection can still see an outer call while our cursor is in
  // its subscript or member expression. Its arguments do not belong there.
  if ((role === "argument" || role === "value") &&
      context.kind !== "argument" && !subscriptParameter) return false;
  if (context.pipe && !isCallableCompletionKind(item.kind)) return false;
  if (context.argumentValue?.quote && role !== "value") return false;
  if (context.kind === "member" && role !== "member") return false;
  // Double-bracket indices and empty/quoted subscript slots used to exclude
  // generic LSP symbols. Preserve that boundary while allowing native fields
  // and literal index values inferred from this receiver.
  if (restrictsBracketSymbols(context) &&
      !subscriptParameter && role !== "member" &&
      !(role === "scope" && item.kind === vscode.CompletionItemKind.Field)) return false;

  if (
    (context.kind === "argument" || context.kind === "package") &&
    item.kind === vscode.CompletionItemKind.Snippet
  ) {
    return false;
  }

  return true;
}

function getCompletionLabel(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

/** Expand numeric LSP tab stops while preserving escaped R names and literals. */
function stripSnippetSyntax(text: string): string {
  let offset = 0;
  const expand = (nested = false): string => {
    let result = "";
    while (offset < text.length) {
      const char = text[offset++];
      if (char === "\\" && /[$}\\,|]/.test(text[offset] ?? "")) {
        result += text[offset++];
      } else if (char === "}" && nested) {
        break;
      } else if (char === "$" && /[0-9]/.test(text[offset] ?? "")) {
        while (/[0-9]/.test(text[offset] ?? "")) offset++;
      } else if (char === "$" && text[offset] === "{" && /[0-9]/.test(text[offset + 1] ?? "")) {
        offset++;
        while (/[0-9]/.test(text[offset] ?? "")) offset++;
        const delimiter = text[offset++];
        if (delimiter === ":") result += expand(true);
        else if (delimiter === "|") {
          let first = true;
          while (offset < text.length && !(text[offset] === "|" && text[offset + 1] === "}")) {
            const choice = text[offset++];
            if (choice === "\\" && offset < text.length) {
              const escaped = text[offset++];
              if (first) result += escaped;
            } else if (choice === ",") first = false;
            else if (first) result += choice;
          }
          offset += 2;
        }
      } else result += char;
    }
    return result;
  };
  return expand();
}

function getCompletionInsertText(item: CompletionCandidate, context: CompletionContext): string {
  if (context.kind === "static" || item.role === "value") {
    if (typeof item.insertText === "object") return stripSnippetSyntax(item.insertText.value);
    if (typeof item.insertText === "string") {
      return (item as vscode.CompletionItem & { insertTextFormat?: number }).insertTextFormat === 2
        ? stripSnippetSyntax(item.insertText) : item.insertText;
    }
    return getCompletionLabel(item);
  }
  if (item.role === "argument" && getCompletionLabel(item) === "...") return "...";
  let text: string;

  if (typeof item.insertText === "string") {
    text = item.insertText;
  } else if ((typeof item.insertText === "object" && "value" in item.insertText)) {
    text = item.insertText.value;
  } else {
    text = getCompletionLabel(item);
  }

  // The R server builds callable snippets from literal symbol names. Protect
  // those names before expanding tab stops (foo$1 is an R name, not $1).
  const label = getCompletionLabel(item);
  if (isCallableCompletionKind(item.kind) &&
      (text === label || text === `${label}()` || text === `${label}($0)`)) {
    const name = label.startsWith("`") && isCallableName(label) ? escapeRControls(label) : quoteRNameIfNeeded(label);
    return name + (text !== label || context.kind === "package" ? "()" : "");
  }
  const protocolFormat = (item as vscode.CompletionItem & { insertTextFormat?: number }).insertTextFormat;
  const result = (typeof item.insertText === "object" && "value" in item.insertText) || protocolFormat === 2
    ? stripSnippetSyntax(text) : text;
  const role = item.role;
  // Inferred members may supply only a display label. A raw label is not
  // necessarily valid R code: quote $/@ names and escape quoted [[ keys.
  // Preserve explicitly formatted LSP insertion text.
  if (role === "member" && result === label) {
    return getFieldInsertText(label, context);
  }
  if (role === "member" || item.kind === vscode.CompletionItemKind.Field) {
    if (result === label && escapeRControls(label) !== label) {
      return getFieldInsertText(label, context, role === "scope");
    }
    // Some R locales encode even printable characters as Unicode escapes.
    // Build backticked member names from the label so R can parse them.
    if (!context.bracketQuote && result !== label && result.startsWith("`")) {
      if (result.endsWith("`")) return backtickRName(label);
      if (isCallableCompletionKind(item.kind) && result.endsWith("`()")) return backtickRName(label) + "()";
    }
    return escapeRControls(result);
  }
  if (context.kind === "package" && isCallableCompletionKind(item.kind) &&
      isCallableName(result)) return result + "()";
  return result;
}

function getCompletionReplaceStart(
  item: vscode.CompletionItem,
  context: CompletionContext,
  multilineBuffer: string[]
): number {
  const range = item.range;
  if (range) {
    const start = "start" in range ? range.start : range.replacing.start;
    if (start.line === multilineBuffer.length) {
      return start.character;
    }
  }
  return context.replaceStart;
}

function getCompletionReplaceEnd(
  item: vscode.CompletionItem, lineOffsets: number[], position: vscode.Position
): { replaceEnd?: number } {
  if (!item.range) return {};
  const end = "end" in item.range ? item.range.end : item.range.replacing.end;
  if (end.line === position.line) return { replaceEnd: end.character };
  if (end.line < position.line || end.line >= lineOffsets.length) return {};
  return { replaceEnd: lineOffsets[end.line] - lineOffsets[position.line] + end.character };
}

/** The terminal can apply only edits beginning on the cursor's line. */
function validStaticEdit(item: vscode.CompletionItem, lines: string[], position: vscode.Position, requireText = true): boolean {
  if (!item.range || (requireText && typeof item.insertText !== "string" &&
      !(typeof item.insertText === "object" && typeof item.insertText?.value === "string"))) return false;
  const range = "start" in item.range ? item.range : item.range.replacing;
  if (!range?.start || !range?.end) return false;
  const { start, end } = range;
  return Number.isInteger(start.line) && Number.isInteger(start.character) &&
    Number.isInteger(end.line) && Number.isInteger(end.character) &&
    start.line === position.line && start.character >= 0 && start.character <= position.character &&
    end.line >= start.line && end.line < lines.length && end.character >= 0 &&
    end.character <= lines[end.line].length &&
    (end.line > position.line || end.character >= position.character);
}
