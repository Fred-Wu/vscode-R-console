import { TokenType, tokenize, type Token } from "./lexer";
export * from "./completion/contextParser";
export { tokenizeForHighlighting, type HighlightToken, type HighlightTokenKind } from "./highlighting";

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
      case TokenType.String:
      case TokenType.RawString:
      case TokenType.Identifier:
        if (token.closed === false) {
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

  const lastMeaningful = meaningful.at(-1);
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
