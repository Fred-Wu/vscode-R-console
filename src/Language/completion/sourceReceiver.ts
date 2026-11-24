import { TokenType, continuesExpressionLine, isAccessorNamePrefix, isNameAccessor } from "../lexer";
import { getCompletionSyntax } from "./contextParser";
import { decodeRArgumentName } from "./runtimeMembers";
import type { CompletionContext, RuntimeFunctionSourceTarget } from "./types";

// Locate the named callable at the root of the receiver. A bare function
// name uses function lookup; a grouped symbol used as a call head uses value
// lookup. Neither path evaluates selectors, subscripts or computed heads.
export function storedFunctionReceiver(
  context: CompletionContext, input: string, cursor: number
): string | undefined {
  return storedFunctionCall(context, input, cursor)?.name;
}

export function storedFunctionCall(
  context: CompletionContext, input: string, cursor: number
): { name: string; start: number } | undefined {
  const receiver = storedCompletionReceiver(context, input, cursor);
  return receiver && receiver.target !== "binding" ? { name: receiver.name, start: receiver.start } : undefined;
}

// Locate the value root of a computed receiver for binding identity checks.
// Subscripts and method calls are skipped syntactically, never evaluated.
export function storedReceiverRoot(
  context: CompletionContext, input: string, cursor: number
): { name: string; start: number } | undefined {
  const receiver = storedCompletionReceiver(context, input, cursor);
  return receiver && { name: receiver.name, start: receiver.start };
}

// One delimiter scan and one backwards walk classify the receiver's root.
// Downstream accessors, subscripts and calls do not change that identity.
// Leave inference of those operations to the language server.
export function storedCompletionReceiver(
  context: CompletionContext, input: string, cursor: number
): { name: string; start: number; target: RuntimeFunctionSourceTarget } | undefined {
  const methodArguments = context.kind === "argument" &&
    (context.functionOperator === "$" || context.functionOperator === "@");
  if (!methodArguments && (!context.staticFallback || (context.kind !== "member" && context.kind !== "bracket"))) {
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
  if (methodArguments) {
    const active = stack.at(-1);
    if (active?.type !== "(") return undefined;
    receiverEnd = active.index - 1;
  } else if (context.kind === "member") {
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

  // Strip suffixes and grouping on the receiver. Each group
  // must contain that entire receiver, not a compound expression ending in
  // a call, such as (other + fn()). Keep this walk iterative as well.
  // A call on a grouped symbol uses value lookup. Track whether the walk
  // reaches that symbol through grouping alone; traversing a selector or
  // subscript instead leaves only a binding-identity check.
  const groups: number[] = [];
  let valueCall = false;
  const result = (index: number, target: RuntimeFunctionSourceTarget) => {
    let start = index;
    for (let group = groups.length - 1; group >= 0; group--) {
      if (start !== groups[group] + 1) return undefined;
      start = groups[group];
    }
    // These are not ordinary symbol lookups. Quoted call names remain valid,
    // but NULL literals and variadic references must not borrow stored source.
    if (target !== "binding" && tokens[index].value === "NULL") return undefined;
    const decoded = decodeRArgumentName(tokens[index].value);
    if (target === "source-value" && decoded &&
        (decoded === "..." || /^\.\.[0-9]+$/.test(decoded))) return undefined;
    return decoded === undefined ? undefined : { name: decoded, start: tokens[index].position, target };
  };
  for (let index = receiverEnd; index >= 0;) {
    const token = tokens[index];
    if (token.type === TokenType.RightBracket) {
      const opening = openings.get(index);
      if (opening === undefined) return undefined;
      valueCall = false;
      index = opening - 1;
    } else if ((token.type === TokenType.Identifier || (token.type === TokenType.String && token.closed)) &&
        tokens[index - 1]?.type === TokenType.Operator &&
        ["$", "@"].includes(tokens[index - 1].value)) {
      valueCall = false;
      index -= 2;
    } else if (token.type === TokenType.RightParen) {
      const opening = openings.get(index);
      if (opening === undefined) return undefined;
      const name = continuations[opening] ? tokens[opening - 1] : undefined;
      const preceding = tokens[opening - 2];
      if (name?.type === TokenType.Identifier || (name?.type === TokenType.String && name.closed)) {
        if (preceding?.type === TokenType.Operator && ["$", "@"].includes(preceding.value)) {
          valueCall = false;
          index = opening - 1;
          continue;
        }
        if (isNameAccessor(preceding)) return undefined;
        // R accepts an identifier or a string constant as a named call head.
        return result(opening - 1, "source");
      }
      // Parentheses after a value are a computed call. A control condition or
      // function's formals, however, can be followed by a grouped body.
      const previousOpening = openings.get(opening - 1);
      const control = previousOpening === undefined ? undefined : tokens[previousOpening - 1];
      const afterControl = name?.type === TokenType.RightParen && control &&
        ([TokenType.If, TokenType.For, TokenType.While, TokenType.Function].includes(control.type) ||
         (control.type === TokenType.Operator && control.value === "\\"));
      if (!afterControl && name &&
          [TokenType.RightParen, TokenType.RightBracket].includes(name.type)) {
        valueCall = name.type === TokenType.RightParen;
        index = opening - 1;
        continue;
      }
      const grouping = !name || afterControl ||
        [TokenType.LeftParen, TokenType.LeftBracket, TokenType.LeftBrace, TokenType.Comma,
          TokenType.Semicolon, TokenType.Else, TokenType.Repeat, TokenType.In].includes(name.type) ||
        (name.type === TokenType.Operator && !isNameAccessor(name) && name.value !== "\\");
      if (!grouping) return undefined;
      groups.push(opening);
      index--;
    } else if (token.type === TokenType.Identifier && !isNameAccessor(tokens[index - 1])) {
      return result(index, valueCall ? "source-value" : "binding");
    } else return undefined;
  }
  return undefined;
}
