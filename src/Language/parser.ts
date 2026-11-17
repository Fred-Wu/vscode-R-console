export type NativeParseCallback = (code: string) => Promise<number>;

type LocalParseClassification = "complete" | "incomplete" | "unknown";

export function stripCommentLines(code: string): string {
  const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const strippedLines = new Set<number>();
  for (const token of tokenize(normalized)) {
    if (token.type !== TokenType.Comment) {
      continue;
    }
    const lineIndex = findLineIndex(lineStarts, token.position);
    if (lineIndex < 0) {
      continue;
    }
    const lineStart = lineStarts[lineIndex];
    if (normalized.slice(lineStart, token.position).trim().length === 0) {
      strippedLines.add(lineIndex);
    }
  }

  return lines.filter((_, index) => !strippedLines.has(index)).join("\n");
}

function findLineIndex(lineStarts: readonly number[], position: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = lineStarts[mid];
    const nextStart = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.POSITIVE_INFINITY;

    if (position < start) {
      high = mid - 1;
    } else if (position >= nextStart) {
      low = mid + 1;
    } else {
      return mid;
    }
  }

  return -1;
}

enum TokenType {
  Number,
  String,
  RawString,
  Identifier,

  Function,
  If,
  Else,
  For,
  While,
  Repeat,
  In,
  Next,
  Break,

  Operator,

  LeftParen,
  RightParen,
  LeftBrace,
  RightBrace,
  LeftBracket,
  RightBracket,

  Comma,
  Semicolon,
  Comment,
  Newline,
  Unknown,

  EOF,
}

interface Token {
  type: TokenType;
  value: string;
  position: number;
  closed?: boolean;
}

export type CallCompletionContext = {
  // Callable source reconstructed from tokens, without inter-token whitespace
  // or comments. Quoted identifiers retain their spelling and escapes.
  name: string;
  operator?: "$" | "@" | "::" | ":::";
  // R source tags; "" denotes a positional argument and null the cursor's slot. Undefined
  // means the cursor is in a value, comment, or another non-name position.
  argumentTags?: (string | null)[];
};

function continuesCallLine(lineBreak: boolean, parent: string | undefined, previous?: Token): boolean {
  return !lineBreak || parent === "(" || parent === "[" || previous?.type === TokenType.Operator;
}

/** Map callable-name ends to their opening parentheses in one lexical pass.
 * A newline inside a brace or at top level ends the statement; comments do
 * not change that rule. Used by both insertion and LSP package projection. */
export function getCallOpenings(code: string): Map<number, number> {
  const openings = new Map<number, number>();
  const stack: string[] = [];
  let previous: Token | undefined;
  let lineBreak = false;
  for (const token of tokenize(code)) {
    if (token.type === TokenType.Comment) continue;
    if (token.type === TokenType.Newline) {
      lineBreak = true;
      continue;
    }
    if (token.type === TokenType.LeftParen && previous?.type === TokenType.Identifier &&
        continuesCallLine(lineBreak, stack.at(-1), previous)) {
      openings.set(previous.position + previous.value.length, token.position);
    }
    if (token.type === TokenType.LeftParen || token.type === TokenType.LeftBrace || token.type === TokenType.LeftBracket) {
      stack.push(...token.value);
    } else if (token.type === TokenType.RightParen || token.type === TokenType.RightBrace || token.type === TokenType.RightBracket) {
      for (const closing of token.value) {
        const expected = closing === ")" ? "(" : closing === "}" ? "{" : "[";
        if (stack.pop() !== expected) return openings;
      }
    }
    previous = token;
    lineBreak = false;
  }
  return openings;
}

/** Inspect syntax without evaluating argument expressions or searching source
 * text for a callable suffix. Each token is visited a constant number of times. */
