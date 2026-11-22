import { TokenType, tokenize, type Token } from "../lexer";
import type { MemberInspectionQuery, MemberInspectionStep, MemberInspectionTarget } from "../../Runtime/backendProtocol";

export function parseRuntimeMemberQuery(
  expression: string, target: MemberInspectionTarget = "$"
): MemberInspectionQuery | undefined {
  if (Buffer.byteLength(expression, "utf8") > 4096) return undefined;
  const tokens = tokenize(expression).filter(token => token.type !== TokenType.Newline &&
    token.type !== TokenType.EOF);
  if (!tokens.length || tokens.length > 40) return undefined;
  const root = memberName(tokens[0]);
  if (root === undefined) return undefined;
  const steps: MemberInspectionStep[] = [];
  let index = 1;
  while (index < tokens.length && steps.length < 12) {
    const token = tokens[index++];
    if (token.type === TokenType.Operator && (token.value === "$" || token.value === "@")) {
      const name = memberName(tokens[index++]);
      if (name === undefined) return undefined;
      steps.push({ kind: token.value === "$" ? "field" : "slot", name });
    } else if (token.type === TokenType.LeftBracket && (token.value === "[[" || token.value === "[")) {
      const double = token.value === "[[";
      const value = tokens[index++];
      if (!value) return undefined;
      if (value.type === TokenType.String && value.closed) {
        const name = literalName(value.value);
        if (name === undefined) return undefined;
        steps.push({ kind: double ? "named-index" : "slice-name", name });
      } else if (value.type === TokenType.Number && /^(?:[1-9]\d{0,5})L?$/.test(value.value)) {
        const number = Number(value.value.replace(/L$/, ""));
        if (number > 100000) return undefined;
        steps.push({ kind: double ? "index" : "slice-index", index: number });
      } else if (value.type === TokenType.Identifier) {
        const name = memberName(value);
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
  return { root, steps, target };
}

function memberName(token: Token | undefined): string | undefined {
  if (token?.type !== TokenType.Identifier || token.closed === false) return undefined;
  return token.value.startsWith("\x60")
    ? decodeQuotedName(token.value, "\x60") : validName(token.value);
}

function literalName(value: string): string | undefined {
  const quote = value[0];
  return quote === "'" || quote === '"' ? decodeQuotedName(value, quote) : undefined;
}

// Decode only known R string escapes; never parse or evaluate an R expression.
// Unsupported or locale-dependent byte escapes are rejected.
function decodeQuotedName(value: string, quote: string): string | undefined {
  if (value.length < 3 || !value.startsWith(quote) || !value.endsWith(quote)) return undefined;
  const raw = value.slice(1, -1);
  let name = "";
  const simpleEscapes: Record<string, string> = {
    "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b",
    f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
  };
  if (quote === "\x60") simpleEscapes["\x60"] = "\x60";
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char !== "\\") {
      name += char;
    } else {
      const next = raw[++i];
      if (next === undefined) return undefined;
      if (Object.hasOwn(simpleEscapes, next)) {
        name += simpleEscapes[next];
      } else if (/^[0-7]$/.test(next)) {
        let digits = next;
        while (digits.length < 3 && /^[0-7]$/.test(raw[i + 1] ?? "")) digits += raw[++i];
        const code = parseInt(digits, 8);
        if (code > 0x7f) return undefined; // R's native-encoding bytes are locale-dependent.
        name += String.fromCharCode(code);
      } else if (next === "x" || next === "u" || next === "U") {
        const braced = next !== "x" && raw[i + 1] === "{";
        const width = braced ? 8 : next === "x" ? 2 : next === "u" ? 4 : 8;
        let digits = "";
        if (braced) {
          i++;
          while (digits.length < width && /^[0-9a-fA-F]$/.test(raw[i + 1] ?? "")) digits += raw[++i];
          if (raw[++i] !== "}" || !digits) return undefined;
        } else {
          while (digits.length < width && /^[0-9a-fA-F]$/.test(raw[i + 1] ?? "")) digits += raw[++i];
          if (digits.length !== width && next !== "x") return undefined;
          if (!digits) return undefined;
        }
        const code = parseInt(digits, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ||
            (next === "x" && code > 0x7f)) return undefined;
        name += String.fromCodePoint(code);
      } else {
        return undefined;
      }
    }
    if (Buffer.byteLength(name, "utf8") > 4096) return undefined;
  }
  return validName(name);
}

function validName(name: string): string | undefined {
  return name && !name.includes("\x00") && Buffer.byteLength(name, "utf8") <= 4096
    ? name : undefined;
}
