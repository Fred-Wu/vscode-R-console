import * as vscode from "vscode";
import type { CompletionContext, CompletionEntry, CompletionPickItem, CompletionQuickPickItem } from "./types";
import { completionMatch } from "../completionMatch";
import { getCompletionDescription, filterCompletionEntries, isArgumentCompletionEntry, isCallableCompletionKind } from "./candidates";

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
  package: ["Functions", "Variables", "Fields", "Packages", "Other"],
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
  "Variables",
  "Packages",
  "Fields",
  "Arguments",
  "Recent Input",
  "Other",
] as const;

const COMPLETION_LABEL_COLLATOR = new Intl.Collator("en", { sensitivity: "base" });

function compareCompletionLabels(a: CompletionEntry, b: CompletionEntry): number {
  return COMPLETION_LABEL_COLLATOR.compare(a.label, b.label) ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
}

export function rankCompletionEntries(
  entries: CompletionEntry[], query: string, context?: CompletionContext
): CompletionEntry[] {
  if (context?.kind === "member") {
    const matched = filterCompletionEntries(entries, query);
    if (!query) return matched;
    const normalized = query.toLowerCase();
    const rank = (label: string): number => {
      const value = label.toLowerCase();
      if (label === query) return 0;
      if (value === normalized) return 1;
      if (value.startsWith(normalized)) return 2;
      if (value.includes(normalized)) return 3;
      return 4;
    };
    return matched.map((entry, index) => ({ entry, index }))
      .sort((a, b) => rank(a.entry.label) - rank(b.entry.label) || a.index - b.index)
      .map(({ entry }) => entry);
  }
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
        compareCompletionLabels(a.entry, b.entry) || a.index - b.index;
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
    ...((entry.replaceEnd ?? context.replaceEnd) !== undefined ? { replaceEnd: entry.replaceEnd ?? context.replaceEnd } : {}),
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
  if (context.kind === "package" && kind !== undefined &&
      (kind === vscode.CompletionItemKind.Variable || kind === vscode.CompletionItemKind.Constant)) {
    return "Variables";
  }
  if (isArgumentCompletionEntry(entry)) {
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

function isDataCompletionContext(context: CompletionContext): boolean {
  return (
    !!context.dataObjectName &&
    (context.kind === "default" || context.kind === "argument" || context.kind === "bracket")
  );
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
