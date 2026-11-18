export enum TokenType {
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

export interface Token {
  type: TokenType;
  value: string;
  position: number;
  closed?: boolean;
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

export function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < code.length) {
    const ch = String.fromCodePoint(code.codePointAt(pos)!);

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
    pos += ch.length;
  }

  tokens.push({ type: TokenType.EOF, value: "", position: pos });
  return tokens;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "." ||
    ch === "_" ||
    (ch > "\x7f" && /[\p{L}\p{Nl}]/u.test(ch))
  );
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch) || (ch > "\x7f" && /\p{Nd}/u.test(ch));
}

function parseString(code: string, pos: number, quote: string): { token: Token; newPos: number } {
  const start = pos;
  pos += 1;

  while (pos < code.length) {
    const ch = code[pos];
    if (ch === quote) {
      pos += 1;
      return {
        token: { type: TokenType.String, value: code.slice(start, pos), position: start, closed: true },
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
    token: { type: TokenType.String, value: code.slice(start, pos), position: start, closed: false },
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
        token: { type: TokenType.Identifier, value: code.slice(start, pos), position: start, closed: true },
        newPos: pos,
      };
    }
    pos += 1;
  }

  return {
    token: { type: TokenType.Identifier, value: code.slice(start, pos), position: start, closed: false },
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

  while (pos < code.length) {
    const ch = String.fromCodePoint(code.codePointAt(pos)!);
    if (!isIdentChar(ch)) break;
    pos += ch.length;
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

export function continuesExpressionLine(lineBreak: boolean, parent: string | undefined, previous?: Token): boolean {
  return !lineBreak || parent === "(" || parent === "[" || previous?.type === TokenType.Operator;
}

export function isMemberAccessor(token: Token | undefined): boolean {
  return token?.type === TokenType.Operator && (token.value === "$" || token.value === "@");
}

export function isNameAccessor(token: Token | undefined): boolean {
  return isMemberAccessor(token) ||
    (token?.type === TokenType.Operator && (token.value === "::" || token.value === ":::"));
}

export function isCompleteIdentifier(token: Token | undefined): boolean {
  return token?.type === TokenType.Identifier && token.closed !== false;
}

/** A bare or qualified name, without a call, subscript, or other expression. */
