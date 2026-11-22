import type { CompletionContext } from "./types";
import { TokenType, tokenize, isMemberAccessor } from "../lexer";
import { getCompletionSyntax, getQualifiedCompletionContext } from "./contextParser";
import { parseRuntimeMemberQuery } from "./runtimeMembers";

function isPipePlaceholder(name: string): boolean {
  return name === "_" || name === ".";
}

/** A call/expression followed by $ or @ is not a global-name completion.
 * The normal member parser handles safe receivers; suppress the ambient-name
 * fallback when it cannot resolve the receiver without evaluating draft code.
 */
function hasUnsupportedMemberReceiver(before: string): boolean {
  if (!before.includes("$") && !before.includes("@")) return false;
  const tokens = tokenize(before);
  const last = tokens.at(-2); // EOF follows the final significant token.
  if (!last) return false;
  if (isMemberAccessor(last)) {
    return before.slice(last.position + last.value.length).trim().length === 0;
  }
  const keyword = last.type === TokenType.Function || last.type === TokenType.If ||
    last.type === TokenType.Else || last.type === TokenType.For ||
    last.type === TokenType.While || last.type === TokenType.Repeat ||
    last.type === TokenType.In || last.type === TokenType.Next ||
    last.type === TokenType.Break;
  if (!(last.type === TokenType.Identifier || keyword) || last.closed === false ||
      last.position + last.value.length !== before.length) return false;
  const preceding = tokens.at(-3);
  return preceding !== undefined && isMemberAccessor(preceding) &&
    before.slice(preceding.position + preceding.value.length, last.position).trim().length === 0;
}

/** An unfinished subscript on an unsupported receiver must not fall back
 * to unrelated global symbols. Valid bracket contexts return earlier.
 */
function hasUnsupportedBracketReceiver(before: string): boolean {
  if (!before.includes("[")) return false;
  const openings: { delimiter: string; position: number }[] = [];
  const matching: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const token of tokenize(before)) {
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
  if (!inLiteral && hasUnsupportedMemberReceiver(textForDataContext)) {
    return {
      kind: "member",
      prefix: "",
      replaceStart: beforeCursor.length,
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
  if (!inLiteral && hasUnsupportedBracketReceiver(textForDataContext)) {
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