export function getEnclosingCall(code: string, cursor = code.length): CallCompletionContext | undefined {
  const tokens: Token[] = [];
  const lineBreaks = new Set<number>();
  let inComment = false;
  for (const token of tokenize(code)) {
    if (token.type === TokenType.Comment) {
      inComment ||= token.position < cursor && cursor <= token.position + token.value.length;
    } else if (token.type === TokenType.Newline) {
      lineBreaks.add(tokens.length);
    } else if (token.type !== TokenType.EOF) {
      tokens.push(token);
    }
  }
  const stack: { opening: string; index: number }[] = [];
  for (let index = 0; index < tokens.length && tokens[index].position < cursor; index++) {
    const token = tokens[index];
    if (token.type === TokenType.LeftParen || token.type === TokenType.LeftBrace || token.type === TokenType.LeftBracket) {
      for (const opening of token.value.slice(0, cursor - token.position)) {
        stack.push({ opening, index });
      }
    } else if (token.type === TokenType.RightParen || token.type === TokenType.RightBrace || token.type === TokenType.RightBracket) {
      for (const closing of token.value.slice(0, cursor - token.position)) {
        const expected = closing === ")" ? "(" : closing === "}" ? "{" : "[";
        if (stack.pop()?.opening !== expected) return undefined;
      }
    }
  }
  const frame = stack.at(-1);
  if (frame?.opening !== "(") return undefined;
  // Parentheses and subscripts allow continuation across newlines; a brace
  // starts a statement context even when it is itself inside parentheses.
  const parent = stack.at(-2)?.opening;
  const continuesLine = (index: number): boolean =>
    continuesCallLine(lineBreaks.has(index), parent, tokens[index - 1]);
  let start = frame.index - 1;
  const last = tokens[start];
  if (last?.type !== TokenType.Identifier || !continuesLine(frame.index)) return undefined;
  let operator: CallCompletionContext["operator"];
  while (start >= 1) {
    const previous = tokens[start - 1];
    if (previous.type !== TokenType.Operator ||
        !["$", "@", "::", ":::"].includes(previous.value)) break;
    if (tokens[start - 2]?.type !== TokenType.Identifier ||
        !continuesLine(start) || !continuesLine(start - 1)) return undefined;
    operator ??= previous.value as CallCompletionContext["operator"];
    start -= 2;
  }
  // Inspect only this call's top-level arguments, including those after the
  // cursor. Nested commas and equals signs belong to their own expressions.
  const argumentTags: (string | null)[] = [];
  const pipe = tokens[start - 1]?.type === TokenType.Operator && continuesLine(start)
    ? tokens[start - 1].value : undefined;
  const piped = pipe === "|>" || pipe === "%>%";
  let hasPipePlaceholder = false;
  let namePosition = false;
  let hasDots = false;
  let argumentStart = frame.index + 1;
  let argumentOffset = tokens[frame.index].position + 1;
  const collectArgument = (end: number, endOffset: number): void => {
    const first = tokens[argumentStart];
    const second = tokens[argumentStart + 1];
    const named = argumentStart + 1 < end &&
      (first.type === TokenType.Identifier || first.type === TokenType.String || first.type === TokenType.RawString) &&
      second.type === TokenType.Operator && second.value === "=";
    const valueStart = argumentStart + (named ? 2 : 0);
    if (argumentOffset <= cursor && cursor <= endOffset) {
      argumentTags.push(null);
      namePosition = argumentStart === end || (
        argumentStart + 1 === end && first.type === TokenType.Identifier &&
        !first.value.startsWith("`") && first.value !== "..." &&
        first.position < cursor && first.position + first.value.length === cursor
      );
    } else {
      // Only a supplied direct placeholder replaces implicit insertion. A
      // prefix in the cursor slot will be replaced by the selected argument.
      // In magrittr, nested uses such as f(g(.)) still insert a first argument.
      const value = tokens[valueStart];
      hasPipePlaceholder ||= piped && valueStart + 1 === end && value?.type === TokenType.Identifier &&
        (pipe === "|>" ? value.value === "_" : value.value === "." || value.value === "`.`");
      argumentTags.push(named ? first.value : "");
      // Forwarded dots cannot be matched without inspecting the caller's frame.
      hasDots ||= argumentStart + 1 === end && first.value === "...";
    }
  };
  const nested: string[] = [];
  for (let index = argumentStart; index <= tokens.length; index++) {
    const token = tokens[index];
    if (!token || (nested.length === 0 && token.type === TokenType.RightParen)) {
      collectArgument(index, token?.position ?? code.length);
      break;
    }
    if (nested.length === 0 && token.type === TokenType.Comma) {
      collectArgument(index, token.position);
      argumentStart = index + 1;
      argumentOffset = token.position + 1;
    } else if (token.type === TokenType.LeftParen || token.type === TokenType.LeftBrace || token.type === TokenType.LeftBracket) {
      nested.push(...token.value);
    } else if (token.type === TokenType.RightParen || token.type === TokenType.RightBrace || token.type === TokenType.RightBracket) {
      for (const closing of token.value) {
        const expected = closing === ")" ? "(" : closing === "}" ? "{" : "[";
        if (nested.pop() !== expected) return undefined;
      }
    }
  }
  if (piped && !hasPipePlaceholder) argumentTags.unshift("");
  return {
    name: tokens.slice(start, frame.index).map(token => token.value).join(""),
    operator,
    argumentTags: namePosition && !inComment && !hasDots ? argumentTags : undefined,
  };
}

