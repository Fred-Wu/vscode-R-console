import type { CompletionContext } from "./types";
import { TokenType, tokenize, isMemberAccessor } from "../lexer";
import { getCompletionSyntax } from "./contextParser";

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
  if (last.type !== TokenType.Identifier || last.closed === false ||
      last.position + last.value.length !== before.length) return false;
  const preceding = tokens.at(-3);
  return preceding !== undefined && isMemberAccessor(preceding) &&
    before.slice(preceding.position + preceding.value.length, last.position).trim().length === 0;
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
      suppressAutomatic: true,
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
      bracketArgumentName: bracket.argumentName,
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

