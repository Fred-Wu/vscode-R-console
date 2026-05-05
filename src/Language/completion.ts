import * as vscode from "vscode";

type CompletionContext = {
  kind: "member" | "package" | "bracket" | "argument" | "default";
  prefix: string;
  replaceStart: number;
  triggerCharacter?: string;
  objectName?: string;
  operator?: "$" | "@";
  functionName?: string;
  dataObjectName?: string;
  snapshotInput: string;
  snapshotCursor: number;
};

type CompletionEntry = {
  label: string;
  insertText: string;
  kind?: vscode.CompletionItemKind;
  detail?: string;
  source: "lsp" | "session" | "buffer";
  replaceStart?: number;
};

export type CompletionPickItem = vscode.QuickPickItem & {
  insertText: string;
  replaceStart: number;
  snapshotInput: string;
  snapshotCursor: number;
  source: "lsp" | "session" | "buffer";
};

export interface CompletionProvider {
  provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string
  ): Promise<vscode.CompletionList | vscode.CompletionItem[] | undefined>;
  provideSignatureHelp(
    doc: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string
  ): Promise<vscode.SignatureHelp | undefined>;
  provideVscodeRCompletionItems?(
    doc: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string
  ): Promise<vscode.CompletionList | vscode.CompletionItem[] | undefined>;
}

const MEMBER_CHAIN_SEGMENT = "(?:`[^`]+`|[a-zA-Z._][a-zA-Z0-9._]*)";
const CONSOLE_IDENTIFIER_PATTERN = /\b[a-zA-Z.][a-zA-Z0-9._]*\b/g;
const R_RESERVED_WORDS = new Set([
  "if",
  "else",
  "repeat",
  "while",
  "function",
  "for",
  "in",
  "next",
  "break",
  "TRUE",
  "FALSE",
  "NULL",
  "Inf",
  "NaN",
  "NA",
  "NA_integer_",
  "NA_real_",
  "NA_complex_",
  "NA_character_",
]);
const MEMBER_CHAIN_TAIL_PATTERN = new RegExp(
  `(${MEMBER_CHAIN_SEGMENT}(?:\\s*[$@]\\s*${MEMBER_CHAIN_SEGMENT})*)\\s*$`
);

function detectDataContext(beforeCursor: string): string | undefined {
  const pipePattern = /([a-zA-Z._][a-zA-Z0-9._]*)\s*(%>%|\|>)/g;
  let pipeMatch;
  let firstPipeObject: string | undefined;
  while ((pipeMatch = pipePattern.exec(beforeCursor)) !== null) {
    if (!firstPipeObject) {
      firstPipeObject = pipeMatch[1];
    }
  }
  if (firstPipeObject) {
    const lastPipeIndex = Math.max(
      beforeCursor.lastIndexOf("%>%"),
      beforeCursor.lastIndexOf("|>")
    );
    if (lastPipeIndex !== -1) {
      const afterPipe = beforeCursor.slice(lastPipeIndex);
      if (/(%>%|\|>)\s*([a-zA-Z._][a-zA-Z0-9._]*::)?[a-zA-Z._][a-zA-Z0-9._]*\s*\([^)]*$/.test(afterPipe)) {
        return firstPipeObject;
      }
      if (/(\|>)\s*_\s*\[{1,2}[^\]]*$/.test(afterPipe)) {
        return firstPipeObject;
      }
    }
  }

  const bracketPattern = /([a-zA-Z._][a-zA-Z0-9._]*)\s*\[[^\]]*$/;
  const bracketMatch = bracketPattern.exec(beforeCursor);
  if (bracketMatch) {
    const objectName = bracketMatch[1];
    if (objectName === '_' && firstPipeObject) {
      return firstPipeObject;
    }
    return objectName;
  }

  const nseFunctions = ['with', 'subset', 'transform', 'within', 'mutate', 'filter', 'select', 'summarize', 'summarise', 'arrange', 'group_by'];
  for (const fn of nseFunctions) {
    const nsePattern = new RegExp(`\\b${fn}\\s*\\(\\s*([a-zA-Z._][a-zA-Z0-9._]*)\\s*,`, 'g');
    let nseMatch;
    let lastDataObj: string | undefined;
    while ((nseMatch = nsePattern.exec(beforeCursor)) !== null) {
      const afterMatch = beforeCursor.slice(nseMatch.index);
      const openParens = (afterMatch.match(/\(/g) || []).length;
      const closeParens = (afterMatch.match(/\)/g) || []).length;
      if (openParens > closeParens) {
        lastDataObj = nseMatch[1];
      }
    }
    if (lastDataObj) {
      return lastDataObj;
    }
  }

  return undefined;
}