export type HighlightTokenKind =
  | "comment"
  | "string"
  | "number"
  | "namespace"
  | "function"
  | "identifier"
  | "keyword"
  | "operator";

export interface HighlightToken {
  kind: HighlightTokenKind;
  value: string;
  position: number;
}

const KEYWORDS = new Map<string, TokenType>([
  ["function", TokenType.Function],
  ["if", TokenType.If],
  ["else", TokenType.Else],
  ["for", TokenType.For],
  ["while", TokenType.While],
  ["repeat", TokenType.Repeat],
  ["in", TokenType.In],
  ["next", TokenType.Next],
  ["break", TokenType.Break],
]);

const NUMERIC_CONSTANTS = new Set([
  "TRUE",
  "FALSE",
  "NA",
  "NA_integer_",
  "NA_real_",
  "NA_complex_",
  "NA_character_",
  "Inf",
  "NaN",
]);

const MULTI_CHAR_OPS = [
  "<<-",
  "->>",
  "<-",
  "->",
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "%%",
  "|>",
  ":::",
  "::",
];

const SINGLE_CHAR_OPS = new Set([
  "+",
  "-",
  "*",
  "/",
  "^",
  "&",
  "|",
  "!",
  "<",
  ">",
  "=",
  "~",
  "$",
  "@",
  ":",
  "?",
  "\\",
]);

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < code.length) {
    const ch = code[pos];

    if (ch === " " || ch === "\t" || ch === "\r") {
      pos += 1;
      continue;
    }

    if (ch === "\n") {
      tokens.push({ type: TokenType.Newline, value: "\n", position: pos });
      pos += 1;
      continue;
    }

    if (ch === "#") {
      const start = pos;
      while (pos < code.length && code[pos] !== "\n") {
        pos += 1;
      }
      tokens.push({ type: TokenType.Comment, value: code.slice(start, pos), position: start });
      continue;
    }

    if ((ch === "r" || ch === "R") && pos + 1 < code.length) {
      const quote = code[pos + 1];
      if (quote === "\"" || quote === "'") {
        const result = parseRawString(code, pos);
        if (result) {
          tokens.push(result.token);
          pos = result.newPos;
          continue;
        }
      }
    }

    if (ch === "\"" || ch === "'") {
      const result = parseString(code, pos, ch);
      tokens.push(result.token);
      pos = result.newPos;
      continue;
    }

    if (ch === "`") {
      const result = parseBacktickIdentifier(code, pos);
      tokens.push(result.token);
      pos = result.newPos;
      continue;
    }

    if (isDigit(ch) || (ch === "." && pos + 1 < code.length && isDigit(code[pos + 1]))) {
      const result = parseNumber(code, pos);
      tokens.push(result.token);
      pos = result.newPos;
      continue;
    }

    if (isIdentStart(ch)) {
      const result = parseIdentifier(code, pos);
      tokens.push(result.token);
      pos = result.newPos;
      continue;
    }

    if (ch === "%") {
      const result = parseSpecialOperator(code, pos);
      tokens.push(result.token);
      pos = result.newPos;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: TokenType.LeftParen, value: "(", position: pos });
      pos += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: TokenType.RightParen, value: ")", position: pos });
      pos += 1;
      continue;
    }
    if (ch === "{") {
      tokens.push({ type: TokenType.LeftBrace, value: "{", position: pos });
      pos += 1;
      continue;
    }
    if (ch === "}") {
      tokens.push({ type: TokenType.RightBrace, value: "}", position: pos });
      pos += 1;
      continue;
    }
    if (ch === "[") {
      if (pos + 1 < code.length && code[pos + 1] === "[") {
        tokens.push({ type: TokenType.LeftBracket, value: "[[", position: pos });
        pos += 2;
      } else {
        tokens.push({ type: TokenType.LeftBracket, value: "[", position: pos });
        pos += 1;
      }
      continue;
    }
    if (ch === "]") {
      if (pos + 1 < code.length && code[pos + 1] === "]") {
        tokens.push({ type: TokenType.RightBracket, value: "]]", position: pos });
        pos += 2;
      } else {
        tokens.push({ type: TokenType.RightBracket, value: "]", position: pos });
        pos += 1;
      }
      continue;
    }

    if (ch === ",") {
      tokens.push({ type: TokenType.Comma, value: ",", position: pos });
      pos += 1;
      continue;
    }

    if (ch === ";") {
      tokens.push({ type: TokenType.Semicolon, value: ";", position: pos });
      pos += 1;
      continue;
    }

    let foundOp = false;
    for (const op of MULTI_CHAR_OPS) {
      if (code.slice(pos, pos + op.length) === op) {
        tokens.push({ type: TokenType.Operator, value: op, position: pos });
        pos += op.length;
        foundOp = true;
        break;
      }
    }
    if (foundOp) {
      continue;
    }

    if (SINGLE_CHAR_OPS.has(ch)) {
      tokens.push({ type: TokenType.Operator, value: ch, position: pos });
      pos += 1;
      continue;
    }

    tokens.push({ type: TokenType.Unknown, value: ch, position: pos });
    pos += 1;
  }

  tokens.push({ type: TokenType.EOF, value: "", position: pos });
  return tokens;
}

