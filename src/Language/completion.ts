import * as vscode from "vscode";
import { completionMatch } from "./completionMatch";
import { getCompletionSyntax, isCallableName, type CallCompletionContext } from "./parser";

export type CompletionContext = {
  kind: "member" | "package" | "bracket" | "argument" | "default";
  prefix: string;
  replaceStart: number;
  // Line-relative offset, potentially past this line for a multiline string.
  replaceEnd?: number;
  triggerCharacter?: string;
  objectName?: string;
  operator?: "$" | "@";
  bracketOperator?: "[" | "[[";
  bracketQuote?: "\"" | "'";
  bracketDimension?: number;
  bracketDimensions?: number;
  argumentValue?: CallCompletionContext["argumentValue"];
  pipe?: boolean;
  autoTrigger?: boolean;
  suppressAutomatic?: boolean;
  chainedBracket?: boolean;
  functionName?: string;
  functionOperator?: "$" | "@" | "::" | ":::";
  // Source tags from the lexer, available only at an argument-name position.
  argumentTags?: CallCompletionContext["argumentTags"];
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
  packageName?: string;
};

export type CompletionEntries = CompletionEntry[] & {
  isIncomplete?: boolean;
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
  "Arguments",
  "Runtime Variables",
  "Runtime Functions",
  "Packages",
  "Functions",
  "Recent Input",
  "Other",
] as const;

const EXACT_MATCH_GROUP_ORDER = [
  "Runtime Variables",
  "Runtime Functions",
  "Functions",
  "Package Members",
  "Packages",
  "Fields",
  "Arguments",
  "Recent Input",
  "Other",
] as const;

export type CompletionPickItem = vscode.QuickPickItem & {
  packageName?: string;
  insertText: string;
  isCallable?: boolean;
  replaceStart: number;
  replaceEnd?: number;
  snapshotInput: string;
  snapshotCursor: number;
  source: "lsp" | "session" | "buffer";
};

export type CompletionQuickPickItem = CompletionPickItem | vscode.QuickPickItem;

export type CompletionResult = (vscode.CompletionList | vscode.CompletionItem[]) & {
  // Applies even when filtering leaves no arguments or the definition has none.
  rConsoleLocalFunction?: boolean;
};

export interface CompletionProvider {
  // A selected package function can be qualified in the LSP projection while
  // its name remains unqualified in the visible console input.
  getCallContext?(doc: vscode.TextDocument, position: vscode.Position): CallCompletionContext | undefined;
  provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string,
    // Keep the user's cursor when position is moved to broaden matching.
    contextPosition?: vscode.Position
  ): Promise<CompletionResult | undefined>;
}

export type RuntimeMemberCompletionRequester = (
  expression: string,
  operator: "$" | "@"
) => Promise<
  Array<{
    name: string;
    type?: string;
    str?: string;
  }> | undefined
> | undefined;

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

