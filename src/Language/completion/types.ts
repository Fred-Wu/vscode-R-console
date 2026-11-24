import type * as vscode from "vscode";
import type { CallCompletionContext } from "./contextParser";
import type { MemberInspectionResult } from "../../Runtime/backendProtocol";
import type { WorkspaceStrings } from "../../Runtime/VSCR/workspaceMetadata";
import type { CompletionSuppressionReason, StaticCompletionUnavailableReason } from "./diagnostics";
export type CompletionContext = {
  kind: "member" | "package" | "bracket" | "argument" | "default" | "static";
  prefix: string;
  replaceStart: number;
  // Line-relative offset, potentially past this line for a multiline string.
  replaceEnd?: number;
  triggerCharacter?: string;
  objectName?: string;
  indexedObject?: boolean;
  operator?: "$" | "@";
  bracketOperator?: "[" | "[[";
  bracketQuote?: "\"" | "'";
  bracketDimension?: number;
  bracketDimensions?: number;
  bracketArgumentName?: string;
  argumentValue?: CallCompletionContext["argumentValue"];
  pipe?: boolean;
  autoTrigger?: boolean;
  suppressAutomatic?: boolean;
  rejectionReason?: "executable-receiver";
  // Parser-rejected receiver selected for source-only LSP fallback.
  staticFallback?: boolean;
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
  replaceEnd?: number;
  role?: "argument" | "value" | "member" | "scope";
  // Explicit bracket-context symbol supplied by installed package metadata.
  bracketSpecial?: boolean;
  packageName?: string;
};

export type CompletionEntries = CompletionEntry[] & {
  isIncomplete?: boolean;
  // Whether static analysis resolved the requested member/column receiver.
  staticResolved?: boolean;
  staticUnavailableReason?: StaticCompletionUnavailableReason;
  staticSuppressionReason?: CompletionSuppressionReason;
  argumentsResolved?: boolean;
  argumentSuppressionReason?: CompletionSuppressionReason;
};

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
  rConsoleStaticStatus?: StaticCompletionOutcome["status"];
  rConsoleBindingSuppressionReason?: CompletionSuppressionReason;
  // Applies even when filtering leaves no arguments or the definition has none.
  rConsoleRuntimeOnly?: boolean;
  rConsoleLocalFunction?: boolean;
  rConsoleWorkspaceFunction?: boolean;
  rConsoleMemberResolved?: boolean;
  rConsoleStaticUnavailableReason?: StaticCompletionUnavailableReason;
  rConsoleNativeArguments?: boolean;
  rConsoleArgumentsExhausted?: boolean;
  rConsoleArgumentsResolved?: boolean;
  rConsoleArgumentSuppressionReason?: CompletionSuppressionReason;
};

export type CompletionAnalysisMode = "runtime" | "static";

export type BindingLookup = "function" | "value" | "identity";
export type BindingScope = { kind: "search-path" } | { kind: "closure"; bindingId: string };
export type StaticBindingQuery = {
  name: string;
  lookup: BindingLookup;
  scope: BindingScope;
  depth?: number;
};
export type StaticBindingResult =
  | { status: "source"; source: string; bindingId: string; closureScope: BindingScope }
  | { status: "package" | "missing" | "not-callable" | "opaque" }
  | { status: "unavailable"; reason: "unsupported-scope" | "invalid-request" | "cancelled" | "analysis-limit" | "runtime-unavailable" }
  | { status: "suppressed"; reason: CompletionSuppressionReason };

/** Request-local capability. Each lookup independently enforces runtime safety. */
export interface GuardedBindingResolver {
  resolve(query: StaticBindingQuery): Promise<StaticBindingResult>;
  isCurrent(): boolean;
  readonly signal?: AbortSignal;
}

export type StaticCompletionAccess = {
  bindings: GuardedBindingResolver;
  runtimeRefusal?: { expression: string; reason: CompletionSuppressionReason };
};

export type StaticCompletionRequest = StaticCompletionAccess & {
  document: vscode.TextDocument;
  /** Immutable input snapshot and UTF-16 offset of the user's actual cursor. */
  input: string;
  cursor: number;
  position: vscode.Position;
  contextPosition: vscode.Position;
  triggerCharacter?: string;
  requestScope: object;
};

export type StaticCompletionOutcome =
  | { status: "resolved" | "resolved-empty"; completion: CompletionResult }
  | { status: "unresolved" | "pending"; reason: StaticCompletionUnavailableReason; completion?: CompletionResult };

export interface CompletionProvider {
  provideStaticCompletion?(request: StaticCompletionRequest): Promise<StaticCompletionOutcome>;
  // A selected package function can be qualified in the LSP projection while
  // its name remains unqualified in the visible console input.
  getCallContext?(doc: vscode.TextDocument, position: vscode.Position): CallCompletionContext | undefined;
  provideCompletionItems?(
    doc: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string,
    // Keep the user's cursor when position is moved to broaden matching.
    contextPosition?: vscode.Position,
    // Safe, already-inspected receiver class; null means no supported class.
    runtimeBracketKind?: "data.frame" | "data.table" | null,
    analysisMode?: CompletionAnalysisMode,
    // Shared only by the initial query and its prefix retry.
    requestScope?: object
  ): Promise<CompletionResult | undefined>;
}

export type RuntimeFunctionSourceTarget = "source" | "source-value" | "binding";
export type RuntimeFunctionSourceRequester = (name: string, target?: RuntimeFunctionSourceTarget) =>
  Promise<MemberInspectionResult | undefined> | undefined;

export type RuntimeFunctionArgumentsRequester = (expression: string) =>
  Promise<MemberInspectionResult | undefined> | undefined;

export type RuntimeMemberCompletionRequester = (
  expression: string,
  operator: "$" | "@" | "[" | "[["
) => Promise<
  MemberInspectionResult | undefined
> | undefined;

export type GlobalEnvItem = {
  class?: WorkspaceStrings;
  type?: string;
  length?: number;
  str?: string;
  size?: number;
  dim?: number[];
  names?: WorkspaceStrings;
  slots?: WorkspaceStrings;
};

export type WorkspaceData = {
  globalenv?: Record<string, GlobalEnvItem>;
};