export function getCompletionContext(
  inputBuffer: string,
  cursorPosition: number,
  fullTextBeforeCursor?: string
): CompletionContext | undefined {
  const snapshotInput = inputBuffer;
  const snapshotCursor = cursorPosition;
  const beforeCursor = snapshotInput.slice(0, snapshotCursor);

  const textForDataContext = fullTextBeforeCursor ?? beforeCursor;
  const dataObjectName = detectDataContext(textForDataContext);

  const bracketMatch = /([a-zA-Z._][a-zA-Z0-9._]*)\[\[?\s*(["']?)([a-zA-Z0-9._]*)$/.exec(
    beforeCursor
  );
  if (bracketMatch) {
    const prefix = bracketMatch[3] || "";
    const bracketObject = bracketMatch[1];
    const effectiveDataObject = (bracketObject === '_' && dataObjectName) 
      ? dataObjectName 
      : bracketObject;
    return {
      kind: "bracket",
      prefix,
      replaceStart: beforeCursor.length - prefix.length,
      triggerCharacter: bracketMatch[2] ? undefined : "[",
      objectName: bracketObject,
      dataObjectName: effectiveDataObject,
      operator: undefined,
      snapshotInput,
      snapshotCursor,
    };
  }

  const memberMatch = /([$@])([a-zA-Z0-9._]*)$/.exec(beforeCursor);
  if (memberMatch) {
    const operator = memberMatch[1] as "$" | "@";
    const prefix = memberMatch[2] || "";
    const objectExprRaw = beforeCursor.slice(0, beforeCursor.length - prefix.length - 1);
    const chainMatch = MEMBER_CHAIN_TAIL_PATTERN.exec(objectExprRaw);
    const objectExpr = chainMatch?.[1];
    if (objectExpr) {
      return {
        kind: "member",
        prefix,
        replaceStart: beforeCursor.length - prefix.length,
        triggerCharacter: prefix.length === 0 ? operator : undefined,
        objectName: objectExpr,
        operator,
        snapshotInput,
        snapshotCursor,
      };
    }
  }

  const packageMatch = /([a-zA-Z0-9._]+):::{0,1}([a-zA-Z0-9._]*)$/.exec(
    beforeCursor
  );
  if (packageMatch) {
    const prefix = packageMatch[2] || "";
    return {
      kind: "package",
      prefix,
      replaceStart: beforeCursor.length - prefix.length,
      triggerCharacter: ":",
      snapshotInput,
      snapshotCursor,
    };
  }

  const callMatch = /([a-zA-Z._][a-zA-Z0-9._]*)\([^()]*$/.exec(beforeCursor);
  if (callMatch) {
    const argsPart = beforeCursor.slice(beforeCursor.lastIndexOf("(") + 1);
    const argPrefixMatch = /([a-zA-Z0-9._]*)$/.exec(argsPart);
    const prefix = argPrefixMatch ? argPrefixMatch[1] : "";
    return {
      kind: "argument",
      prefix,
      replaceStart: beforeCursor.length - prefix.length,
      functionName: callMatch[1],
      dataObjectName,
      snapshotInput,
      snapshotCursor,
    };
  }

  const wordMatch = /([a-zA-Z._][a-zA-Z0-9._]*)$/.exec(beforeCursor);
  
  if (!wordMatch) {
    if (dataObjectName) {
      return {
        kind: "default",
        prefix: "",
        replaceStart: beforeCursor.length,
        dataObjectName,
        snapshotInput,
        snapshotCursor,
      };
    }
    return undefined;
  }

  const prefix = wordMatch[1] || "";
  return {
    kind: "default",
    prefix,
    replaceStart: beforeCursor.length - prefix.length,
    dataObjectName,
    snapshotInput,
    snapshotCursor,
  };
}

export async function collectCompletionEntries(
  context: CompletionContext,
  doc: vscode.TextDocument,
  position: vscode.Position,
  multilineBuffer: string[],
  recentConsoleEntries: string[] = [],
  completionProvider?: CompletionProvider
): Promise<CompletionEntry[]> {
  const vscodeSessionItems = await getVscodeRSessionCompletions(
    context,
    doc,
    position,
    multilineBuffer,
    completionProvider
  );
  const lspItems =
    context.kind === "bracket"
      ? []
      : await getLanguageServerCompletions(context, doc, position, multilineBuffer, completionProvider);
  const bufferItems = getConsoleBufferCompletions(
    context,
    doc.getText(),
    recentConsoleEntries
  );
  const fallbackBufferItems = filterShadowedBufferEntries(bufferItems, [
    ...lspItems,
    ...vscodeSessionItems,
  ]);

  if (context.kind === "bracket") {
    const vscodeFiltered = filterCompletionEntries(vscodeSessionItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);
    if (vscodeFiltered.length > 0) {
      return dedupeCompletionEntries(vscodeFiltered);
    }
    return dedupeCompletionEntries(bufferFiltered);
  }

  if (context.kind === "argument") {
    const lspFiltered = filterCompletionEntries(lspItems, context.prefix);
    const vscodeFiltered = filterCompletionEntries(vscodeSessionItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);

    return dedupeCompletionEntries([
      ...lspFiltered,
      ...vscodeFiltered,
      ...bufferFiltered,
    ]);
  }

  if (context.kind === "member") {
    const vscodeFiltered = filterCompletionEntries(vscodeSessionItems, context.prefix);
    if (vscodeFiltered.length > 0) {
      return dedupeCompletionEntries(vscodeFiltered);
    }
    return [];
  }

  return dedupeCompletionEntries(filterCompletionEntries(
    [...lspItems, ...vscodeSessionItems, ...fallbackBufferItems],
    context.prefix
  ));
}

export function toCompletionPick(
  entry: CompletionEntry,
  context: CompletionContext
): CompletionPickItem {
  const icon = getCompletionIcon(entry.kind);
  const description = getCompletionDescription(entry);
  return {
    label: `${icon} ${entry.label}`,
    description,
    detail: entry.detail ? stripSnippetSyntax(entry.detail) : undefined,
    insertText: entry.insertText,
    replaceStart: entry.replaceStart ?? context.replaceStart,
    snapshotInput: context.snapshotInput,
    snapshotCursor: context.snapshotCursor,
    source: entry.source,
  };
}

function getConsoleBufferCompletions(
  context: CompletionContext,
  currentInputText: string,
  recentConsoleEntries: string[]
): CompletionEntry[] {
  if (
    context.prefix.length === 0 ||
    (context.kind !== "default" &&
      context.kind !== "argument" &&
      context.kind !== "bracket")
  ) {
    return [];
  }

  const result: CompletionEntry[] = [];
  const seen = new Set<string>();
  const sources = [currentInputText, ...[...recentConsoleEntries].reverse()];

  for (const sourceText of sources) {
    const matches = sourceText.match(CONSOLE_IDENTIFIER_PATTERN);
    if (!matches) {
      continue;
    }

    for (const label of matches) {
      if (
        label === context.prefix ||
        R_RESERVED_WORDS.has(label) ||
        seen.has(label)
      ) {
        continue;
      }

      seen.add(label);
      result.push({
        label,
        insertText: label,
        kind: vscode.CompletionItemKind.Text,
        source: "buffer",
      });

      if (result.length >= 200) {
        return result;
      }
    }
  }

  return result;
}

async function getVscodeRSessionCompletions(
  context: CompletionContext,
  doc: vscode.TextDocument,
  position: vscode.Position,
  multilineBuffer: string[],
  completionProvider?: CompletionProvider
): Promise<CompletionEntry[]> {
  if (!completionProvider?.provideVscodeRCompletionItems || context.kind === "package") {
    return [];
  }

  try {
    const result = await completionProvider.provideVscodeRCompletionItems(
      doc,
      position,
      context.triggerCharacter
    );
    const items = Array.isArray(result) ? result : result?.items || [];
    return items
      .filter((item) => {
        if (item.kind === vscode.CompletionItemKind.Text) {
          return false;
        }
        return true;
      })
      .map((item) => ({
        label: stripSnippetSyntax(getCompletionLabel(item)),
        insertText: getCompletionInsertText(item),
        kind: item.kind,
        detail: item.detail ?? "vscode-R session",
        source: "session" as const,
        replaceStart: getCompletionReplaceStart(item, context, multilineBuffer),
      }));
  } catch {
    return [];
  }
}

async function getLanguageServerCompletions(
  context: CompletionContext,
  doc: vscode.TextDocument,
  position: vscode.Position,
  multilineBuffer: string[],
  completionProvider?: CompletionProvider
): Promise<CompletionEntry[]> {
  if (!completionProvider) {
    return [];
  }
  try {
    const result = await completionProvider.provideCompletionItems(
      doc,
      position,
      context.triggerCharacter
    );

    const items = Array.isArray(result) ? result : result?.items || [];
    
    const filteredItems = items.filter((item) => {
      if (item.kind === vscode.CompletionItemKind.Text) {
        return false;
      }
      if (
        (context.kind === "argument" || context.kind === "package") &&
        item.kind === vscode.CompletionItemKind.Snippet
      ) {
        return false;
      }
      return true;
    });
    
    return filteredItems.map((item) => ({
      label: stripSnippetSyntax(getCompletionLabel(item)),
      insertText: getCompletionInsertText(item),
      kind: item.kind,
      detail: item.detail,
      source: "lsp",
      replaceStart: getCompletionReplaceStart(item, context, multilineBuffer),
    }));
  } catch {
    return [];
  }
}

function getCompletionLabel(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

function stripSnippetSyntax(text: string): string {
  let result = text;
  let prev: string;
  
  do {
    prev = result;
    result = result
      .replace(/\$\{\d+\|([^,|]+)[^}]*\}/g, "$1")
      .replace(/\$\{\d+:([^}]*)\}/g, "$1")
      .replace(/\$\{\d+\}/g, "")
      .replace(/\$\d+/g, "");
  } while (result !== prev);
  
  return result;
}

function getCompletionInsertText(item: vscode.CompletionItem): string {
  let text: string;

  if (typeof item.insertText === "string") {
    text = item.insertText;
  } else if (item.insertText instanceof vscode.SnippetString) {
    text = item.insertText.value; 
  } else {
    text = getCompletionLabel(item);
  }

  const result = stripSnippetSyntax(text);
  return result;
}

function getCompletionReplaceStart(
  item: vscode.CompletionItem,
  context: CompletionContext,
  multilineBuffer: string[]
): number {
  const range = item.range;
  if (range) {
    const start = range instanceof vscode.Range ? range.start : range.replacing.start;
    if (start.line === multilineBuffer.length) {
      return start.character;
    }
  }
  return context.replaceStart;
}

function filterCompletionEntries(
  entries: CompletionEntry[],
  prefix: string
): CompletionEntry[] {
  const normalizedPrefix = prefix.toLowerCase();
  const result: CompletionEntry[] = [];
  for (const entry of entries) {
    const label = entry.label;
    if (normalizedPrefix && !label.toLowerCase().startsWith(normalizedPrefix)) {
      continue;
    }
    result.push(entry);
  }
  return result;
}

function filterShadowedBufferEntries(
  bufferEntries: CompletionEntry[],
  preferredEntries: CompletionEntry[]
): CompletionEntry[] {
  if (bufferEntries.length === 0 || preferredEntries.length === 0) {
    return bufferEntries;
  }

  const preferredLabels = new Set(
    preferredEntries
      .filter((entry) => entry.source !== "buffer")
      .map((entry) => entry.label.toLowerCase())
  );

  return bufferEntries.filter(
    (entry) => !preferredLabels.has(entry.label.toLowerCase())
  );
}

function dedupeCompletionEntries(entries: CompletionEntry[]): CompletionEntry[] {
  const seen = new Set<string>();
  const result: CompletionEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.label}\u0000${entry.insertText}\u0000${entry.kind ?? -1}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function getCompletionDescription(entry: CompletionEntry): string {
  if (entry.source === "buffer") {
    return "";
  }
  const kindName = getCompletionKindName(entry.kind);
  return kindName || "";
}

function getCompletionKindName(kind?: vscode.CompletionItemKind): string {
  switch (kind) {
    case vscode.CompletionItemKind.Function:
      return "function";
    case vscode.CompletionItemKind.Method:
      return "method";
    case vscode.CompletionItemKind.Variable:
      return "variable";
    case vscode.CompletionItemKind.Field:
      return "field";
    case vscode.CompletionItemKind.Property:
      return "property";
    case vscode.CompletionItemKind.Module:
      return "module";
    case vscode.CompletionItemKind.Class:
      return "class";
    case vscode.CompletionItemKind.Interface:
      return "interface";
    case vscode.CompletionItemKind.Enum:
      return "enum";
    case vscode.CompletionItemKind.Constant:
      return "constant";
    case vscode.CompletionItemKind.Keyword:
      return "keyword";
    case vscode.CompletionItemKind.Operator:
      return "operator";
    case vscode.CompletionItemKind.Snippet:
      return "snippet";
    case vscode.CompletionItemKind.Value:
      return "value";
    case vscode.CompletionItemKind.Unit:
      return "unit";
    case vscode.CompletionItemKind.Text:
      return "text";
    default:
      return "";
  }
}

function getCompletionIcon(kind?: vscode.CompletionItemKind): string {
  switch (kind) {
    case vscode.CompletionItemKind.Function:
      return "$(symbol-function)";
    case vscode.CompletionItemKind.Method:
      return "$(symbol-method)";
    case vscode.CompletionItemKind.Variable:
      return "$(symbol-variable)";
    case vscode.CompletionItemKind.Field:
      return "$(symbol-field)";
    case vscode.CompletionItemKind.Property:
      return "$(symbol-property)";
    case vscode.CompletionItemKind.Module:
      return "$(symbol-module)";
    case vscode.CompletionItemKind.Class:
      return "$(symbol-class)";
    case vscode.CompletionItemKind.Interface:
      return "$(symbol-interface)";
    case vscode.CompletionItemKind.Enum:
      return "$(symbol-enum)";
    case vscode.CompletionItemKind.Constant:
      return "$(symbol-constant)";
    case vscode.CompletionItemKind.Keyword:
      return "$(symbol-keyword)";
    case vscode.CompletionItemKind.Operator:
      return "$(symbol-operator)";
    case vscode.CompletionItemKind.Snippet:
      return "$(symbol-snippet)";
    case vscode.CompletionItemKind.Text:
      return "$(symbol-text)";
    default:
      return "$(symbol-misc)";
  }
}