export function tokenizeForHighlighting(code: string): HighlightToken[] {
  const tokens = tokenize(code);

  return tokens
    .map<HighlightToken | undefined>((token, index) => {
      switch (token.type) {
        case TokenType.Comment:
          return { kind: "comment", value: token.value, position: token.position };
        case TokenType.String:
        case TokenType.RawString:
          return { kind: "string", value: token.value, position: token.position };
        case TokenType.Number:
          return { kind: "number", value: token.value, position: token.position };
        case TokenType.Identifier:
          return {
            kind: getIdentifierHighlightKind(tokens, index),
            value: token.value,
            position: token.position,
          };
        case TokenType.Function:
        case TokenType.If:
        case TokenType.Else:
        case TokenType.For:
        case TokenType.While:
        case TokenType.Repeat:
        case TokenType.In:
        case TokenType.Next:
        case TokenType.Break:
          return { kind: "keyword", value: token.value, position: token.position };
        case TokenType.Operator:
          return {
            kind: token.value === "\\" ? "keyword" : "operator",
            value: token.value,
            position: token.position,
          };
        default:
          return undefined;
      }
    })
    .filter((token): token is HighlightToken => token !== undefined);
}

function getIdentifierHighlightKind(
  tokens: readonly Token[],
  index: number
): Extract<HighlightTokenKind, "namespace" | "function" | "identifier"> {
  const namespaceOperator = tokens[index + 1];
  const namespaceMember = tokens[index + 2];
  if (
    namespaceOperator?.type === TokenType.Operator &&
    (namespaceOperator.value === "::" || namespaceOperator.value === ":::") &&
    namespaceMember?.type === TokenType.Identifier
  ) {
    return "namespace";
  }

  const nextToken = findNextMeaningfulToken(tokens, index);
  return nextToken?.type === TokenType.LeftParen ? "function" : "identifier";
}

function findNextMeaningfulToken(
  tokens: readonly Token[],
  index: number
): Token | undefined {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (!token) {
      continue;
    }
    if (
      token.type === TokenType.Comment ||
      token.type === TokenType.Newline ||
      token.type === TokenType.EOF
    ) {
      continue;
    }
    return token;
  }
  return undefined;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "." ||
    ch === "_"
  );
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function parseString(code: string, pos: number, quote: string): { token: Token; newPos: number } {
  const start = pos;
  pos += 1;

  while (pos < code.length) {
    const ch = code[pos];
    if (ch === quote) {
      pos += 1;
      return {
        token: { type: TokenType.String, value: code.slice(start, pos), position: start },
        newPos: pos,
      };
    }
    if (ch === "\\" && pos + 1 < code.length) {
      pos += 2;
      continue;
    }
    pos += 1;
  }

  return {
    token: { type: TokenType.String, value: code.slice(start, pos), position: start },
    newPos: pos,
  };
}

