import { TokenType, tokenize, type Token } from "../lexer";
import type { MemberInspectionQuery, MemberInspectionStep } from "../../Runtime/backendProtocol";

// This parser is a request boundary, not an evaluator. Only a global binding
// followed by literal, direct accessors can reach the native inspector.
export function parseRuntimeMemberQuery(expression: string, slots = false): MemberInspectionQuery | undefined {
  if (expression.length > 4096) return undefined;
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
    } else if (token.type === TokenType.LeftBracket && token.value === "[[") {
      const value = tokens[index++];
      if (!value) return undefined;
      if (value.type === TokenType.String && value.closed) {
        const name = literalName(value.value);
        if (name === undefined) return undefined;
        steps.push({ kind: "field", name });
      } else if (value.type === TokenType.Number && /^(?:[1-9]\d{0,5})L?$/.test(value.value)) {
        const number = Number(value.value.replace(/L$/, ""));
        if (number > 100000) return undefined;
        steps.push({ kind: "index", index: number });
      } else {
        return undefined;
      }
      const closing = tokens[index++];
      if (closing?.type !== TokenType.RightBracket || closing.value !== "]]") return undefined;
    } else {
      return undefined;
    }
  }
  if (index !== tokens.length || steps.length === 0) return undefined;
  return { root, steps, slots };
}

function memberName(token: Token | undefined): string | undefined {
  if (token?.type !== TokenType.Identifier || token.closed === false) return undefined;
  let name = token.value;
  if (name.startsWith("`")) {
    if (!name.endsWith("`") || name.length < 3) return undefined;
    name = name.slice(1, -1);
  }
  // Escapes are not reinterpreted: an incorrectly decoded binding would be
  // misleading, and the user can still obtain ordinary LSP suggestions.
  return name && !/[\x00\\]/.test(name) && Buffer.byteLength(name, "utf8") <= 4096
    ? name : undefined;
}

function literalName(value: string): string | undefined {
  const quote = value[0];
  if (!["'", '"'].includes(quote) || value.at(-1) !== quote) return undefined;
  const name = value.slice(1, -1);
  return name && !/[\x00\\]/.test(name) && Buffer.byteLength(name, "utf8") <= 4096
    ? name : undefined;
}
