import { TokenType, continuesExpressionLine, isAccessorNamePrefix, isNameAccessor } from "../lexer";
import { getCompletionSyntax } from "./contextParser";
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
  const tokens = getCompletionSyntax(input, cursor).prefixTokens.filter(token =>
    token.type !== TokenType.EOF && token.type !== TokenType.Newline && token.type !== TokenType.Comment);
  // Match delimiters once. Grouping can be arbitrarily nested, and a closing
  // bracket token can finish more than one nested single/double subscript.
  const openings = new Map<number, number>();
  const continuations: boolean[] = [];
  const stack: Array<{ type: string; index: number }> = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], previous = tokens[index - 1];
    const lineBreak = !!previous && input.slice(previous.position + previous.value.length, token.position).includes("\n");
    continuations.push(continuesExpressionLine(lineBreak, stack.at(-1)?.type, previous));
    if (token.type === TokenType.LeftParen || token.type === TokenType.LeftBracket ||
        token.type === TokenType.LeftBrace) {
      for (const ch of token.value) stack.push({ type: ch, index });
    } else if (token.type === TokenType.RightParen || token.type === TokenType.RightBracket ||
               token.type === TokenType.RightBrace) {
      let opening = -1;
      for (const ch of token.value) {
        const frame = stack.pop();
        if (frame?.type !== pairs[ch]) return undefined;
        opening = frame.index;
      }
      if (stack.at(-1)?.index !== opening) openings.set(index, opening);
    }
  }

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
    const active = stack.at(-1);
    if (active?.type !== "[" || tokens[active.index].value !== context.bracketOperator) return undefined;
    receiverEnd = active.index - 1;
  }

  // Strip suffixes and grouping on the result of a direct call. Each group
  // must contain that entire receiver, not a compound expression ending in
  // a call, such as (other + fn()). Keep this walk iterative as well.
  // Reject computed call heads and methods rather than retrieving an unrelated
  // global function with the same name.
  const groups: number[] = [];
  for (let index = receiverEnd; index >= 0;) {
    const token = tokens[index];
    if (token.type === TokenType.RightBracket) {
      const opening = openings.get(index);
      if (opening === undefined) return undefined;
      index = opening - 1;
    } else if (token.type === TokenType.Identifier &&
        tokens[index - 1]?.type === TokenType.Operator &&
        ["$", "@"].includes(tokens[index - 1].value)) {
      index -= 2;
    } else if (token.type === TokenType.RightParen) {
      const opening = openings.get(index);
      if (opening === undefined) return undefined;
      const name = continuations[opening] ? tokens[opening - 1] : undefined;
      const preceding = tokens[opening - 2];
      if (name?.type === TokenType.Identifier) {
        if (isNameAccessor(preceding)) return undefined;
        let start = opening - 1;
        for (let group = groups.length - 1; group >= 0; group--) {
          if (start !== groups[group] + 1) return undefined;
          start = groups[group];
        }
        return decodeRArgumentName(name.value);
      }
      // Parentheses after a value are a computed call. A control condition or
      // function's formals, however, can be followed by a grouped body.
      const previousOpening = openings.get(opening - 1);
      const control = previousOpening === undefined ? undefined : tokens[previousOpening - 1];
      const afterControl = name?.type === TokenType.RightParen && control &&
        ([TokenType.If, TokenType.For, TokenType.While, TokenType.Function].includes(control.type) ||
         (control.type === TokenType.Operator && control.value === "\\"));
      const grouping = !name || afterControl ||
        [TokenType.LeftParen, TokenType.LeftBracket, TokenType.LeftBrace, TokenType.Comma,
          TokenType.Semicolon, TokenType.Else, TokenType.Repeat, TokenType.In].includes(name.type) ||
        (name.type === TokenType.Operator && !isNameAccessor(name) && name.value !== "\\");
      if (!grouping) return undefined;
      groups.push(opening);
      index--;
    } else return undefined;
  }
  return undefined;
}
