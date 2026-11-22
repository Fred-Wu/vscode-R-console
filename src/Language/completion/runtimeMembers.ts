import { isUtf8 } from "node:buffer";
import { TokenType, tokenize, type Token } from "../lexer";
import type { MemberInspectionQuery, MemberInspectionStep, MemberInspectionTarget } from "../../Runtime/backendProtocol";

/** Decode a single argument tag without parsing or evaluating R source. */
export function decodeRArgumentName(spelling: string): string | undefined {
  const tokens = tokenize(spelling).filter(token => token.type !== TokenType.EOF);
  if (tokens.length !== 1) return undefined;
  const token = tokens[0];
  return token.type === TokenType.String && token.closed
    ? literalName(token.value) : memberName(token);
}

export function parseRuntimeMemberQuery(
  expression: string, target: MemberInspectionTarget = "$"
): MemberInspectionQuery | undefined {
  if (Buffer.byteLength(expression, "utf8") > 4096) return undefined;
  const tokens = tokenize(expression).filter(token => token.type !== TokenType.Newline &&
    token.type !== TokenType.EOF);
  if (!tokens.length || tokens.length > 40) return undefined;
  const encoding = { utf8ByteEscapes: false };
  const root = memberName(tokens[0], encoding);
  if (root === undefined) return undefined;
  const steps: MemberInspectionStep[] = [];
  let index = 1;
  while (index < tokens.length && steps.length < 12) {
    const token = tokens[index++];
    if (token.type === TokenType.Operator && (token.value === "$" || token.value === "@")) {
      const name = memberName(tokens[index++], encoding);
      if (name === undefined) return undefined;
      steps.push({ kind: token.value === "$" ? "field" : "slot", name });
    } else if (token.type === TokenType.LeftBracket && (token.value === "[[" || token.value === "[")) {
      const double = token.value === "[[";
      const value = tokens[index++];
      if (!value) return undefined;
      if (value.type === TokenType.String && value.closed) {
        const name = literalName(value.value, encoding);
        if (name === undefined) return undefined;
        steps.push({ kind: double ? "named-index" : "slice-name", name });
      } else if (value.type === TokenType.Number && /^(?:[1-9]\d{0,5})L?$/.test(value.value)) {
        const number = Number(value.value.replace(/L$/, ""));
        if (number > 100000) return undefined;
        steps.push({ kind: double ? "index" : "slice-index", index: number });
      } else if (value.type === TokenType.Identifier) {
        const name = memberName(value, encoding);
        if (name === undefined) return undefined;
        steps.push({ kind: double ? "variable-index" : "variable-slice", name });
      } else {
        return undefined;
      }
      const closing = tokens[index++];
      if (closing?.type !== TokenType.RightBracket || closing.value !== (double ? "]]" : "]")) {
        return undefined;
      }
    } else {
      return undefined;
    }
  }
  if (index !== tokens.length) return undefined;
  return { root, steps, target, ...(encoding.utf8ByteEscapes ? { utf8ByteEscapes: true } : {}) };
}

type NameEncoding = { utf8ByteEscapes: boolean };

function memberName(token: Token | undefined, encoding?: NameEncoding): string | undefined {
  if (token?.type !== TokenType.Identifier || token.closed === false) return undefined;
  return token.value.startsWith("\x60")
    ? decodeQuotedName(token.value, "\x60", encoding) : validName(token.value);
}

function literalName(value: string, encoding?: NameEncoding): string | undefined {
  const quote = value[0];
  return quote === "'" || quote === '"' ? decodeQuotedName(value, quote, encoding) : undefined;
}

// Byte escapes form a byte stream, not individual Unicode code points. Accept
// only strict UTF-8, and require the backend to verify R's current UTF-8 locale
// before using non-ASCII escaped bytes. Never guess a legacy encoding.
function decodeQuotedName(value: string, quote: string, encoding?: NameEncoding): string | undefined {
  if (value.length < 3 || !value.startsWith(quote) || !value.endsWith(quote)) return undefined;
  const raw = value.slice(1, -1);
  const bytes: number[] = [];
  let byteEscape = false, unicodeEscape = false, nonAsciiByte = false;
  const simpleEscapes: Record<string, string> = {
    "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b",
    f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
  };
  if (quote === "\x60") simpleEscapes["\x60"] = "\x60";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      const code = raw.codePointAt(i)!;
      if (code >= 0xd800 && code <= 0xdfff) return undefined;
      const char = String.fromCodePoint(code);
      bytes.push(...Buffer.from(char, "utf8"));
      i += char.length - 1;
    } else {
      const next = raw[++i];
      if (next === undefined) return undefined;
      if (Object.hasOwn(simpleEscapes, next)) {
        bytes.push(...Buffer.from(simpleEscapes[next], "utf8"));
      } else if (/^[0-7]$/.test(next) || next === "x") {
        byteEscape = true;
        const octal = next !== "x";
        const pattern = octal ? /^[0-7]$/ : /^[0-9a-fA-F]$/;
        let digits = octal ? next : "";
        while (digits.length < (octal ? 3 : 2) && pattern.test(raw[i + 1] ?? "")) digits += raw[++i];
        if (!digits) return undefined;
        const code = parseInt(digits, octal ? 8 : 16);
        if (code > 255) return undefined;
        nonAsciiByte ||= code > 127;
        bytes.push(code);
      } else if (next === "u" || next === "U") {
        if (quote === "\x60") return undefined; // R forbids Unicode escapes in backticks.
        unicodeEscape = true;
        const braced = raw[i + 1] === "{";
        const width = next === "u" ? 4 : 8;
        let digits = "";
        if (braced) i++;
        while (digits.length < width && /^[0-9a-fA-F]$/.test(raw[i + 1] ?? "")) digits += raw[++i];
        if (!digits || (braced ? raw[++i] !== "}" : digits.length !== width)) return undefined;
        const code = parseInt(digits, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
        bytes.push(...Buffer.from(String.fromCodePoint(code), "utf8"));
      } else {
        return undefined;
      }
    }
    if (bytes.length > 4096 || (byteEscape && unicodeEscape)) return undefined;
  }
  const buffer = Buffer.from(bytes);
  if (!isUtf8(buffer)) return undefined;
  if (nonAsciiByte) {
    if (!encoding) return undefined;
    encoding.utf8ByteEscapes = true;
  }
  return validName(buffer.toString("utf8"));
}

function validName(name: string): string | undefined {
  return name && !name.includes("\x00") && Buffer.byteLength(name, "utf8") <= 4096
    ? name : undefined;
}