function parseRawString(
  code: string,
  pos: number
): { token: Token; newPos: number } | null {
  const start = pos;
  const quote = code[pos + 1];
  pos += 2;
  const dashStart = pos;
  while (code[pos] === "-") pos++;
  const delimiter = code[pos];
  if (delimiter !== "(" && delimiter !== "[" && delimiter !== "{") return null;
  const closing = (delimiter === "(" ? ")" : delimiter === "[" ? "]" : "}") +
    code.slice(dashStart, pos) + quote;
  const end = code.indexOf(closing, pos + 1);
  pos = end < 0 ? code.length : end + closing.length;
  return {
    token: { type: TokenType.RawString, value: code.slice(start, pos), position: start, closed: end >= 0 },
    newPos: pos,
  };
}

function parseBacktickIdentifier(code: string, pos: number): { token: Token; newPos: number } {
  const start = pos;
  pos += 1;

  while (pos < code.length) {
    if (code[pos] === "\\" && pos + 1 < code.length) {
      pos += 2;
      continue;
    }
    if (code[pos] === "`") {
      pos += 1;
      return {
        token: { type: TokenType.Identifier, value: code.slice(start, pos), position: start },
        newPos: pos,
      };
    }
    pos += 1;
  }

  return {
    token: { type: TokenType.Identifier, value: code.slice(start, pos), position: start },
    newPos: pos,
  };
}

function parseNumber(code: string, pos: number): { token: Token; newPos: number } {
  const start = pos;

  while (pos < code.length && (isDigit(code[pos]) || code[pos] === ".")) {
    pos += 1;
  }

  if (pos < code.length && (code[pos] === "e" || code[pos] === "E")) {
    pos += 1;
    if (pos < code.length && (code[pos] === "+" || code[pos] === "-")) {
      pos += 1;
    }
    while (pos < code.length && isDigit(code[pos])) {
      pos += 1;
    }
  }

  if (pos < code.length && (code[pos] === "L" || code[pos] === "i")) {
    pos += 1;
  }

  return {
    token: { type: TokenType.Number, value: code.slice(start, pos), position: start },
    newPos: pos,
  };
}

function parseIdentifier(code: string, pos: number): { token: Token; newPos: number } {
  const start = pos;

  while (pos < code.length && isIdentChar(code[pos])) {
    pos += 1;
  }

  const value = code.slice(start, pos);
  if (NUMERIC_CONSTANTS.has(value)) {
    return {
      token: { type: TokenType.Number, value, position: start },
      newPos: pos,
    };
  }

  const keywordType = KEYWORDS.get(value);
  return {
    token: { type: keywordType ?? TokenType.Identifier, value, position: start },
    newPos: pos,
  };
}

function parseSpecialOperator(code: string, pos: number): { token: Token; newPos: number } {
  const start = pos;
  pos += 1;

  while (pos < code.length && code[pos] !== "%" && code[pos] !== "\n") {
    pos += 1;
  }

  if (pos < code.length && code[pos] === "%") {
    pos += 1;
  }

  return {
    token: { type: TokenType.Operator, value: code.slice(start, pos), position: start },
    newPos: pos,
  };
}

interface ParserState {
  parenDepth: number;
  braceDepth: number;
  bracketDepth: number;
}

export async function isExpressionCompleteAsync(code: string, nativeParse?: NativeParseCallback): Promise<boolean> {
  const sanitized = stripCommentLines(code);
  const trimmed = sanitized.trim();
  if (!trimmed) {
    return true;
  }

  const localClassification = classifyExpressionHeuristic(sanitized);
  if (localClassification === "incomplete") {
    return false;
  }

  if (nativeParse) {
    try {
      const status = await nativeParse(sanitized);
      return status !== 2;
    } catch {
    }
  }

  return localClassification === "complete";
}