function isSessionFunction(item: GlobalEnvItem): boolean {
  return item.type === "closure" || item.type === "builtin" || item.type === "special" ||
    /^\s*function\s*\(/.test(item.str || "");
}

function isSessionFunctionCall(context: CompletionContext, data: WorkspaceData | undefined): boolean {
  if (context.functionOperator || !context.functionName) return false;
  return Object.entries(data?.globalenv ?? {}).some(([name, item]) => isSessionFunction(item) &&
    (context.functionName === name ||
      context.functionName === `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``));
}

const TOP_LEVEL_SYMBOL_PATTERN = /^[a-zA-Z._][a-zA-Z0-9._]*$/;
const R_SYNTACTIC_NAME_PATTERN = /^(?:[a-zA-Z]|\.(?![0-9]))[a-zA-Z0-9._]*$/;
const BRACKET_CHAIN_SEGMENT = "(?:\\[[^\\[\\]]*\\]|\\[\\[[^\\[\\]]*\\]\\])";
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

function isPipePlaceholder(name: string): boolean {
  return name === "_" || name === ".";
}

function quoteRNameIfNeeded(name: string): string {
  if (R_SYNTACTIC_NAME_PATTERN.test(name) && !R_RESERVED_WORDS.has(name)) {
    return name;
  }
  return `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
}

function getFieldInsertText(name: string, context: CompletionContext, bare = false): string {
  if (context.kind !== "bracket") {
    return quoteRNameIfNeeded(name);
  }
  if (context.bracketQuote) {
    const quotePattern = context.bracketQuote === "\"" ? /"/g : /'/g;
    return name.replace(/\\/g, "\\\\").replace(quotePattern, `\\${context.bracketQuote}`);
  }
  if (context.bracketOperator === "[[" || !bare) {
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
  fullTextBeforeCursor?: string,
  textAfterCursor = inputBuffer.slice(cursorPosition)
): CompletionContext | undefined {
  const snapshotInput = inputBuffer;
  const snapshotCursor = cursorPosition;
  const beforeCursor = snapshotInput.slice(0, snapshotCursor);

  const textForDataContext = fullTextBeforeCursor ?? beforeCursor;
  const fullText = textForDataContext + textAfterCursor;
  const relativeOffset = textForDataContext.length - beforeCursor.length;
  const syntax = getCompletionSyntax(fullText, textForDataContext.length);
  const inLiteral = syntax.inLiteral;
  const identifierEnd = syntax.identifierEnd;
  const replacement = identifierEnd === undefined ? {} : { replaceEnd: identifierEnd - relativeOffset };
  const dataObjectName = detectDataContext(textForDataContext);

  const member = syntax.member;
  if (member) {
    const { operator, prefix } = member;
    const replaceStart = member.replaceStart - (textForDataContext.length - beforeCursor.length);
    if (operator === "::" || operator === ":::") {
      return {
        kind: "package",
        prefix,
        replaceStart,
        ...replacement,
        triggerCharacter: ":",
        autoTrigger: true,
        snapshotInput,
        snapshotCursor,
      };
    }
    const isBracketChainMember = operator === "$" && member.hasSubscript;
    const baseObject = isBracketChainMember ? member.baseObject : undefined;
    const isPlaceholderMember = !!baseObject && isPipePlaceholder(baseObject) && !!dataObjectName;
    return {
      kind: "member",
      autoTrigger: true,
      prefix,
      replaceStart,
      ...replacement,
      triggerCharacter: prefix.length === 0 ? operator : undefined,
      objectName: isPlaceholderMember ? dataObjectName : baseObject ?? member.objectName,
      operator,
      chainedBracket: isBracketChainMember,
      dataObjectName: isPlaceholderMember ? dataObjectName : undefined,
      snapshotInput,
      snapshotCursor,
    };
  }

  const bracket = syntax.bracket;
  if (bracket && bracket.replaceStart >= relativeOffset) {
    const isPlaceholderBracket = isPipePlaceholder(bracket.objectName) && !!dataObjectName;
    const effectiveDataObject = isPlaceholderBracket ? dataObjectName : bracket.objectName;
    return {
      kind: "bracket",
      autoTrigger: true,
      prefix: bracket.prefix,
      replaceStart: bracket.replaceStart - relativeOffset,
      ...(bracket.replaceEnd !== undefined ? { replaceEnd: bracket.replaceEnd - relativeOffset } : {}),
      triggerCharacter: bracket.quote ? undefined : "[",
      objectName: effectiveDataObject,
      bracketOperator: bracket.operator,
      bracketQuote: bracket.quote,
      bracketDimension: bracket.dimension,
      bracketDimensions: bracket.dimensions,
      chainedBracket: bracket.objectName.includes("[") || isPlaceholderBracket,
      dataObjectName: effectiveDataObject,
      operator: undefined,
      snapshotInput,
      snapshotCursor,
    };
  }

  const pipe = syntax.pipe;
  if (pipe && !inLiteral) {
    return { kind: "default", pipe: true, autoTrigger: true, prefix: pipe.prefix,
      replaceStart: pipe.replaceStart - relativeOffset, ...replacement, snapshotInput, snapshotCursor };
  }

  const call = syntax.call;
  if (call) {
    const argPrefixMatch = /([\p{L}\p{Nl}\p{Nd}._]*)$/u.exec(beforeCursor);
    const value = call.argumentValue && call.argumentValue.replaceStart >= relativeOffset ? call.argumentValue : undefined;
    const prefix = value?.prefix ?? (argPrefixMatch ? argPrefixMatch[1] : "");
    return {
      kind: "argument",
      autoTrigger: !!call.argumentTags || !!value,
      suppressAutomatic: inLiteral && !value,
      prefix,
      replaceStart: value ? value.replaceStart - relativeOffset : beforeCursor.length - prefix.length,
      ...replacement,
      ...(value?.replaceEnd !== undefined ? { replaceEnd: value.replaceEnd - relativeOffset } : {}),
      functionName: call.name,
      functionOperator: call.operator,
      argumentTags: call.argumentTags,
      argumentValue: value,
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
        suppressAutomatic: inLiteral,
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
    suppressAutomatic: inLiteral,
    prefix,
    replaceStart: beforeCursor.length - prefix.length,
    ...replacement,
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
  requestRuntimeMemberCompletions?: RuntimeMemberCompletionRequester,
  consoleInputText?: string
): Promise<CompletionEntries> {
  const sessionItems = getSessionCompletions(context, sessionData);
  const runtimeMemberItemsRequest =
    context.kind === "member"
      ? getRuntimeMemberCompletions(context, requestRuntimeMemberCompletions)
      : Promise.resolve([]);
  const runtimeArguments = context.kind === "argument" &&
    (context.functionOperator === "$" || context.functionOperator === "@" ||
      (isSessionFunctionCall(context, sessionData) &&
        !(doc && position && completionProvider?.getCallContext?.(doc, position)?.operator)));
  const runtimeArgumentItemsRequest = runtimeArguments
    ? getRuntimeArgumentCompletions(context, requestRuntimeMemberCompletions)
    : Promise.resolve([]);
  const includeLspItems =
    needsLanguageServerCompletion(context) && !!doc && !!position;
  const rawLspItemsRequest =
    !includeLspItems
      ? Promise.resolve({ entries: [] as CompletionEntry[], isIncomplete: false, rConsoleLocalFunction: false })
      : getLanguageServerCompletions(
          context,
          doc,
          position,
          multilineBuffer,
          completionProvider
        );
  const bufferItems = getConsoleBufferCompletions(
    context,
    consoleInputText ?? doc?.getText() ?? "",
    recentConsoleEntries
  );
  // Quoted argument values accept only declared values. A live column probe
  // cannot contribute here and may wait on an unrelated busy R session.
  const includeColumns = !context.argumentValue?.quote;
  const cachedColumnItems = includeColumns ? getDataColumnCompletions(context, sessionData) : [];
  const columnItemsRequest =
    !includeColumns || cachedColumnItems.length > 0
      ? Promise.resolve(cachedColumnItems)
      : getRuntimeDataColumnCompletions(
          context,
          requestRuntimeMemberCompletions
        );
  const rawLspResult = await rawLspItemsRequest;
  // A source definition visible at the cursor supersedes an older session
  // function, including when it has no remaining parameters or known values.
  // Keep lookups concurrent, but do not wait for a superseded runtime probe.
  const useRuntimeArguments = runtimeArguments && !rawLspResult.rConsoleLocalFunction;
  const [runtimeMemberItems, columnItems, runtimeArgumentItems] = await Promise.all([
    runtimeMemberItemsRequest,
    columnItemsRequest,
    useRuntimeArguments ? runtimeArgumentItemsRequest : Promise.resolve([]),
  ]);
  // Otherwise, member and user-defined signatures belong to the active session.
  // A same-name package function must not supply unrelated arguments, even
  // when the session cannot currently reply or the function has no formals.
  const rawLspItems = rawLspResult.entries.filter(entry => {
    if (useRuntimeArguments && isArgumentCompletionEntry(entry)) return false;
    if (context.kind === "argument" && !context.argumentTags && entry.detail === "parameter") return false;
    return !context.pipe || isCallableCompletionKind(entry.kind);
  });
  const lspItems =
    isGlobalSymbolContext(context)
      ? filterShadowedWorkspaceEntries(
          rawLspItems,
          sessionItems,
          context.kind === "argument" ? isArgumentCompletionEntry : undefined
        )
      : rawLspItems;
  const fallbackBufferItems = filterShadowedBufferEntries(bufferItems, [
    ...lspItems,
    ...sessionItems,
    ...runtimeMemberItems,
    ...columnItems,
    ...runtimeArgumentItems,
  ]);

  if (context.kind === "bracket") {
    const columnFiltered = filterCompletionEntries(columnItems, context.prefix);
    const lspFiltered = filterCompletionEntries(lspItems, context.prefix);
    const sessionFiltered = filterCompletionEntries(sessionItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);
    return asCompletionEntries(dedupeCompletionEntries([
      ...columnFiltered,
      ...(!context.bracketQuote ? [...lspFiltered, ...sessionFiltered, ...bufferFiltered] : []),
    ]), rawLspResult.isIncomplete);
  }

  if (context.kind === "argument") {
    const lspFiltered = filterCompletionEntries(lspItems, context.prefix);
    const sessionFiltered = filterCompletionEntries(sessionItems, context.prefix);
    const columnFiltered = filterCompletionEntries(columnItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);

    return asCompletionEntries(dedupeCompletionEntries([
      ...filterCompletionEntries(runtimeArgumentItems, context.prefix),
      ...(!context.argumentValue?.quote ? columnFiltered : []),
      ...lspFiltered,
      ...(!context.argumentValue?.quote ? [...sessionFiltered, ...bufferFiltered] : []),
    ]), rawLspResult.isIncomplete);
  }

  if (context.kind === "member") {
    const runtimeFiltered = filterCompletionEntries(runtimeMemberItems, context.prefix);
    const sessionFiltered = filterCompletionEntries(sessionItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);
    if (context.chainedBracket && bufferFiltered.length > 0) {
      return asCompletionEntries(
        dedupeCompletionEntries([...runtimeFiltered, ...sessionFiltered, ...bufferFiltered]),
        rawLspResult.isIncomplete
      );
    }
    if (runtimeFiltered.length > 0) {
      return asCompletionEntries(
        dedupeCompletionEntries(runtimeFiltered),
        rawLspResult.isIncomplete
      );
    }
    return asCompletionEntries(
      dedupeCompletionEntries([...sessionFiltered, ...bufferFiltered]),
      rawLspResult.isIncomplete
    );
  }

  const defaultColumnFiltered = filterCompletionEntries(columnItems, context.prefix);

  return asCompletionEntries(dedupeCompletionEntries(filterCompletionEntries(
    [
      ...defaultColumnFiltered,
      ...lspItems,
      ...sessionItems,
      ...(!context.pipe ? fallbackBufferItems : []),
    ],
    context.prefix
  )), rawLspResult.isIncomplete);
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

const COMPLETION_LABEL_COLLATOR = new Intl.Collator("en", { sensitivity: "base" });

function compareCompletionLabels(a: CompletionEntry, b: CompletionEntry): number {
  return COMPLETION_LABEL_COLLATOR.compare(a.label, b.label) ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
}

/** Rank symbols within groups; keep signature, value, and object-member order. */
export function rankCompletionEntries(
  entries: CompletionEntry[], query: string, context?: CompletionContext
): CompletionEntry[] {
  if (context?.kind === "member") return filterCompletionEntries(entries, query);
  const groups = new Map<string, CompletionEntry[]>();
  for (const entry of entries) {
    const group = context ? getCompletionGroup(entry, context)
      : isArgumentCompletionEntry(entry) ? "Arguments" : "Symbols";
    const candidates = groups.get(group);
    if (candidates) candidates.push(entry);
    else groups.set(group, [entry]);
  }
  const preserveFields = context && (context.kind === "bracket" ||
    isDataCompletionContext(context));
  return [...groups].flatMap(([group, candidates]) =>
    group === "Arguments" || (group === "Fields" && preserveFields)
      ? filterCompletionEntries(candidates, query)
      : rankSymbolEntries(candidates, query)
  );
}

function rankSymbolEntries(entries: CompletionEntry[], query: string): CompletionEntry[] {
  const needle = query.toLowerCase();
  if (!needle) return [...entries].sort(compareCompletionLabels);
  return entries
    .map((entry, index) => ({ entry, index, match: completionMatch(entry.label, query) }))
    .filter(({ match }) => match !== undefined)
    .sort((a, b) => {
      const aLabel = a.entry.label.toLowerCase();
      const bLabel = b.entry.label.toLowerCase();
      const aRank = aLabel === needle ? 0 : aLabel.startsWith(needle) ? 1 : aLabel.includes(needle) ? 2 : 3;
      const bRank = bLabel === needle ? 0 : bLabel.startsWith(needle) ? 1 : bLabel.includes(needle) ? 2 : 3;
      return aRank - bRank ||
        Number(b.entry.label === query) - Number(a.entry.label === query) ||
        a.match![0] - b.match![0] ||
        a.match!.at(-1)! - a.match![0] - (b.match!.at(-1)! - b.match![0]) ||
        aLabel.length - bLabel.length || compareCompletionLabels(a.entry, b.entry) || a.index - b.index;
    })
    .map(({ entry }) => entry);
}

export function toCompletionPick(
  entry: CompletionEntry,
  context: CompletionContext
): CompletionPickItem {
  const icon = getCompletionIcon(entry.kind);
  const description = getCompletionDescription(entry);
  return {
    label: `${icon} ${entry.label || '""'}`,
    description,
    detail: entry.detail,
    insertText: entry.insertText,
    isCallable: isCallableCompletionKind(entry.kind),
    replaceStart: entry.replaceStart ?? context.replaceStart,
    ...(context.replaceEnd !== undefined ? { replaceEnd: context.replaceEnd } : {}),
    snapshotInput: context.snapshotInput,
    snapshotCursor: context.snapshotCursor,
    source: entry.source,
    packageName: entry.packageName,
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
    isDataCompletionContext(context)
      ? DATA_CONTEXT_GROUP_ORDER
      : COMPLETION_GROUP_ORDER[context.kind];
  const orderedGroups = new Set<string>(preferredGroups);
  const baseGroups = [
    ...preferredGroups,
    ...[...grouped.keys()].filter((group) => !orderedGroups.has(group)),
  ];
  const pinnedGroups = getPinnedCompletionGroups(context).filter((group) =>
    grouped.has(group)
  );
  const exactMatchGroups = getExactMatchGroups(grouped, context.prefix).filter(
    (group) => !pinnedGroups.includes(group)
  );
  const groups = exactMatchGroups.length === 0
    ? baseGroups
    : [
        ...pinnedGroups,
        ...exactMatchGroups,
        ...baseGroups.filter((group) =>
          !pinnedGroups.includes(group) && !exactMatchGroups.includes(group)
        ),
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

function getPinnedCompletionGroups(context: CompletionContext): string[] {
  return [
    ...(isDataCompletionContext(context) ? ["Fields"] : []),
    ...(context.kind === "argument" ? ["Arguments"] : []),
  ];
}

function getExactMatchGroups(
  grouped: Map<string, CompletionEntry[]>,
  prefix: string
): string[] {
  const query = prefix.toLowerCase();
  if (query.length === 0) {
    return [];
  }

  const exactGroups = [...grouped.entries()]
    .filter(([, entries]) =>
      entries.some((entry) => entry.label.toLowerCase() === query)
    )
    .map(([group]) => group);

  return exactGroups.sort((a, b) =>
    getExactMatchGroupRank(a) - getExactMatchGroupRank(b)
  );
}

function getExactMatchGroupRank(group: string): number {
  const index = EXACT_MATCH_GROUP_ORDER.indexOf(
    group as typeof EXACT_MATCH_GROUP_ORDER[number]
  );
  return index === -1 ? EXACT_MATCH_GROUP_ORDER.length : index;
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
  if (isArgumentCompletionEntry(entry)) {
    return "Arguments";
  }
  if (kind === vscode.CompletionItemKind.Field || kind === vscode.CompletionItemKind.Property) {
    if (entry.source === "lsp" && isDataCompletionContext(context)) {
      return "Other";
    }
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

function isDataCompletionContext(context: CompletionContext): boolean {
  return (
    !!context.dataObjectName &&
    (context.kind === "default" || context.kind === "argument" || context.kind === "bracket")
  );
}

function isCallableCompletionKind(kind: vscode.CompletionItemKind | undefined): boolean {
  return kind !== undefined && (
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

  if (context.kind === "member" && context.objectName) {
    if (!TOP_LEVEL_SYMBOL_PATTERN.test(context.objectName)) {
      return [];
    }
    const obj = data.globalenv[context.objectName];
    if (!obj) {
      return [];
    }
    const members = context.operator === "@"
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

  if (context.kind === "package") {
    return [];
  }

  return Object.entries(data.globalenv).flatMap(([name, obj]) => {
    const isFunction = isSessionFunction(obj);
    if (context.pipe && !isFunction) return [];
    return [{
      label: name,
      insertText: quoteRNameIfNeeded(name) + (isFunction ? "()" : ""),
      kind: isFunction
        ? vscode.CompletionItemKind.Function
        : vscode.CompletionItemKind.Variable,
      detail: "session",
      source: "session" as const,
    }];
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
  const bare = obj?.class?.includes("data.table") === true;
  if (context.kind === "bracket" && !bare && (context.bracketDimensions ?? 1) > 1 &&
      context.bracketDimension !== 1) return [];
  const names = asStringArray(obj?.names);
  if (names.length === 0) {
    return [];
  }

  return names.map((name) => ({
    label: name,
    insertText: getFieldInsertText(name, context, bare),
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
  requestRuntimeMemberCompletions?: RuntimeMemberCompletionRequester
): Promise<CompletionEntry[]> {
  if (!context.dataObjectName || !requestRuntimeMemberCompletions) {
    return [];
  }

  try {
    if (context.kind === "bracket") {
      const items = await requestRuntimeMemberCompletions(
        `base::local({ .obj <- (${context.dataObjectName}); ` +
        `.bare <- base::inherits(.obj, "data.table"); ` +
        `.nms <- if (.bare || ${context.bracketDimensions ?? 1}L == 1L) base::names(.obj) else ` +
        `base::dimnames(.obj)[[${(context.bracketDimension ?? 0) + 1}L]]; ` +
        `stats::setNames(base::as.list(.nms), base::paste0(if (.bare) "bare:" else "quoted:", .nms)) })`, "$"
      );
      return (items ?? []).flatMap(item => {
        const match = /^(bare|quoted):([\s\S]+)$/.exec(item.name);
        return match ? [{ label: match[2], insertText: getFieldInsertText(match[2], context, match[1] === "bare"),
          kind: vscode.CompletionItemKind.Field, detail: context.dataObjectName, source: "session" as const }] : [];
      });
    }
    const items = await requestRuntimeMemberCompletions(
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
        (context.kind === "member" &&
          (label === context.objectName || label === context.dataObjectName)) ||
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
  requestRuntimeMemberCompletions?: RuntimeMemberCompletionRequester
): Promise<CompletionEntry[]> {
  if (
    context.kind !== "member" ||
    !context.objectName ||
    !context.operator ||
    !requestRuntimeMemberCompletions
  ) {
    return [];
  }

  try {
    const items = await requestRuntimeMemberCompletions(
      context.objectName,
      context.operator
    );
    if (!items || items.length === 0) {
      return [];
    }
    return items
      .filter((item) => typeof item.name === "string" && item.name.length > 0)
      .map((item) => {
        const isFunction = isSessionFunction(item);
        return {
          label: item.name,
          insertText: quoteRNameIfNeeded(item.name) + (isFunction ? "()" : ""),
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

async function getRuntimeArgumentCompletions(
  context: CompletionContext,
  request?: RuntimeMemberCompletionRequester
): Promise<CompletionEntry[]> {
  if (!request || !context.functionName || (!context.argumentTags && !context.argumentValue)) return [];
  try {
    if (context.argumentValue) {
      const value = context.argumentValue;
      const supplied = (value.argumentTags ?? [null]).map(tag =>
        tag === null ? `${value.name} = TRUE` : `${tag ? `${tag} = ` : ""}NULL`).join(", ");
      const items = await request(
        `base::local({ .fn <- (${context.functionName}); .vals <- NULL; ` +
        `if (base::is.function(.fn)) { .defs <- base::formals(base::args(.fn)); ` +
        `.matched <- base::tryCatch(base::suppressWarnings(base::match.call(definition = base::args(.fn), ` +
        `call = base::quote(.fn(${supplied})), expand.dots = FALSE)), error = function(e) NULL); ` +
        `.matched <- base::as.list(.matched)[-1L]; ` +
        `.tag <- base::names(.matched)[base::vapply(.matched, base::identical, base::logical(1), TRUE)]; ` +
        `if (base::length(.tag) == 1L && .tag %in% base::names(.defs)` +
        (value.argumentTags ? "" : ` && .tag == base::names(base::as.list(base::quote(.fn(${value.name} = NULL))))[2L]`) +
        `) { .expr <- .defs[[.tag]]; ` +
        `.vals <- if (base::is.character(.expr)) .expr else if (base::is.call(.expr) && ` +
        `base::identical(.expr[[1L]], base::quote(c))) ` +
        `base::unlist(base::Filter(base::is.character, base::as.list(.expr)[-1L]), use.names = FALSE) else NULL } }; ` +
        `stats::setNames(base::as.list(.vals), if (base::length(.vals)) base::paste0("value:", .vals) else base::character()) })`, "$"
      );
      return (items ?? []).filter(item => item.name.startsWith("value:")).map(item => ({
        label: item.name.slice(6), insertText: quoteCompletionValue(item.name.slice(6), value.quote),
        kind: vscode.CompletionItemKind.Value, detail: `value for ${value.name}`, source: "session" as const }));
    }
    // A completion inserts a name, which R matches before positional values on
    // either side of the cursor. Check each candidate as a named argument rather
    // than reserving a positional slot. Only match syntax: values, defaults and
    // the function body are never evaluated. All candidates share one request.
    const supplied = context.argumentTags!.map(tag =>
      tag === null ? "TRUE" : `${tag ? `${tag} = ` : ""}NULL`).join(", ");
    const cursorSlot = context.argumentTags!.indexOf(null) + 2;
    const items = await request(
      `base::local({ .fn <- (${context.functionName}); ` +
      `.args <- if (base::is.function(.fn)) { ` +
      `.def <- base::args(.fn); ` +
      `.call <- base::as.list(base::quote(.fn(${supplied}))); ` +
      `if (base::is.null(base::names(.call))) base::names(.call) <- base::rep("", base::length(.call)); ` +
      `.candidates <- base::setdiff(base::names(base::formals(.def)), base::c("...", base::names(.call))); ` +
      `.candidates[base::vapply(.candidates, function(.name) { ` +
      `.candidate <- .call; base::names(.candidate)[${cursorSlot}L] <- .name; ` +
      `base::tryCatch({ base::suppressWarnings(base::match.call(` +
      `definition = .def, call = base::as.call(.candidate), expand.dots = FALSE)); TRUE }, ` +
      `error = function(e) FALSE) }, base::logical(1))] } else NULL; ` +
      `stats::setNames(base::as.list(.args), .args) })`, "$"
    );
    return (items ?? []).filter(item => item.name && item.name !== "...").map(item => ({
      label: item.name,
      insertText: `${quoteRNameIfNeeded(item.name)} = `,
      kind: vscode.CompletionItemKind.Variable,
      detail: "parameter",
      source: "session",
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
): Promise<{ entries: CompletionEntry[]; isIncomplete: boolean; rConsoleLocalFunction?: boolean }> {
  if (!completionProvider) {
    return { entries: [], isIncomplete: false };
  }
  try {
    let result = await completionProvider.provideCompletionItems(
      doc,
      position,
      context.triggerCharacter
    );
    let localFunction = result?.rConsoleLocalFunction === true;

    let items = Array.isArray(result) ? result : result?.items || [];
    const usable = (item: vscode.CompletionItem): boolean => isLanguageServerCompletionItem(context, item, doc.uri?.toString());
    // Some R language servers only return contiguous matches. If that lookup
    // has no usable candidates, request at the first prefix character and
    // apply our matcher to the returned candidates. Keep the real document and
    // its replacement start intact; never rewrite code to manufacture results.
    if (context.prefix.length > 1 &&
        !items.some(item => usable(item) &&
          completionMatch(getCompletionLabel(item), context.prefix))) {
      const firstCharacter = [...context.prefix][0];
      result = await completionProvider.provideCompletionItems(doc,
        new vscode.Position(position.line, context.replaceStart + firstCharacter.length),
        context.triggerCharacter, position);
      localFunction ||= result?.rConsoleLocalFunction === true;
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
        source: "lsp",
        replaceStart: getCompletionReplaceStart(item, context, multilineBuffer),
        packageName: getCompletionPackage(item),
      })),
      isIncomplete: !Array.isArray(result) && result?.isIncomplete === true,
      rConsoleLocalFunction: localFunction,
    };
  } catch {
    return { entries: [], isIncomplete: false };
  }
}

function asCompletionEntries(
  entries: CompletionEntry[],
  isIncomplete: boolean
): CompletionEntries {
  const result = entries as CompletionEntries;
  if (isIncomplete) {
    result.isIncomplete = true;
  }
  return result;
}

function getCompletionPackage(item: vscode.CompletionItem): string | undefined {
  if (!isCallableCompletionKind(item.kind)) {
    return undefined;
  }
  const data = (item as vscode.CompletionItem & { data?: { package?: unknown } }).data;
  if (typeof data?.package === "string" && /^[A-Za-z][A-Za-z0-9.]*$/.test(data.package)) {
    return data.package;
  }
  return /^\{([A-Za-z][A-Za-z0-9.]*)\}$/.exec(item.detail ?? "")?.[1];
}

function isLanguageServerCompletionItem(
  context: CompletionContext,
  item: vscode.CompletionItem,
  documentUri?: string
): boolean {
  if (context.pipe && !isCallableCompletionKind(item.kind)) return false;
  if (context.argumentValue?.quote && !item.detail?.startsWith("value for ")) return false;
  if (item.kind === vscode.CompletionItemKind.Text) {
    return false;
  }

  if (item.detail === "[workspace]") {
    const data = (item as vscode.CompletionItem & { data?: { package?: string; context_uri?: string } }).data;
    // Only definitions from this console's virtual document are authoritative.
    // Other workspace/editor symbols must not leak into the console session.
    return isCallableCompletionKind(item.kind) && data?.package === "_workspace_" &&
      documentUri !== undefined && data.context_uri === documentUri;
  }

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

function getCompletionInsertText(item: vscode.CompletionItem, context: CompletionContext): string {
  // Value labels are literal R strings, including dollar signs and braces.
  // Quote them for both named and positional insertion before snippet handling.
  if (item.detail?.startsWith("value for ")) {
    return quoteCompletionValue(getCompletionLabel(item), context.argumentValue?.quote);
  }
  let text: string;

  if (typeof item.insertText === "string") {
    text = item.insertText;
  } else if (item.insertText instanceof vscode.SnippetString) {
    text = item.insertText.value; 
  } else {
    text = getCompletionLabel(item);
  }

  // The R server builds callable snippets from literal symbol names. Protect
  // those names before expanding tab stops (foo$1 is an R name, not $1).
  const label = getCompletionLabel(item);
  if (isCallableCompletionKind(item.kind) &&
      (text === label || text === `${label}()` || text === `${label}($0)`)) {
    const name = label.startsWith("`") && isCallableName(label) ? label : quoteRNameIfNeeded(label);
    return name + (text !== label || context.kind === "package" ? "()" : "");
  }
  const result = item.insertText instanceof vscode.SnippetString ? stripSnippetSyntax(text) : text;
  if (context.kind === "package" && isCallableCompletionKind(item.kind) &&
      isCallableName(result)) return result + "()";
  return result;
}

function quoteCompletionValue(value: string, existingQuote?: "\"" | "'"): string {
  const quote = existingQuote ?? '"';
  const escaped = value.replace(/\\/g, "\\\\").replaceAll(quote, `\\${quote}`)
    .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return existingQuote ? escaped : quote + escaped + quote;
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
    if (normalizedPrefix && !completionMatch(label, normalizedPrefix)) {
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

  const preferredKeys = new Set(
    preferredEntries
      .filter((entry) => entry.source !== "buffer")
      .map(entry => entry.label)
  );

  return bufferEntries.filter(
    (entry) => !preferredKeys.has(entry.label)
  );
}

function filterShadowedWorkspaceEntries(
  entries: CompletionEntry[],
  workspaceEntries: CompletionEntry[],
  preserveEntry?: (entry: CompletionEntry) => boolean
): CompletionEntry[] {
  if (entries.length === 0 || workspaceEntries.length === 0) {
    return entries;
  }

  const workspaceLabels = new Set(
    workspaceEntries.map(getCompletionIdentityKey)
  );

  return entries.filter((entry) => {
    if (preserveEntry?.(entry)) {
      return true;
    }
    return !workspaceLabels.has(getCompletionIdentityKey(entry));
  });
}

function dedupeCompletionEntries(
  entries: CompletionEntry[]
): CompletionEntry[] {
  const seen = new Set<string>();
  const result: CompletionEntry[] = [];
  for (const entry of entries) {
    const key = getCompletionIdentityKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

export function getCompletionIdentityKey(entry: CompletionEntry): string {
  return [
    entry.label,
    entry.detail ?? "",
    getCompletionDescription(entry),
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
