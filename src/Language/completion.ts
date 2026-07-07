import * as vscode from "vscode";

export type CompletionContext = {
  kind: "member" | "package" | "bracket" | "argument" | "default";
  prefix: string;
  replaceStart: number;
  triggerCharacter?: string;
  objectName?: string;
  operator?: "$" | "@";
  bracketOperator?: "[" | "[[";
  bracketQuote?: "\"" | "'";
  chainedBracket?: boolean;
  functionName?: string;
  dataObjectName?: string;
  snapshotInput: string;
  snapshotCursor: number;
};

export type CompletionEntry = {
  label: string;
  insertText: string;
  kind?: vscode.CompletionItemKind;
  detail?: string;
  source: "lsp" | "session" | "buffer";
  replaceStart?: number;
};

const DEFAULT_COMPLETION_GROUP_ORDER = [
  "Runtime Variables",
  "Runtime Functions",
  "Packages",
  "Functions",
  "Fields",
  "Recent Input",
  "Other",
] as const;

const COMPLETION_GROUP_ORDER = {
  argument: ["Arguments", ...DEFAULT_COMPLETION_GROUP_ORDER],
  bracket: ["Fields", "Runtime Variables", "Runtime Functions", "Recent Input", "Other"],
  default: DEFAULT_COMPLETION_GROUP_ORDER,
  member: ["Fields", "Runtime Variables", "Runtime Functions", "Recent Input", "Other"],
  package: ["Package Members", "Functions", "Fields", "Recent Input", "Other"],
} as const satisfies Record<CompletionContext["kind"], readonly string[]>;

const DATA_CONTEXT_GROUP_ORDER = [
  "Fields",
  "Runtime Variables",
  "Runtime Functions",
  "Packages",
  "Functions",
  "Recent Input",
  "Other",
] as const;

export type CompletionPickItem = vscode.QuickPickItem & {
  insertText: string;
  replaceStart: number;
  snapshotInput: string;
  snapshotCursor: number;
  source: "lsp" | "session" | "buffer";
};

export type CompletionQuickPickItem = CompletionPickItem | vscode.QuickPickItem;

export interface CompletionProvider {
  provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string
  ): Promise<vscode.CompletionList | vscode.CompletionItem[] | undefined>;
  provideMemberCompletionItems?(
    expression: string,
    operator: "$" | "@"
  ): Promise<
    Array<{
      name: string;
      type?: string;
      str?: string;
    }> | undefined
  >;
}

type GlobalEnvItem = {
  class?: string[];
  type?: string;
  length?: number;
  str?: string;
  size?: number;
  dim?: number[];
  names?: string | string[];
  slots?: string | string[];
};

type WorkspaceData = {
  globalenv?: Record<string, GlobalEnvItem>;
};

const TOP_LEVEL_SYMBOL_PATTERN = /^[a-zA-Z._][a-zA-Z0-9._]*$/;
const R_SYNTACTIC_NAME_PATTERN = /^(?:[a-zA-Z]|\.(?![0-9]))[a-zA-Z0-9._]*$/;
const MEMBER_CHAIN_SEGMENT = "(?:`[^`]+`|[a-zA-Z._][a-zA-Z0-9._]*)";
const BRACKET_CHAIN_SEGMENT = "(?:\\[[^\\[\\]]*\\]|\\[\\[[^\\[\\]]*\\]\\])";
const MEMBER_OBJECT_SEGMENT = `(?:${MEMBER_CHAIN_SEGMENT}(?:${BRACKET_CHAIN_SEGMENT})*)`;
const BRACKET_OBJECT_PATTERN = new RegExp(
  `([a-zA-Z._][a-zA-Z0-9._]*(?:${BRACKET_CHAIN_SEGMENT})*)(\\[\\[?)\\s*(["']?)([a-zA-Z0-9._]*)$`
);
const CONSOLE_IDENTIFIER_PATTERN = /\b[a-zA-Z.][a-zA-Z0-9._]*\b/g;
const BACKTICKED_R_NAME_PATTERN = /`(?:\\.|[^`\\])*`/g;
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
  `(${MEMBER_OBJECT_SEGMENT}(?:\\s*[$@]\\s*${MEMBER_OBJECT_SEGMENT})*)\\s*$`
);

function isPipePlaceholder(name: string): boolean {
  return name === "_" || name === ".";
}

function quoteRNameIfNeeded(name: string): string {
  if (R_SYNTACTIC_NAME_PATTERN.test(name) && !R_RESERVED_WORDS.has(name)) {
    return name;
  }
  return `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
}

