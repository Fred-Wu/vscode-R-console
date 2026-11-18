import type { CompletionContext } from "./types";
import { getCompletionSyntax } from "./contextParser";

function isPipePlaceholder(name: string): boolean {
  return name === "_" || name === ".";
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
      bracketArgumentTags: bracket.argumentTags,
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