function classifyExpressionHeuristic(code: string): LocalParseClassification {
  const trimmed = code.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return "complete";
  }

  const tokens = tokenize(code);
  const state: ParserState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
  };
  let sawUnknownToken = false;

  for (const token of tokens) {
    switch (token.type) {
      case TokenType.String: {
        const value = token.value;
        const quote = value[0];
        if (value.length < 2 || value[value.length - 1] !== quote) {
          return "incomplete";
        }
        break;
      }
      case TokenType.RawString:
        if (!token.closed) {
          return "incomplete";
        }
        break;
      case TokenType.Identifier:
        if (token.value.startsWith("`") && !token.value.endsWith("`")) {
          return "incomplete";
        }
        break;
      case TokenType.LeftParen:
        state.parenDepth += 1;
        break;
      case TokenType.RightParen:
        state.parenDepth -= 1;
        break;
      case TokenType.LeftBrace:
        state.braceDepth += 1;
        break;
      case TokenType.RightBrace:
        state.braceDepth -= 1;
        break;
      case TokenType.LeftBracket:
        state.bracketDepth += token.value.length;
        break;
      case TokenType.RightBracket:
        state.bracketDepth -= token.value.length;
        break;
      case TokenType.Unknown:
        sawUnknownToken = true;
        break;
      default:
        break;
    }
  }

  if (
    state.parenDepth > 0 ||
    state.braceDepth > 0 ||
    state.bracketDepth > 0
  ) {
    return "incomplete";
  }

  let lastMeaningful: Token | null = null;
  let secondLastMeaningful: Token | null = null;
  const meaningful: Token[] = [];

  for (const token of tokens) {
    if (
      token.type !== TokenType.Comment &&
      token.type !== TokenType.Newline &&
      token.type !== TokenType.EOF
    ) {
      meaningful.push(token);
    }
  }

  for (let i = meaningful.length - 1; i >= 0; i -= 1) {
    if (!lastMeaningful) {
      lastMeaningful = meaningful[i];
    } else {
      secondLastMeaningful = meaningful[i];
      break;
    }
  }

  if (!lastMeaningful) {
    return "complete";
  }

  if (lastMeaningful.type === TokenType.Operator) {
    const op = lastMeaningful.value;
    if (op.startsWith("%") && !op.endsWith("%")) {
      return "unknown";
    }

    const unaryPrefixOps = new Set(["!", "~", "+", "-", "?", "\\"]);
    if (meaningful.length === 1) {
      return unaryPrefixOps.has(op) ? "incomplete" : "unknown";
    }
    return "incomplete";
  }

  if (lastMeaningful.type === TokenType.Comma) {
    return "complete";
  }

  if (lastMeaningful.type === TokenType.RightParen && isAwaitingBody(tokens)) {
    return "incomplete";
  }

  if (lastMeaningful.type === TokenType.Else) {
    return "incomplete";
  }

  if (lastMeaningful.type === TokenType.Repeat) {
    return "incomplete";
  }

  if (
    lastMeaningful.type === TokenType.RightParen &&
    secondLastMeaningful &&
    isLambdaWithoutBody(tokens)
  ) {
    return "incomplete";
  }

  if (sawUnknownToken) {
    return "unknown";
  }

  return isDefinitelyCompleteToken(lastMeaningful) ? "complete" : "unknown";
}

function isDefinitelyCompleteToken(token: Token): boolean {
  switch (token.type) {
    case TokenType.Number:
    case TokenType.String:
    case TokenType.RawString:
    case TokenType.Identifier:
    case TokenType.RightParen:
    case TokenType.RightBrace:
    case TokenType.RightBracket:
    case TokenType.Comma:
    case TokenType.Semicolon:
    case TokenType.Break:
    case TokenType.Next:
      return true;
    default:
      return false;
  }
}

function isAwaitingBody(tokens: Token[]): boolean {
  let depth = 0;
  let parenStart = -1;

  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (
      token.type === TokenType.Comment ||
      token.type === TokenType.Newline ||
      token.type === TokenType.EOF
    ) {
      continue;
    }

    if (token.type === TokenType.RightParen) {
      depth += 1;
    } else if (token.type === TokenType.LeftParen) {
      depth -= 1;
      if (depth === 0) {
        parenStart = i;
        break;
      }
    }
  }

  if (parenStart <= 0) {
    return false;
  }

  for (let i = parenStart - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token.type === TokenType.Comment || token.type === TokenType.Newline) {
      continue;
    }
    if (
      token.type === TokenType.Function ||
      token.type === TokenType.If ||
      token.type === TokenType.For ||
      token.type === TokenType.While
    ) {
      return true;
    }
    if (token.type === TokenType.Operator && token.value === "\\") {
      return true;
    }
    return false;
  }

  return false;
}

function isLambdaWithoutBody(tokens: Token[]): boolean {
  let foundBackslash = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TokenType.Operator || token.value !== "\\") {
      continue;
    }
    for (let j = i + 1; j < tokens.length; j += 1) {
      const next = tokens[j];
      if (next.type === TokenType.Newline || next.type === TokenType.Comment) {
        continue;
      }
      if (next.type === TokenType.LeftParen) {
        foundBackslash = true;
      }
      break;
    }
  }

  if (!foundBackslash) {
    return false;
  }
  return isAwaitingBody(tokens);
}