function getFieldInsertText(name: string, context: CompletionContext): string {
  if (context.kind !== "bracket") {
    return quoteRNameIfNeeded(name);
  }
  if (context.bracketQuote) {
    const quotePattern = context.bracketQuote === "\"" ? /"/g : /'/g;
    return name.replace(/\\/g, "\\\\").replace(quotePattern, `\\${context.bracketQuote}`);
  }
  if (context.bracketOperator === "[[") {
    return `"${name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  }
  return quoteRNameIfNeeded(name);
}

function detectDataContext(beforeCursor: string): string | undefined {
  const pipePattern = new RegExp(
    `([a-zA-Z._][a-zA-Z0-9._]*(?:${BRACKET_CHAIN_SEGMENT})*)\\s*(%>%|\\|>)`,
    "g"
  );
  let pipeMatch;
  let firstPipeObject: string | undefined;
  while ((pipeMatch = pipePattern.exec(beforeCursor)) !== null) {
    if (!firstPipeObject) {
      firstPipeObject = /^[a-zA-Z._][a-zA-Z0-9._]*/.exec(pipeMatch[1])?.[0];
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
      if (/(%>%)\s*\.\s*\[{1,2}[^\]]*$/.test(afterPipe)) {
        return firstPipeObject;
      }
      if (/(\|>)\s*_\s*\[{1,2}[^\]]*$/.test(afterPipe)) {
        return firstPipeObject;
      }
      if (/(\|>)\s*_\s*\[{1,2}[\s\S]*\]\$[a-zA-Z0-9._]*$/.test(afterPipe)) {
        return firstPipeObject;
      }
    }
  }

  const bracketPattern = /([a-zA-Z._][a-zA-Z0-9._]*)\s*\[[^\]]*$/;
  const bracketMatch = bracketPattern.exec(beforeCursor);
  if (bracketMatch) {
    const objectName = bracketMatch[1];
    if (isPipePlaceholder(objectName) && firstPipeObject) {
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

  const bracketMatch = BRACKET_OBJECT_PATTERN.exec(beforeCursor);
  if (bracketMatch) {
    const bracketOperator = bracketMatch[2] as "[" | "[[";
    const prefix = bracketMatch[4] || "";
    const bracketObject = bracketMatch[1];
    const baseObject = /^[a-zA-Z._][a-zA-Z0-9._]*/.exec(bracketObject)?.[0] ?? bracketObject;
    const isPlaceholderBracket = isPipePlaceholder(baseObject) && !!dataObjectName;
    const effectiveDataObject = isPlaceholderBracket ? dataObjectName : baseObject;
    return {
      kind: "bracket",
      prefix,
      replaceStart: beforeCursor.length - prefix.length,
      triggerCharacter: bracketMatch[3] ? undefined : "[",
      objectName: baseObject,
      bracketOperator,
      bracketQuote: bracketMatch[3] ? bracketMatch[3] as "\"" | "'" : undefined,
      chainedBracket: bracketObject !== baseObject || isPlaceholderBracket,
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
      const isBracketChainMember = operator === "$" && objectExpr.includes("[");
      const baseObject = isBracketChainMember
        ? /^[a-zA-Z._][a-zA-Z0-9._]*/.exec(objectExpr)?.[0]
        : undefined;
      const isPlaceholderMember = !!baseObject && isPipePlaceholder(baseObject) && !!dataObjectName;
      return {
        kind: "member",
        prefix,
        replaceStart: beforeCursor.length - prefix.length,
        triggerCharacter: prefix.length === 0 ? operator : undefined,
        objectName: isPlaceholderMember ? dataObjectName : baseObject ?? objectExpr,
        operator,
        chainedBracket: isBracketChainMember,
        dataObjectName: isPlaceholderMember ? dataObjectName : undefined,
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
  doc: vscode.TextDocument | undefined,
  position: vscode.Position | undefined,
  sessionData: WorkspaceData | undefined,
  multilineBuffer: string[],
  recentConsoleEntries: string[] = [],
  completionProvider?: CompletionProvider,
  consoleInputText?: string,
  filterAggregateProviderItems = false
): Promise<CompletionEntry[]> {
  const sessionItems = getSessionCompletions(context, sessionData);
  const runtimeMemberItems =
    context.kind === "member"
      ? await getRuntimeMemberCompletions(context, completionProvider)
      : [];
  const includeLspItems =
    needsLanguageServerCompletion(context) && !!doc && !!position;
  const rawLspItems =
    !includeLspItems
      ? []
      : await getLanguageServerCompletions(
          context,
          doc,
          position,
          multilineBuffer,
          completionProvider,
          filterAggregateProviderItems
        );
  const lspItems =
    isGlobalSymbolContext(context)
      ? filterShadowedWorkspaceEntries(
          rawLspItems,
          sessionItems,
          context,
          context.kind === "argument" ? isArgumentCompletionEntry : undefined
        )
      : rawLspItems;
  const bufferItems = getConsoleBufferCompletions(
    context,
    consoleInputText ?? doc?.getText() ?? "",
    recentConsoleEntries
  );
  const cachedColumnItems = getDataColumnCompletions(context, sessionData);
  const columnItems =
    cachedColumnItems.length > 0
      ? cachedColumnItems
      : await getRuntimeDataColumnCompletions(context, completionProvider);
  const fallbackBufferItems = filterShadowedBufferEntries(bufferItems, [
    ...lspItems,
    ...sessionItems,
    ...runtimeMemberItems,
    ...columnItems,
  ]);

  if (context.kind === "bracket") {
    const columnFiltered = filterCompletionEntries(columnItems, context.prefix);
    const lspFiltered = filterCompletionEntries(lspItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);
    const exactColumnMatch = columnFiltered.some(
      (entry) => entry.label.toLowerCase() === context.prefix.toLowerCase()
    );
    if (lspFiltered.length > 0 && !exactColumnMatch) {
      return dedupeCompletionEntries([...lspFiltered, ...columnFiltered, ...bufferFiltered], context);
    }
    if (context.chainedBracket && bufferFiltered.length > 0) {
      return dedupeCompletionEntries([...columnFiltered, ...bufferFiltered], context);
    }
    if (columnFiltered.length > 0) {
      return dedupeCompletionEntries(columnFiltered, context);
    }
    return dedupeCompletionEntries([
      ...filterCompletionEntries(sessionItems, context.prefix),
      ...bufferFiltered,
    ], context);
  }

  if (context.kind === "argument") {
    const lspFiltered = filterCompletionEntries(lspItems, context.prefix);
    const sessionFiltered = filterCompletionEntries(sessionItems, context.prefix);
    const columnFiltered = filterCompletionEntries(columnItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);

    if (context.dataObjectName && columnFiltered.length > 0) {
      return dedupeCompletionEntries(columnFiltered, context);
    }

    return dedupeCompletionEntries([
      ...lspFiltered,
      ...sessionFiltered,
      ...bufferFiltered,
    ], context);
  }

  if (context.kind === "member") {
    const runtimeFiltered = filterCompletionEntries(runtimeMemberItems, context.prefix);
    const sessionFiltered = filterCompletionEntries(sessionItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);
    if (context.chainedBracket && bufferFiltered.length > 0) {
      return dedupeCompletionEntries([...runtimeFiltered, ...sessionFiltered, ...bufferFiltered], context);
    }
    if (runtimeFiltered.length > 0) {
      return dedupeCompletionEntries(runtimeFiltered, context);
    }
    return dedupeCompletionEntries([...sessionFiltered, ...bufferFiltered], context);
  }

  const defaultColumnFiltered = filterCompletionEntries(columnItems, context.prefix);
  
  if (context.dataObjectName && defaultColumnFiltered.length > 0) {
    return dedupeCompletionEntries(defaultColumnFiltered, context);
  }

  return dedupeCompletionEntries(filterCompletionEntries(
    [...lspItems, ...sessionItems, ...fallbackBufferItems],
    context.prefix
  ), context);
}

export function needsLanguageServerCompletion(context: CompletionContext): boolean {
  if (context.kind === "member") {
    return false;
  }

  if (context.kind !== "bracket") {
    return true;
  }

  return (
    context.bracketOperator === "[" &&
    !context.bracketQuote &&
    context.prefix.length > 0
  );
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

export function toCompletionQuickPickItems(
  entries: CompletionEntry[],
  context: CompletionContext
): CompletionQuickPickItem[] {
  const grouped = new Map<string, CompletionEntry[]>();

  for (const entry of entries) {
    const group = getCompletionGroup(entry, context);
    const groupEntries = grouped.get(group) ?? [];
    groupEntries.push(entry);
    grouped.set(group, groupEntries);
  }

  const result: CompletionQuickPickItem[] = [];
  const preferredGroups =
    context.kind === "default" && context.dataObjectName
      ? DATA_CONTEXT_GROUP_ORDER
      : COMPLETION_GROUP_ORDER[context.kind];
  const orderedGroups = new Set<string>(preferredGroups);
  const groups = [
    ...preferredGroups,
    ...[...grouped.keys()].filter((group) => !orderedGroups.has(group)),
  ];

  for (const group of groups) {
    const groupEntries = grouped.get(group);
    if (!groupEntries || groupEntries.length === 0) {
      continue;
    }
    result.push({
      label: group,
      kind: vscode.QuickPickItemKind.Separator,
    });
    result.push(...groupEntries.map((entry) => toCompletionPick(entry, context)));
  }

  return result;
}

export function isCompletionPickItem(
  item: CompletionQuickPickItem | undefined
): item is CompletionPickItem {
  return (
    !!item &&
    "insertText" in item &&
    "replaceStart" in item &&
    "snapshotInput" in item &&
    "snapshotCursor" in item
  );
}

function getCompletionGroup(
  entry: CompletionEntry,
  context: CompletionContext
): string {
  const kind = entry.kind;

  if (entry.source === "buffer") {
    return "Recent Input";
  }
  if (context.kind === "package") {
    return "Package Members";
  }
  if (
    context.kind === "argument" &&
    entry.source === "lsp" &&
    isArgumentCompletionEntry(entry)
  ) {
    return "Arguments";
  }
  if (kind === vscode.CompletionItemKind.Field || kind === vscode.CompletionItemKind.Property) {
    return "Fields";
  }
  if (entry.source === "session") {
    return isCallableCompletionKind(kind) ? "Runtime Functions" : "Runtime Variables";
  }
  if (kind === vscode.CompletionItemKind.Module) {
    return "Packages";
  }
  if (isCallableCompletionKind(kind)) {
    return "Functions";
  }

  return "Other";
}

function isCallableCompletionKind(kind: vscode.CompletionItemKind | undefined): boolean {
  return (
    kind === vscode.CompletionItemKind.Function ||
    kind === vscode.CompletionItemKind.Method ||
    kind === vscode.CompletionItemKind.Constructor
  );
}

function isArgumentCompletionEntry(entry: CompletionEntry): boolean {
  return (
    entry.detail === "parameter" ||
    entry.detail?.startsWith("value for ") === true
  );
}

function isGlobalSymbolContext(context: CompletionContext): boolean {
  return context.kind === "default" || context.kind === "argument";
}

function getSessionCompletions(
  context: CompletionContext,
  data: WorkspaceData | undefined
): CompletionEntry[] {
  if (!data || !data.globalenv) {
    return [];
  }

  if ((context.kind === "member" || context.kind === "bracket") && context.objectName) {
    if (context.kind === "member" && !TOP_LEVEL_SYMBOL_PATTERN.test(context.objectName)) {
      return [];
    }
    const obj = data.globalenv[context.objectName];
    if (!obj) {
      return [];
    }
    const members =
      context.kind === "bracket"
        ? asStringArray(obj.names)
        : context.operator === "@"
        ? asStringArray(obj.slots)
        : asStringArray(obj.names);
    return members.map((name) => ({
      label: name,
      insertText: getFieldInsertText(name, context),
      kind: vscode.CompletionItemKind.Field,
      detail: context.objectName,
      source: "session",
    }));
  }

  if (!isGlobalSymbolContext(context)) {
    return [];
  }

  return Object.entries(data.globalenv).map(([name, obj]) => {
    const isFunction =
      obj.type === "closure" ||
      obj.type === "builtin" ||
      /^\s*function\s*\(/.test(obj.str || "");
    return {
      label: name,
      insertText: name,
      kind: isFunction
        ? vscode.CompletionItemKind.Function
        : vscode.CompletionItemKind.Variable,
      detail: "session",
      source: "session",
    };
  });
}

function getDataColumnCompletions(
  context: CompletionContext,
  data: WorkspaceData | undefined
): CompletionEntry[] {
  if (!context.dataObjectName || !data?.globalenv) {
    return [];
  }

  const obj = data.globalenv[context.dataObjectName];
  const names = asStringArray(obj?.names);
  if (names.length === 0) {
    return [];
  }

  return names.map((name) => ({
    label: name,
    insertText: getFieldInsertText(name, context),
    kind: vscode.CompletionItemKind.Field,
    detail: context.dataObjectName,
    source: "session" as const,
  }));
}

function asStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.filter((item) => item.length > 0);
  }
  return value ? [value] : [];
}

async function getRuntimeDataColumnCompletions(
  context: CompletionContext,
  completionProvider?: CompletionProvider
): Promise<CompletionEntry[]> {
  if (!context.dataObjectName || !completionProvider?.provideMemberCompletionItems) {
    return [];
  }

  try {
    const items = await completionProvider.provideMemberCompletionItems(
      context.dataObjectName,
      "$"
    );
    if (!items || items.length === 0) {
      return [];
    }
    return items
      .filter((item) => typeof item.name === "string" && item.name.length > 0)
      .map((item) => ({
        label: item.name,
        insertText: getFieldInsertText(item.name, context),
        kind: vscode.CompletionItemKind.Field,
        detail: context.dataObjectName,
        source: "session" as const,
      }));
  } catch {
    return [];
  }
}

function getConsoleBufferCompletions(
  context: CompletionContext,
  currentInputText: string,
  recentConsoleEntries: string[]
): CompletionEntry[] {
  if (
    (context.prefix.length === 0 &&
      !((context.kind === "bracket" || context.kind === "member") && context.chainedBracket)) ||
    (context.kind !== "default" &&
      context.kind !== "argument" &&
      context.kind !== "bracket" &&
      !(context.kind === "member" && context.chainedBracket))
  ) {
    return [];
  }

  const result: CompletionEntry[] = [];
  const seen = new Set<string>();
  const sources = context.prefix.length === 0
    ? [currentInputText]
    : [currentInputText, ...[...recentConsoleEntries].reverse()];

  for (const sourceText of sources) {
    const matches = sourceText
      .replace(BACKTICKED_R_NAME_PATTERN, "")
      .match(CONSOLE_IDENTIFIER_PATTERN);
    if (!matches) {
      continue;
    }

    for (const label of matches) {
      if (
        label === context.prefix ||
        label === context.objectName ||
        label === context.dataObjectName ||
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

async function getRuntimeMemberCompletions(
  context: CompletionContext,
  completionProvider?: CompletionProvider
): Promise<CompletionEntry[]> {
  if (
    context.kind !== "member" ||
    !context.objectName ||
    !context.operator ||
    !completionProvider?.provideMemberCompletionItems
  ) {
    return [];
  }

  try {
    const items = await completionProvider.provideMemberCompletionItems(
      context.objectName,
      context.operator
    );
    if (!items || items.length === 0) {
      return [];
    }
    return items
      .filter((item) => typeof item.name === "string" && item.name.length > 0)
      .map((item) => {
        const isFunction =
          item.type === "closure" ||
          item.type === "builtin" ||
          /^\s*function\s*\(/.test(item.str || "");
        return {
          label: item.name,
          insertText: quoteRNameIfNeeded(item.name),
          kind: isFunction
            ? vscode.CompletionItemKind.Function
            : vscode.CompletionItemKind.Field,
          detail: context.objectName,
          source: "session" as const,
        };
      });
  } catch {
    return [];
  }
}

async function getLanguageServerCompletions(
  context: CompletionContext,
  doc: vscode.TextDocument,
  position: vscode.Position,
  multilineBuffer: string[],
  completionProvider?: CompletionProvider,
  filterAggregateProviderItems = false
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
      return filterAggregateProviderItems
        ? isVscodeAggregateCompletionItem(item)
        : isConsoleOwnedLanguageServerCompletionItem(context, item);
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

function isConsoleOwnedLanguageServerCompletionItem(
  context: CompletionContext,
  item: vscode.CompletionItem
): boolean {
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
}

function isVscodeAggregateCompletionItem(item: vscode.CompletionItem): boolean {
  if (
    item.kind === vscode.CompletionItemKind.Text ||
    item.kind === vscode.CompletionItemKind.Snippet
  ) {
    return false;
  }

  const detail = item.detail;
  if (!detail) {
    return true;
  }

  if (
    detail === "[workspace]" ||
    detail === "[session]"
  ) {
    return false;
  }

  if (
    detail === "[scope]" ||
    detail === "parameter" ||
    detail.startsWith("value for ") ||
    /^\{[^}]+\}$/.test(detail)
  ) {
    return true;
  }

  return false;
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

function filterShadowedWorkspaceEntries(
  entries: CompletionEntry[],
  workspaceEntries: CompletionEntry[],
  context: CompletionContext,
  preserveEntry?: (entry: CompletionEntry) => boolean
): CompletionEntry[] {
  if (entries.length === 0 || workspaceEntries.length === 0) {
    return entries;
  }

  const workspaceLabels = new Set(
    workspaceEntries.map((entry) => getCompletionDedupeKey(entry, context))
  );

  return entries.filter((entry) => {
    if (preserveEntry?.(entry)) {
      return true;
    }
    return !workspaceLabels.has(getCompletionDedupeKey(entry, context));
  });
}

function dedupeCompletionEntries(
  entries: CompletionEntry[],
  context: CompletionContext
): CompletionEntry[] {
  const seen = new Set<string>();
  const result: CompletionEntry[] = [];
  for (const entry of entries) {
    const key = getCompletionDedupeKey(entry, context);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function getCompletionDedupeKey(
  entry: CompletionEntry,
  context: CompletionContext
): string {
  return [
    getCompletionGroup(entry, context),
    entry.label.toLowerCase(),
    entry.insertText,
    entry.kind ?? -1,
  ].join("\u0000");
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
