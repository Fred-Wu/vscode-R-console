// Live-session fallback only: languageserver 0.3.22 has no data-mask provider
// for with/subset/dplyr, as verified by native protocol integration tests.
// Native scope fields, when available, suppress this fallback's runtime probes.
import { TokenType, continuesExpressionLine, isNameAccessor, isCompleteIdentifier, type Token } from "../lexer";
import type { QualifiedCompletionContext } from "./contextParser";

const DATA_MASK_FUNCTIONS = new Set([
  "with", "subset", "transform", "within", "mutate", "filter", "select",
  "summarize", "summarise", "arrange", "group_by",
]);

/** Resolve only active data scopes. Completed calls and earlier statements
 * cannot contribute columns; delimiters in literals and comments are inert. */
export function getDataCompletionObject(code: string, sourceTokens: Token[], getQualifiedCompletionContext: (code: string, tokens: Token[]) => QualifiedCompletionContext | undefined): string | undefined {
  type Frame = { opening?: string; index: number; call?: string; pipe?: number; pipeInput?: number };
  const frames: Frame[] = [{ index: -1 }];
  const tokens: Token[] = [];
  let lineBreak = false;
  for (const token of sourceTokens) {
    if (token.type === TokenType.EOF) break;
    if (token.type === TokenType.Comment) continue;
    if (token.type === TokenType.Newline) { lineBreak = true; continue; }
    const frame = frames.at(-1)!;
    const previous = tokens.at(-1);
    const continues = continuesExpressionLine(lineBreak, frame.opening, previous);
    if (!continues) frame.pipe = undefined;
    lineBreak = false;
    const index = tokens.length;
    tokens.push(token);
    if (token.type === TokenType.Operator && (token.value === "|>" || token.value === "%>%")) {
      frame.pipe ??= token.position;
    } else if (token.type === TokenType.Comma || token.type === TokenType.Semicolon) {
      frame.pipe = undefined;
    } else if ([TokenType.LeftParen, TokenType.LeftBracket, TokenType.LeftBrace].includes(token.type)) {
      const call = token.type === TokenType.LeftParen && continues && previous?.type === TokenType.Identifier
        ? previous.value : undefined;
      let head = index - 1;
      if (call) while (head >= 2 && isNameAccessor(tokens[head - 1]) && isCompleteIdentifier(tokens[head - 2])) head -= 2;
      const operator = tokens[head - 1];
      const pipeInput = call && operator?.type === TokenType.Operator && (operator.value === "|>" || operator.value === "%>%")
        ? frame.pipe : undefined;
      for (const opening of token.value) frames.push({ opening, index, call, pipeInput });
    } else if ([TokenType.RightParen, TokenType.RightBracket, TokenType.RightBrace].includes(token.type)) {
      for (const closing of token.value) {
        if (frames.length === 1 || frames.pop()?.opening !== ({ ")": "(", "]": "[", "}": "{" }[closing])) return undefined;
      }
    }
  }
  if (lineBreak && !continuesExpressionLine(true, frames.at(-1)?.opening, tokens.at(-1))) {
    frames.at(-1)!.pipe = undefined;
  }
  const objectBefore = (position: number): string | undefined => {
    const object = getQualifiedCompletionContext(code.slice(0, position) + "$", [
      ...sourceTokens.filter(token => token.position < position && token.type !== TokenType.EOF),
      { type: TokenType.Operator, value: "$", position },
    ]);
    // Preserve the base object's columns after subsetting without evaluating
    // index expressions just to produce suggestions.
    return object?.hasSubscript ? object.baseObject : object?.objectName;
  };
  for (const frame of frames.reverse()) {
    if (frame.pipe !== undefined) {
      return objectBefore(frame.pipe);
    }
    // A direct pipe target receives its data before explicitly written
    // arguments. A nested data-mask call can establish its own object instead.
    if (frame.pipeInput !== undefined) return objectBefore(frame.pipeInput);
    if (frame.opening === "[") {
      const previous = tokens[frame.index - 1];
      const placeholder = previous?.type === TokenType.Identifier &&
        (previous.value === "_" || previous.value === ".") && !isNameAccessor(tokens[frame.index - 2]);
      if (placeholder) continue;
      const object = objectBefore(tokens[frame.index].position);
      return object;
    }
    if (frame.call && DATA_MASK_FUNCTIONS.has(frame.call)) {
      const argument = tokens[frame.index + 1];
      if (argument?.type === TokenType.Identifier && argument.closed !== false &&
          tokens[frame.index + 2]?.type === TokenType.Comma) return argument.value;
    }
  }
  return undefined;
}

