// Live-session fallback only: languageserver 0.3.22 has no data-mask provider
// for with/subset/dplyr, as verified by native protocol integration tests.
// Native scope fields, when available, suppress this fallback's runtime probes.
import { TokenType, tokenize, continuesExpressionLine, isNameAccessor, isCompleteIdentifier, type Token } from "../lexer";
import type { QualifiedCompletionContext } from "./contextParser";

const DATA_MASK_PACKAGES: Record<string, string> = {
  with: "base", subset: "base", transform: "base", within: "base",
  mutate: "dplyr", filter: "dplyr", select: "dplyr", summarize: "dplyr",
  summarise: "dplyr", arrange: "dplyr", group_by: "dplyr",
};
const DATA_MASK_ARGUMENTS: Record<string, string> = {
  with: "data", within: "data", subset: "x", transform: "_data",
};

/** Resolve only active data scopes. Completed calls and earlier statements
 * cannot contribute columns; delimiters in literals and comments are inert. */
export function getDataCompletionObject(code: string, sourceTokens: Token[], getQualifiedCompletionContext: (code: string, tokens: Token[]) => QualifiedCompletionContext | undefined): string | undefined {
  type Frame = { opening?: string; index: number; dataArgument?: string; pipe?: number; pipeInput?: number };
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
      const accessor = tokens[index - 2];
      const qualified = isNameAccessor(accessor);
      const masksData = !!call && Object.hasOwn(DATA_MASK_PACKAGES, call) &&
        (!qualified || ((accessor.value === "::" || accessor.value === ":::") &&
          head === index - 3 && tokens[head].value === DATA_MASK_PACKAGES[call]));
      const operator = tokens[head - 1];
      const pipeInput = call && operator?.type === TokenType.Operator && (operator.value === "|>" || operator.value === "%>%")
        ? frame.pipe : undefined;
      for (const opening of token.value) frames.push({ opening, index,
        dataArgument: masksData ? DATA_MASK_ARGUMENTS[call!] ?? ".data" : undefined, pipeInput });
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
  const ordinaryCallPipes = new Set<number>();
  for (const frame of frames.reverse()) {
    if (frame.pipe !== undefined && !ordinaryCallPipes.has(frame.pipe)) {
      return objectBefore(frame.pipe);
    }
    // A direct pipe target receives its data before explicitly written
    // arguments. A nested data-mask call can establish its own object instead.
    if (frame.pipeInput !== undefined) {
      if (frame.dataArgument) return objectBefore(frame.pipeInput);
      // Passing an object as the first argument does not expose its columns.
      ordinaryCallPipes.add(frame.pipeInput);
    }
    if (frame.opening === "[") {
      const previous = tokens[frame.index - 1];
      const placeholder = previous?.type === TokenType.Identifier &&
        (previous.value === "_" || previous.value === ".") && !isNameAccessor(tokens[frame.index - 2]);
      if (placeholder) continue;
      const object = objectBefore(tokens[frame.index].position);
      return object;
    }
    if (frame.dataArgument) {
      let start = frame.index + 1, depth = 0;
      let positional: Token[] | undefined, named: Token[] | undefined;
      for (let index = start; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.type === TokenType.Comma && depth === 0) {
          const argument = tokens.slice(start, index);
          if (argument[1]?.type === TokenType.Operator && argument[1].value === "=") {
            if (argument[0].value.replace(/^[`"']|[`"']$/g, "") === frame.dataArgument) named = argument.slice(2);
          } else positional ??= argument;
          start = index + 1;
        } else if ([TokenType.LeftParen, TokenType.LeftBracket, TokenType.LeftBrace].includes(token.type)) depth += token.value.length;
        else if ([TokenType.RightParen, TokenType.RightBracket, TokenType.RightBrace].includes(token.type)) depth -= token.value.length;
      }
      const argument = named ?? positional;
      if (argument?.length) {
        const first = argument[0].position, last = argument.at(-1)!;
        const expression = code.slice(first, last.position + last.value.length);
        const object = getQualifiedCompletionContext(expression + "$",
          [...argument.map(token => ({ ...token, position: token.position - first })),
            { type: TokenType.Operator, value: "$", position: expression.length }]);
        // Only a whole receiver is safe: never use the suffix of f() or a + b.
        const receiverTokens = object && tokenize(object.objectName)
          .filter(token => token.type !== TokenType.Newline && token.type !== TokenType.Comment && token.type !== TokenType.EOF);
        if (object && receiverTokens?.length === argument.length &&
            receiverTokens.every((token, index) => token.value === argument[index].value)) {
          return object.hasSubscript ? object.baseObject : object.objectName;
        }
        return undefined;
      }
    }
  }
  return undefined;
}

