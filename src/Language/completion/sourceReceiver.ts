import { TokenType, tokenize, isAccessorNamePrefix } from "../lexer";
import { decodeRArgumentName } from "./runtimeMembers";
import type { CompletionContext } from "./types";

// Locate the direct named call whose return value is being accessed. This is
// syntax-only: no expression, subscript or callable is ever evaluated. Never
// inspect methods (obj$fn()), namespaces or computed function expressions.
export function storedFunctionReceiver(
  context: CompletionContext, input: string, cursor: number
): string | undefined {
  if (!context.staticFallback || (context.kind !== "member" && context.kind !== "bracket")) {
    return undefined;
  }
  const tokens = tokenize(input.slice(0, cursor)).filter(token =>
    token.type !== TokenType.EOF && token.type !== TokenType.Newline && token.type !== TokenType.Comment);
  const matchingOpen = (end: number, left: TokenType, right: TokenType): number | undefined => {
    let depth = 0;
    for (let index = end; index >= 0; index--) {
      const token = tokens[index];
      if (token.type === right) depth += token.value.length;
      else if (token.type === left) {
        depth -= token.value.length;
        if (depth === 0) return index;
        if (depth < 0) return undefined;
      }
    }
    return undefined;
  };

  let receiverEnd: number;
  if (context.kind === "member") {
    let accessor = tokens.length - 1;
    const last = tokens[accessor];
    if (isAccessorNamePrefix(last) &&
        tokens[accessor - 1]?.type === TokenType.Operator &&
        ["$", "@"].includes(tokens[accessor - 1].value)) accessor--;
    if (tokens[accessor]?.type !== TokenType.Operator ||
        !["$", "@"].includes(tokens[accessor].value)) return undefined;
    receiverEnd = accessor - 1;
  } else {
    const stack: Array<{ type: string; index: number }> = [];
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.type === TokenType.LeftParen || token.type === TokenType.LeftBracket ||
          token.type === TokenType.LeftBrace) {
        for (const ch of token.value) stack.push({ type: ch, index });
      } else if (token.type === TokenType.RightParen || token.type === TokenType.RightBracket ||
                 token.type === TokenType.RightBrace) {
        for (const ch of token.value) if (stack.pop()?.type !== pairs[ch]) return undefined;
      }
    }
    const active = stack.at(-1);
    if (active?.type !== "[" || tokens[active.index].value !== context.bracketOperator) return undefined;
    receiverEnd = active.index - 1;
  }

  // Strip suffixes on the result of a direct call: fn()$a, fn()[["a"]]$b.
  // Reject computed call heads and methods rather than retrieving an unrelated
  // global function with the same name.
  for (let index = receiverEnd; index >= 0;) {
    const token = tokens[index];
    if (token.type === TokenType.RightBracket) {
      const opening = matchingOpen(index, TokenType.LeftBracket, TokenType.RightBracket);
      if (opening === undefined) return undefined;
      index = opening - 1;
    } else if (token.type === TokenType.Identifier &&
        tokens[index - 1]?.type === TokenType.Operator &&
        ["$", "@"].includes(tokens[index - 1].value)) {
      index -= 2;
    } else if (token.type === TokenType.RightParen) {
      const opening = matchingOpen(index, TokenType.LeftParen, TokenType.RightParen);
      if (opening === undefined) return undefined;
      const name = tokens[opening - 1];
      const preceding = tokens[opening - 2];
      if (name?.type !== TokenType.Identifier ||
          (preceding?.type === TokenType.Operator &&
           ["$", "@", "::", ":::"].includes(preceding.value))) return undefined;
      return decodeRArgumentName(name.value);
    } else return undefined;
  }
  return undefined;
}
