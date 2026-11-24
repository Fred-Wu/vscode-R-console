import type { CompletionContext } from "./types";
import { TokenType, isAccessorNamePrefix } from "../lexer";
import { decodeQuotedCompletionPrefix, getCompletionSyntax, getQualifiedCompletionContext } from "./contextParser";
import { parseRuntimeMemberQuery } from "./runtimeMembers";

function isPipePlaceholder(name: string): boolean {
  return name === "_" || name === ".";
}

/** An unfinished subscript on an unsupported receiver must not fall back
 * to unrelated global symbols. Valid bracket contexts return earlier.
 */
function hasUnsupportedBracketReceiver(before: string, tokens: ReturnType<typeof getCompletionSyntax>["prefixTokens"]): boolean {
  if (!before.includes("[")) return false;
  const openings: { delimiter: string; position: number }[] = [];
  const matching: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const token of tokens) {
    if (token.type === TokenType.LeftBracket || token.type === TokenType.LeftParen ||
        token.type === TokenType.LeftBrace) {
      for (const delimiter of token.value) openings.push({ delimiter, position: token.position });
    } else if (token.type === TokenType.RightBracket || token.type === TokenType.RightParen ||
        token.type === TokenType.RightBrace) {
      for (const delimiter of token.value) {
        if (openings.pop()?.delimiter !== matching[delimiter]) return false;
      }
    }
  }
  const active = openings.at(-1);
  if (active?.delimiter !== "[") return false;
  // Resolve only the receiver, excluding enclosing calls, assignments and
  // earlier statements. The synthetic accessor is parsed, never evaluated.
  const receiver = getQualifiedCompletionContext(before.slice(0, active.position) + "$");
  return !receiver || parseRuntimeMemberQuery(receiver.objectName) === undefined;
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
  const dataObjectName = syntax.dataObject;
  // Completion starts are columns in the current line. A literal name begun
  // on an earlier line cannot be represented by that edit contract; suppress
  // it rather than letting the terminal clamp a negative column and corrupt
  // the name. Escaped newlines within a single source line remain supported.
  const outsideLine = (): CompletionContext => ({
    kind: "default", suppressAutomatic: true, prefix: "", replaceStart: beforeCursor.length,
    snapshotInput, snapshotCursor,
  });

  const member = syntax.member;
  if (member) {
    if (member.replaceStart < relativeOffset) return outsideLine();
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
    const isPlaceholderMember = member.hasSubscript && operator === "$" &&
      isPipePlaceholder(member.baseObject) && !!dataObjectName;
    return {
      kind: "member",
      ...(member.hasSubscript && !parseRuntimeMemberQuery(member.objectName) ?
        { rejectionReason: "executable-receiver" as const } : {}),
      autoTrigger: true,
      prefix,
      replaceStart,
      ...replacement,
      triggerCharacter: prefix.length === 0 ? operator : undefined,
      objectName: isPlaceholderMember
        ? dataObjectName + member.objectName.slice(member.baseObject.length) : member.objectName,
      indexedObject: member.hasSubscript,
      operator,
      dataObjectName: isPlaceholderMember ? dataObjectName : undefined,
      snapshotInput,
      snapshotCursor,
    };
  }

  // Without this guard, explicit Tab after make_object()$ treats the
  // unsupported member receiver as a default/global completion request.
  const memberSuffix = syntax.memberSuffix;
  if (memberSuffix) {
    if (memberSuffix.replaceStart < relativeOffset) return outsideLine();
    return {
      kind: "member",
      prefix: memberSuffix.prefix,
      replaceStart: memberSuffix.replaceStart - relativeOffset,
      ...replacement,
      operator: memberSuffix.operator,
      autoTrigger: true,
      triggerCharacter: memberSuffix.prefix ? undefined : memberSuffix.operator,
      rejectionReason: "executable-receiver",
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
      ...(bracket.objectName.includes("[") && !parseRuntimeMemberQuery(bracket.objectName) ?
        { rejectionReason: "executable-receiver" as const } : {}),
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
      bracketArgumentName: bracket.argumentName,
      dataObjectName: effectiveDataObject,
      operator: undefined,
      snapshotInput,
      snapshotCursor,
    };
  }

  // If the bracket parser refused an executable receiver, do not reinterpret
  // its unfinished index as an unrelated global-symbol completion.
  if (!inLiteral && hasUnsupportedBracketReceiver(textForDataContext, syntax.prefixTokens)) {
    return {
      kind: "member",
      prefix: "",
      replaceStart: beforeCursor.length,
      rejectionReason: "executable-receiver",
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

  const wordMatch = /([\p{L}\p{Nl}._][\p{L}\p{Nl}\p{Nd}._]*)$/u.exec(beforeCursor);

  if (!wordMatch) {
    if (dataObjectName || inLiteral) {
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


/**
 * Static inference is allowed to parse an executable receiver but must never
 * submit it to the guarded live inspector. Preserve the member/[[ context
 * rejected by the runtime grammar instead of reinterpreting it as a global
 * symbol prefix.
 */
export function getStaticFallbackContext(
  inputBuffer: string, cursorPosition: number,
  fullTextBeforeCursor?: string,
  textAfterCursor = inputBuffer.slice(cursorPosition),
  runtime = getCompletionContext(inputBuffer, cursorPosition, fullTextBeforeCursor, textAfterCursor)
): CompletionContext | undefined {
  // Quoted indices on executable receivers may look like ordinary string
  // literals to the strict runtime parser, which must still reject inspection.
  const quotedIndex = runtime?.suppressAutomatic && (fullTextBeforeCursor ?? inputBuffer.slice(0, cursorPosition)).includes("[");
  if (!runtime?.rejectionReason && !quotedIndex) return undefined;
  if (runtime?.rejectionReason && runtime.kind === "member" &&
      runtime.operator) {
    return { ...runtime, rejectionReason: undefined, staticFallback: true };
  }
  const localBefore = inputBuffer.slice(0, cursorPosition);
  const before = fullTextBeforeCursor ?? localBefore;
  const shift = before.length - localBefore.length;
  const fullText = before + textAfterCursor;
  const syntax = getCompletionSyntax(fullText, before.length);
  const identifierEnd = syntax.identifierEnd;
  const replacement = identifierEnd === undefined ? {} : { replaceEnd: identifierEnd - shift };
  const tokens = syntax.prefixTokens.filter(token =>
    token.type !== TokenType.EOF && token.type !== TokenType.Comment && token.type !== TokenType.Newline);
  const end = tokens.at(-1);
  const identifier = end && isAccessorNamePrefix(end) &&
    end.position + end.value.length === before.length ? end : undefined;
  // The runtime bracket parser intentionally rejects callable/computed
  // receivers. For LSP only, locate the active bracket without resolving it.
  const frames: Array<{ value: string; start: number; operator?: "[" | "[[" }> = [];
  for (const token of tokens) {
    if (token.type === TokenType.LeftParen || token.type === TokenType.LeftBrace ||
        token.type === TokenType.LeftBracket) {
      for (const value of token.value) frames.push({ value, start: token.position,
        ...(token.type === TokenType.LeftBracket
          ? { operator: token.value as "[" | "[[" } : {}) });
    } else if (token.type === TokenType.RightParen || token.type === TokenType.RightBrace ||
               token.type === TokenType.RightBracket) {
      for (const value of token.value) {
        const expected = value === ")" ? "(" : value === "}" ? "{" : "[";
        if (frames.pop()?.value !== expected) return undefined;
      }
    }
  }
  const active = frames.at(-1);
  if (!active?.operator || active.start === 0) return undefined;
  const keyStart = active.start + active.operator.length;
  // A key prefix occupies the first slot by itself. Operators, tags and
  // dimension separators belong to an expression rather than a member name.
  if (tokens.filter(token => token.position >= keyStart).length > 1) return undefined;
  const tail = before.slice(keyStart);
  let prefix = "";
  let quote: "\"" | "'" | undefined;
  let replaceStart = before.length - shift;
  if (identifier && identifier.position >= active.start + active.operator.length) {
    prefix = identifier.value;
    replaceStart = identifier.position - shift;
  } else if (end?.type === TokenType.String && end.closed === false &&
             end.position >= active.start + active.operator.length &&
             (end.value.startsWith("'") || end.value.startsWith('"'))) {
    quote = end.value[0] as "\"" | "'";
    prefix = decodeQuotedCompletionPrefix(quote, end.value.slice(1));
    replaceStart = end.position + 1 - shift;
  } else if (tail.trim().length !== 0) {
    // Do not suggest members inside an index expression or after a comma.
    return undefined;
  }
  if (replaceStart < 0) return undefined;
  // A completed quote after the cursor is part of the original source and
  // must not be replaced when inserting a member name.
  const stringToken = quote ? syntax.tokens.find(token =>
    token.position === end?.position && token.type === TokenType.String) : undefined;
  const quotedEnd = stringToken?.closed ? stringToken.position + stringToken.value.length - 1 - shift : undefined;
  return {
    kind: "bracket", prefix, replaceStart, ...replacement,
    ...(quotedEnd === undefined ? {} : { replaceEnd: quotedEnd }),
    autoTrigger: true,
    bracketOperator: active.operator, bracketQuote: quote,
    triggerCharacter: prefix ? undefined : "[",
    snapshotInput: inputBuffer, snapshotCursor: cursorPosition,
    staticFallback: true,
  };
}

/** Presentation hints never decide whether a static provider can analyze input. */
export function getStaticCompletionContext(
  inputBuffer: string, cursorPosition: number, fullTextBeforeCursor?: string,
  textAfterCursor = inputBuffer.slice(cursorPosition),
  runtime = getCompletionContext(inputBuffer, cursorPosition, fullTextBeforeCursor, textAfterCursor)
): CompletionContext {
  if (runtime && !runtime.rejectionReason && !runtime.suppressAutomatic) return runtime;
  if (!(fullTextBeforeCursor ?? inputBuffer.slice(0, cursorPosition)).trim()) return {
    kind: "default", prefix: "", replaceStart: cursorPosition,
    snapshotInput: inputBuffer, snapshotCursor: cursorPosition,
  };
  const known = getStaticFallbackContext(inputBuffer, cursorPosition, fullTextBeforeCursor, textAfterCursor, runtime);
  if (known) return known;
  // The search UI needs a lexical prefix even when receiver semantics are
  // unknown. These hints never authorize runtime inspection or inferred edits.
  const before = fullTextBeforeCursor ?? inputBuffer.slice(0, cursorPosition);
  const shift = before.length - cursorPosition;
  const token = getCompletionSyntax(before + textAfterCursor, before.length).prefixTokens
    .filter(token => token.type !== TokenType.EOF).at(-1);
  let prefix = "", replaceStart = cursorPosition;
  let bracketQuote: "\"" | "'" | undefined;
  if (token && token.position >= shift && token.position + token.value.length === before.length) {
    if (token.type === TokenType.String && !token.closed && /^["']/.test(token.value)) {
      bracketQuote = token.value[0] as "\"" | "'";
      prefix = decodeQuotedCompletionPrefix(bracketQuote, token.value.slice(1));
      replaceStart = token.position + 1 - shift;
    } else if (isAccessorNamePrefix(token)) {
      prefix = token.value.startsWith("`")
        ? decodeQuotedCompletionPrefix("`", token.value.slice(1, token.closed === true ? -1 : undefined)) : token.value;
      replaceStart = token.position - shift;
    }
  }
  return {
    kind: "static", staticFallback: true, prefix, replaceStart, bracketQuote,
    snapshotInput: inputBuffer, snapshotCursor: cursorPosition,
  };
}
