import * as vscode from "vscode";
import type { CompletionContext, CompletionEntry, CompletionEntries, RuntimeMemberCompletionRequester, WorkspaceData, GlobalEnvItem } from "./types";
import { quoteRNameIfNeeded, getFieldInsertText, quoteCompletionValue } from "./candidates";
import { subscriptArgumentExpression } from "./subscript";
import { allowsSymbolCompletions } from "./policy";

function isSessionFunction(item: GlobalEnvItem): boolean {
  return item.type === "closure" || item.type === "builtin" || item.type === "special" ||
    /^\s*function\s*\(/.test(item.str || "");
}

export function isSessionFunctionCall(context: CompletionContext, data: WorkspaceData | undefined): boolean {
  if (context.functionOperator || !context.functionName) return false;
  const globals = data?.globalenv;
  if (!globals) return false;
  if (Object.hasOwn(globals, context.functionName)) return isSessionFunction(globals[context.functionName]);
  if (!context.functionName.startsWith("`")) return false;
  return Object.entries(globals).some(([name, item]) => isSessionFunction(item) &&
    (context.functionName === name ||
      context.functionName === `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``));
}

const TOP_LEVEL_SYMBOL_PATTERN = /^[a-zA-Z._][a-zA-Z0-9._]*$/;
export function getSessionCompletions(
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

  if (!allowsSymbolCompletions(context)) {
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

export function getDataColumnCompletions(
  context: CompletionContext,
  data: WorkspaceData | undefined
): CompletionEntry[] {
  if (!context.dataObjectName || !data?.globalenv || context.bracketArgumentName) {
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

export async function getRuntimeDataCompletions(
  context: CompletionContext,
  requestRuntimeMemberCompletions?: RuntimeMemberCompletionRequester
): Promise<CompletionEntries> {
  if (!context.dataObjectName || !requestRuntimeMemberCompletions || context.bracketArgumentName) {
    return [];
  }

  try {
    if (context.kind === "bracket") {
      const items = await requestRuntimeMemberCompletions(
        `base::local({ .obj <- (${context.dataObjectName}); ` +
        `.tagged <- function(.values, .prefix) stats::setNames(base::as.list(.values), if (base::length(.values)) base::paste0(.prefix, .values) else base::character()); ` +
        `.bare <- base::inherits(.obj, "data.table"); ` +
        `.nms <- if (.bare || ${context.bracketDimensions ?? 1}L == 1L) base::names(.obj) else ` +
        `{ .dims <- base::dimnames(.obj); if (base::length(.dims) >= ${(context.bracketDimension ?? 0) + 1}L) .dims[[${(context.bracketDimension ?? 0) + 1}L]] else NULL }; ` +
        `base::c(.tagged(.nms, if (.bare) "bare:" else "quoted:"), .tagged(${subscriptArgumentExpression(context)}, "argument:")) })`, "$"
      );
      const entries: CompletionEntries = (items ?? []).flatMap(item => {
        const match = /^(bare|quoted|argument):([\s\S]+)$/.exec(item.name);
        if (!match) return [];
        const [, type, name] = match;
        return [{ label: name,
          insertText: type === "argument" ? name === "..." ? "..." : quoteRNameIfNeeded(name) + " = "
            : getFieldInsertText(name, context, type === "bare"),
          kind: type === "argument" ? vscode.CompletionItemKind.Variable : vscode.CompletionItemKind.Field,
          ...(type === "argument" ? { role: "argument" as const } : {}),
          detail: type === "argument" ? "parameter" : context.dataObjectName, source: "session" as const }];
      });
      if (items !== undefined) entries.subscriptResolved = true;
      return entries;
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

export async function getRuntimeMemberCompletions(
  context: CompletionContext,
  requestRuntimeMemberCompletions?: RuntimeMemberCompletionRequester
): Promise<CompletionEntry[] | undefined> {
  if (
    context.kind !== "member" ||
    !context.objectName ||
    !context.operator ||
    !requestRuntimeMemberCompletions
  ) {
    return undefined;
  }

  try {
    const items = await requestRuntimeMemberCompletions(
      context.objectName,
      context.operator
    );
    return items
      ?.filter((item) => typeof item.name === "string" && item.name.length > 0)
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
    return undefined;
  }
}

export async function getRuntimeArgumentCompletions(
  context: CompletionContext,
  request?: RuntimeMemberCompletionRequester
): Promise<CompletionEntries> {
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
        `base::unlist(base::lapply(base::as.list(.expr)[-1L], function(.value) { ` +
        `if (base::is.character(.value)) .value else if (base::is.call(.value) && ` +
        `base::identical(.value[[1L]], base::quote(I)) && base::length(.value) > 1L && ` +
        `base::is.character(.value[[2L]])) .value[[2L]] else NULL }), use.names = FALSE) else NULL } }; ` +
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
    const forwardedDots = context.argumentTags!.includes("...");
    const suppliedCount = context.argumentTags!.filter(tag => tag !== null && tag !== "...").length;
    const items = await request(
      `base::local({ .fn <- (${context.functionName}); .exhausted <- FALSE; ` +
      `.args <- if (base::is.function(.fn)) { ` +
      `.def <- base::args(.fn); ` +
      `.formals <- base::names(base::formals(.def)); ` +
      `.exhausted <- !base::is.null(.def) && !("..." %in% .formals) && ` +
      `${suppliedCount}L >= base::length(.formals); ` +
      `.call <- base::as.list(base::quote(.fn(${supplied}))); ` +
      `if (base::is.null(base::names(.call))) base::names(.call) <- base::rep("", base::length(.call)); ` +
      `.candidates <- base::setdiff(base::names(base::formals(.def)), base::setdiff(base::names(.call), "...")); ` +
      `.candidates[base::vapply(.candidates, function(.name) { ` +
      `if (.name == "..." || ${forwardedDots ? "TRUE" : "FALSE"}) return(TRUE); ` +
      `.candidate <- .call; base::names(.candidate)[${cursorSlot}L] <- .name; ` +
      `base::tryCatch({ base::suppressWarnings(base::match.call(` +
      `definition = .def, call = base::as.call(.candidate), expand.dots = FALSE)); TRUE }, ` +
      `error = function(e) FALSE) }, base::logical(1))] } else NULL; ` +
      // A logical dots marker denotes exhaustion; ordinary dots candidates
      // carry character values, keeping variadic signatures distinguishable.
      `if (.exhausted) stats::setNames(base::list(TRUE), "...") else stats::setNames(base::as.list(.args), .args) })`, "$"
    );
    const entries: CompletionEntries = (items ?? []).filter(item => item.name && !(item.name === "..." && item.type === "logical")).map(item => ({
      label: item.name,
      insertText: item.name === "..." ? "..." : `${quoteRNameIfNeeded(item.name)} = `,
      kind: vscode.CompletionItemKind.Variable,
      detail: "parameter",
      source: "session",
    }));
    if (items?.some(item => item.name === "..." && item.type === "logical")) entries.argumentsExhausted = true;
    return entries;
  } catch {
    return [];
  }
}

