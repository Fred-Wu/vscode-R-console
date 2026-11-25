import { TokenType, tokenize, continuesExpressionLine, isMemberAccessor, isNameAccessor, isAccessorNamePrefix, isCompleteIdentifier, type Token } from "../lexer";
import { getDataCompletionObject } from "./dataScope";
import { decodeRArgumentName, parseRuntimeMemberQuery } from "./runtimeMembers";

// Retain only the latest completion input. Adjacent tokens can merge after an
// edit (notably r + a quote + a raw-string delimiter, or an exponent's sign).
let completionTokenCache: { code: string; tokens: Token[] } | undefined;

function completionTokens(code: string): Token[] {
  const previous = completionTokenCache;
  if (previous?.code === code) return previous.tokens;
  let tokens: Token[];
  if (previous) {
    let common = 0;
    while (common < code.length && common < previous.code.length && code[common] === previous.code[common]) common++;
    let low = 0, high = previous.tokens.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (previous.tokens[mid].position < common) low = mid + 1;
      else high = mid;
    }
    let index = Math.max(0, low - 1);
    while (index > 0 && previous.tokens[index].type !== TokenType.Newline &&
        previous.tokens[index - 1].type !== TokenType.Newline &&
        previous.tokens[index - 1].position + previous.tokens[index - 1].value.length === previous.tokens[index].position) {
      index--;
    }
    const offset = Math.min(common, previous.tokens[index].position);
    tokens = previous.tokens.slice(0, index).concat(tokenize(code.slice(offset)).map(token =>
      ({ ...token, position: token.position + offset })));
  } else {
    tokens = tokenize(code);
  }
  completionTokenCache = { code, tokens };
  return tokens;
}

export type CompletionSyntax = ReturnType<typeof getCompletionSyntax>;

/** Share one lexical snapshot between completion's independent context checks. */
export function getCompletionSyntax(code: string, cursor = code.length) {
  let tokens: Token[] | undefined;
  let prefixTokens: Token[] | undefined;
  const all = (): Token[] => tokens ??= completionTokens(code);
  const before = code.slice(0, cursor);
  const prefix = (): Token[] => {
    if (cursor === code.length) return all();
    if (!prefixTokens) {
      prefixTokens = all().filter(token => token.position < cursor);
      const last = prefixTokens.at(-1);
      if (last && last.position + last.value.length > cursor) {
        prefixTokens.pop();
        prefixTokens.push(...tokenize(code.slice(last.position, cursor)).filter(token => token.type !== TokenType.EOF)
          .map(token => ({ ...token, position: token.position + last.position })));
      }
      prefixTokens.push({ type: TokenType.EOF, value: "", position: cursor });
    }
    return prefixTokens;
  };
  return {
    get tokens() { return all(); },
    get prefixTokens() { return prefix(); },
    get identifierEnd() {
      if (cursor === code.length) return undefined;
      const token = all().find(token => token.type === TokenType.Identifier &&
        token.position < cursor &&
        cursor < token.position + token.value.length);
      return token ? token.position + token.value.length : undefined;
    },
    get inLiteral() { return /["'`#]/.test(code) && isCompletionInLiteral(code, cursor, all()); },
    get member() { return /[$@]|::/.test(before) ? getQualifiedCompletionContext(before, prefix()) : undefined; },
    get memberSuffix() { return /[$@]/.test(before) ? getMemberCompletionSuffix(before, prefix()) : undefined; },
    get bracket() { return code.includes("[") ? getBracketCompletionContext(code, cursor, all()) : undefined; },
    get pipe() { return before.includes("|>") || before.includes("%>%") ? getPipeCompletionContext(before, prefix()) : undefined; },
    get call() { return before.includes("(") ? getEnclosingCall(code, cursor, all()) : undefined; },
    get dataObject() { return /[([|%]/.test(before) ? getDataCompletionObject(before, prefix(), getQualifiedCompletionContext) : undefined; },
  };
}

/** Make an unfinished native-pipe destination parseable without changing input
 * or evaluating it. Its name and cursor remain at their original positions. */
export function getCompletionParseInsertion(code: string, cursor: number): { offset: number; text: string } | undefined {
  const pipe = getCompletionSyntax(code, cursor).pipe;
  if (!pipe || !code.slice(0, pipe.replaceStart).trimEnd().endsWith("|>")) return undefined;
  const name = completionTokens(code).find(token => token.type === TokenType.Identifier &&
    token.position === pipe.replaceStart && token.position + token.value.length >= cursor);
  const offset = name ? name.position + name.value.length : cursor;
  if (name && getCallOpenings(code).has(offset)) return undefined;
  return { offset, text: name ? "()" : "identity()" };
}

export type CallCompletionContext = {
  // Callable source reconstructed from tokens, without inter-token whitespace
  // or comments between selectors. Balanced receiver expressions retain their
  // original source, including statement boundaries inside blocks.
  name: string;
  operator?: "$" | "@" | "::" | ":::";
  // R source tags; "" is positional, "..." is unknown forwarded dots, null is the cursor. Undefined
  // means the cursor is in a value, comment, or another non-name position.
  argumentTags?: (string | null)[];
  argumentValue?: { name: string; prefix: string; replaceStart: number; replaceEnd?: number; quote?: "\"" | "'";
    argumentTags?: (string | null)[] };
};

export type BracketCompletionContext = {
  objectName: string;
  operator: "[" | "[[";
  prefix: string;
  replaceStart: number;
  replaceEnd?: number;
  quote?: "\"" | "'";
  dimension: number;
  dimensions: number;
  argumentName?: string;
  argumentTags?: (string | null)[];
};

/** The bracket and member paths share a single non-evaluating selector grammar. */
function hasOnlyLiteralSubscripts(code: string): boolean {
  return parseRuntimeMemberQuery(code) !== undefined;
}

export function isCompletionInLiteral(code: string, cursor = code.length, tokens?: Token[]): boolean {
  if (!/["'`#]/.test(code)) return false;
  return (tokens ?? tokenize(code)).some(token => token.position < cursor &&
    (cursor < token.position + token.value.length ||
      (cursor === token.position + token.value.length && (token.closed === false || token.type === TokenType.Comment))) &&
    (token.type === TokenType.Comment || token.type === TokenType.String || token.type === TokenType.RawString ||
      (token.type === TokenType.Identifier && token.value.startsWith("`"))));
}

/** Complete delimiters for runtime signature matching in the native adapter.
 * The suffix is never inserted into the console or evaluated. */
export function getCompletionParseSuffix(code: string): string | undefined {
  if (!code.includes("function") && !code.includes("\\")) return undefined;
  const tokens = tokenize(code);
  if (!tokens.some(token => token.type === TokenType.Function ||
      (token.type === TokenType.Operator && token.value === "\\"))) return undefined;
  const closing: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  let suffix = "";
  for (const token of tokens) {
    if ([TokenType.LeftParen, TokenType.LeftBracket, TokenType.LeftBrace].includes(token.type)) {
      for (const opening of token.value) stack.push(closing[opening]);
    } else if ([TokenType.RightParen, TokenType.RightBracket, TokenType.RightBrace].includes(token.type)) {
      for (const ending of token.value) if (stack.pop() !== ending) return undefined;
    } else if (token.closed === false) {
      if (token.type === TokenType.RawString) {
        const opening = /^[rR](["'])(-*)([([{])/.exec(token.value)!;
        suffix = closing[opening[3]] + opening[2] + opening[1];
      } else {
        const trailingSlashes = /\\+$/.exec(token.value)?.[0].length ?? 0;
        suffix = (trailingSlashes % 2 ? "\\" : "") + token.value[0];
      }
    } else if (token.type === TokenType.Comment && token.position + token.value.length === code.length) {
      suffix = "\n";
    }
  }
  return suffix + stack.reverse().join("");
}

/** Decode typed R string keys without evaluation. Valid complete escapes use the
 * same strict selector parser as guarded live completion. Keep incomplete
 * spellings usable while the user is still typing an escape.
 */
export function decodeQuotedCompletionPrefix(quote: "\"" | "'" | "`", fragment: string): string {
  return decodeRArgumentName(quote + fragment + quote) ??
    fragment.replace(/\\([\\"'`nrt])/g,
      (_match, escaped: string) => ({ n: "\n", r: "\r", t: "\t" }[escaped] ?? escaped));
}

function completionPrefix(tokens: Token[], start: number, end: number, cursor: number, accessorPrefix = false):
  { prefix: string; replaceStart: number; replaceEnd?: number; quote?: "\"" | "'" } | undefined {
  const before = tokens.slice(start, end).filter(token => token.position < cursor);
  if (!before.length) return start === end ? { prefix: "", replaceStart: cursor } : undefined;
  if (before.length !== 1) return undefined;
  const token = before[0];
  // As with obj$in, a keyword can be a transient prefix in obj[[in while
  // typing a stored member name. Keep the receiver and its insertion rules;
  // this does not extend the grammar of completed runtime selector paths.
  if ((accessorPrefix ? isAccessorNamePrefix(token) : token.type === TokenType.Identifier) &&
      !token.value.startsWith("`") && token.value !== "..." &&
      token.position + token.value.length >= cursor) {
    const end = token.position + token.value.length;
    return { prefix: token.value.slice(0, cursor - token.position), replaceStart: token.position,
      ...(end > cursor ? { replaceEnd: end } : {}) };
  }
  if (token.type === TokenType.String && (cursor < token.position + token.value.length || token.closed === false)) {
    const prefix = decodeQuotedCompletionPrefix(token.value[0] as "\"" | "'",
      token.value.slice(1, cursor - token.position));
    return { prefix, replaceStart: token.position + 1,
      replaceEnd: token.position + token.value.length - Number(token.closed === true),
      quote: token.value[0] as "\"" | "'" };
  }
  return undefined;
}

/** Find the active subscript slot using tokens, including closing brackets after the caret. */
export function getBracketCompletionContext(code: string, cursor = code.length, sourceTokens?: Token[]): BracketCompletionContext | undefined {
  if (!code.includes("[")) return undefined;
  sourceTokens ??= tokenize(code);
  // A lexer token can close both a nested single subscript and this subscript.
  // Split closing brackets so each delimiter is handled at its own depth.
  const tokens = sourceTokens.filter(token => token.type !== TokenType.Newline &&
    token.type !== TokenType.Comment && token.type !== TokenType.EOF).flatMap(token =>
      token.type === TokenType.RightBracket && token.value === "]]"
        ? [{ ...token, value: "]" }, { ...token, value: "]", position: token.position + 1 }] : [token]);
  const stack: { opening: string; index: number }[] = [];
  for (let index = 0; index < tokens.length && tokens[index].position < cursor; index++) {
    const token = tokens[index];
    if ([TokenType.LeftBracket, TokenType.LeftParen, TokenType.LeftBrace].includes(token.type)) {
      for (const opening of token.value) stack.push({ opening, index });
    } else if ([TokenType.RightBracket, TokenType.RightParen, TokenType.RightBrace].includes(token.type)) {
      for (const closing of token.value) {
        if (stack.pop()?.opening !== ({ "]": "[", ")": "(", "}": "{" }[closing])) return undefined;
      }
    }
  }
  const frame = stack.at(-1);
  if (frame?.opening !== "[") return undefined;
  const opening = tokens[frame.index];
  const head = code.slice(0, opening.position);
  // Reuse member-object detection; the synthetic accessor is never evaluated.
  const object = getQualifiedCompletionContext(head + "$", [
    ...sourceTokens.filter(token => token.position < opening.position),
    { type: TokenType.Operator, value: "$", position: opening.position },
    { type: TokenType.EOF, value: "", position: opening.position + 1 },
  ]);
  if (!object || !hasOnlyLiteralSubscripts(object.objectName)) return undefined;
  let slotStart = frame.index + 1;
  let slotOffset = opening.position + opening.value.length;
  let dimension = 0;
  let dimensions = 0;
  let selected: ReturnType<typeof completionPrefix>;
  let argumentName: string | undefined;
  const argumentTags: (string | null)[] = [];
  const nested: string[] = [];
  for (let index = slotStart; index <= tokens.length; index++) {
    const token = tokens[index];
    const closes = !token || (!nested.length && token.type === TokenType.RightBracket);
    if (closes || (!nested.length && token.type === TokenType.Comma)) {
      const first = tokens[slotStart];
      const second = tokens[slotStart + 1];
      const named = slotStart + 1 < index && second.type === TokenType.Operator && second.value === "=" &&
        (first.type === TokenType.Identifier || first.type === TokenType.String);
      const name = named ? first.value.replace(/^[`"']|[`"']$/g, "") : undefined;
      const option = name === (opening.value === "[[" ? "exact" : "drop");
      const active = slotOffset <= cursor && cursor <= (token?.position ?? code.length);
      argumentTags.push(active ? null : named ? first.value :
        slotStart + 1 === index && first?.value === "..." ? "..." : "");
      if (!option && active) {
        selected = completionPrefix(tokens, slotStart + (named ? 2 : 0), index, cursor, true);
        // Retain source spelling so quoted/escaped argument tags remain valid R.
        argumentName = named ? first.value : undefined;
        dimension = dimensions;
      }
      if (!option) dimensions++;
      if (closes) break;
      slotStart = index + 1;
      slotOffset = token.position + 1;
    } else if ([TokenType.LeftBracket, TokenType.LeftParen, TokenType.LeftBrace].includes(token.type)) {
      nested.push(...token.value);
    } else if ([TokenType.RightBracket, TokenType.RightParen, TokenType.RightBrace].includes(token.type)) {
      for (const closing of token.value) {
        if (nested.pop() !== ({ "]": "[", ")": "(", "}": "{" }[closing])) return undefined;
      }
    }
  }
  if (!selected || (isCompletionInLiteral(code, cursor, sourceTokens) && !selected.quote)) return undefined;
  return { objectName: object.objectName, operator: opening.value as "[" | "[[", ...selected,
    dimension, dimensions, argumentName, argumentTags };
}

export function getPipeCompletionContext(code: string, all?: Token[]): { prefix: string; replaceStart: number } | undefined {
  if (!code.includes("|>") && !code.includes("%>%")) return undefined;
  all ??= tokenize(code);
  if (all.some(token => token.type === TokenType.Comment && token.position + token.value.length === code.length)) return undefined;
  const tokens = all.filter(token => token.type !== TokenType.Newline && token.type !== TokenType.EOF && token.type !== TokenType.Comment);
  const last = tokens.at(-1);
  const hasPrefix = last?.type === TokenType.Identifier && !last.value.startsWith("`") &&
    last.position + last.value.length === code.length;
  const pipe = tokens.at(hasPrefix ? -2 : -1);
  if (pipe?.type !== TokenType.Operator || (pipe.value !== "|>" && pipe.value !== "%>%")) return undefined;
  return { prefix: hasPrefix ? last.value : "", replaceStart: hasPrefix ? last.position : code.length };
}

export function isCallableName(code: string): boolean {
  const tokens = tokenize(code).filter(token => token.type !== TokenType.EOF && token.type !== TokenType.Newline);
  return tokens.length % 2 === 1 && tokens.every((token, index) =>
    index % 2 === 0 ? isCompleteIdentifier(token) : isNameAccessor(token));
}

export type QualifiedCompletionContext = {
  objectName: string;
  baseObject: string;
  operator: "$" | "@" | "::" | ":::";
  prefix: string;
  replaceStart: number;
  hasSubscript: boolean;
};

/** The trailing accessor/prefix is meaningful even when its receiver is an
 * executable expression. Keep that syntax separate from guarded root parsing.
 * Replacement starts at the opening backtick so insertion replaces the name
 * as a whole, including an existing closing quote after the cursor.
 */
function accessorPrefix(code: string, tokens: Token[]) {
  let index = tokens.length - 1;
  const last = tokens[index];
  let prefix = "";
  let replaceStart = code.length;
  if (isNameAccessor(tokens[index - 1]) && isAccessorNamePrefix(last) &&
      last.position + last.value.length === code.length) {
    prefix = last.value.startsWith("`")
      ? decodeQuotedCompletionPrefix("`", last.value.slice(1, last.closed === true ? -1 : undefined))
      : last.value;
    replaceStart = last.position;
    index--;
  }
  return { index, prefix, replaceStart };
}

function getMemberCompletionSuffix(code: string, sourceTokens: Token[]) {
  const last = sourceTokens.at(-2);
  if (last?.type === TokenType.Comment && last.position + last.value.length === code.length) return undefined;
  const tokens = sourceTokens.filter(token => token.type !== TokenType.EOF &&
    token.type !== TokenType.Newline && token.type !== TokenType.Comment);
  const { index, prefix, replaceStart } = accessorPrefix(code, tokens);
  const accessor = tokens[index];
  if (index < 1 || !isMemberAccessor(accessor)) return undefined;
  return { operator: accessor.value as "$" | "@", prefix, replaceStart };
}

/** Inspect the source before the cursor. Walk backwards over names, accessors
 * and balanced subscripts; never evaluate an expression or accept its suffix. */
export function getQualifiedCompletionContext(code: string, sourceTokens?: Token[]): QualifiedCompletionContext | undefined {
  if (!code.includes("$") && !code.includes("@") && !code.includes("::")) return undefined;
  const tokens: Token[] = [];
  const continuations: boolean[] = [];
  const subscriptOpenings = new Map<number, number>();
  const stack: { opening: string; index: number }[] = [];
  let lineBreak = false;
  for (const token of sourceTokens ?? tokenize(code)) {
    if (token.type === TokenType.EOF) break;
    if (token.type === TokenType.Comment) {
      if (token.position + token.value.length === code.length) return undefined;
      continue;
    }
    if (token.type === TokenType.Newline) {
      lineBreak = true;
      continue;
    }
    const index = tokens.length;
    continuations.push(continuesExpressionLine(lineBreak, stack.at(-1)?.opening, tokens.at(-1)));
    tokens.push(token);
    lineBreak = false;
    if (token.type === TokenType.LeftParen || token.type === TokenType.LeftBrace || token.type === TokenType.LeftBracket) {
      for (const opening of token.value) stack.push({ opening, index });
    } else if (token.type === TokenType.RightParen || token.type === TokenType.RightBrace || token.type === TokenType.RightBracket) {
      let openingIndex = -1;
      for (const closing of token.value) {
        const expected = closing === ")" ? "(" : closing === "}" ? "{" : "[";
        const frame = stack.pop();
        if (frame?.opening !== expected) return undefined;
        openingIndex = frame.index;
      }
      if (token.type === TokenType.RightBracket && stack.at(-1)?.index !== openingIndex) {
        subscriptOpenings.set(index, openingIndex);
      }
    }
  }
  let { index, prefix, replaceStart } = accessorPrefix(code, tokens);
  // R keywords such as "in" are valid *partial* names immediately after
  // an accessor (e.g. obj$in while typing obj$inner). Treat them as a prefix
  // here, not as completed receiver members or ordinary global tokens.
  if (index < tokens.length - 1 && !continuations[index + 1]) return undefined;
  const accessor = tokens[index];
  if (!isNameAccessor(accessor) || !continuations[index]) return undefined;
  const namespace = accessor.value === "::" || accessor.value === ":::";
  index--;
  const objectParts: string[] = [];
  let hasSubscript = false;
  while (index >= 0) {
    while (tokens[index]?.type === TokenType.RightBracket) {
      if (namespace) return undefined;
      const opening = subscriptOpenings.get(index);
      if (opening === undefined || !continuations[opening]) return undefined;
      hasSubscript = true;
      objectParts.push(code.slice(tokens[opening].position, tokens[index].position + tokens[index].value.length));
      index = opening - 1;
    }
    if (!isCompleteIdentifier(tokens[index])) return undefined;
    objectParts.push(tokens[index].value);
    if (!isMemberAccessor(tokens[index - 1])) break;
    if (namespace) return undefined;
    if (!continuations[index] || !continuations[index - 1]) return undefined;
    objectParts.push(tokens[index - 1].value);
    index -= 2;
  }
  const first = tokens[index];
  if (!first) return undefined;
  const preceding = tokens[index - 1];
  if (isNameAccessor(preceding) || (preceding &&
      preceding.position + preceding.value.length === first.position &&
      (preceding.type === TokenType.Unknown || preceding.type === TokenType.Number ||
       preceding.type === TokenType.Identifier))) return undefined;
  return {
    // Separators outside subscripts may rely on the enclosing call for line
    // continuation. Normalize them so the runtime can parse the object alone.
    objectName: objectParts.reverse().join(""),
    baseObject: first.value,
    operator: accessor.value as QualifiedCompletionContext["operator"],
    prefix,
    replaceStart,
    hasSubscript,
  };
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
        continuesExpressionLine(lineBreak, stack.at(-1), previous)) {
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
export function getEnclosingCall(code: string, cursor = code.length, sourceTokens?: Token[]): CallCompletionContext | undefined {
  if (!code.includes("(")) return undefined;
  const tokens: Token[] = [];
  const lineBreaks = new Set<number>();
  let inComment = false;
  for (const token of sourceTokens ?? tokenize(code)) {
    if (token.type === TokenType.Comment) {
      inComment ||= token.position < cursor && cursor <= token.position + token.value.length;
    } else if (token.type === TokenType.Newline) {
      lineBreaks.add(tokens.length);
    } else if (token.type !== TokenType.EOF) {
      tokens.push(token);
    }
  }
  const stack: { opening: string; index: number }[] = [];
  const openings = new Map<number, number>();
  const continuations: boolean[] = [];
  for (let index = 0; index < tokens.length && tokens[index].position < cursor; index++) {
    const token = tokens[index];
    continuations[index] = continuesExpressionLine(lineBreaks.has(index), stack.at(-1)?.opening, tokens[index - 1]);
    if (token.type === TokenType.LeftParen || token.type === TokenType.LeftBrace || token.type === TokenType.LeftBracket) {
      for (const opening of token.value.slice(0, cursor - token.position)) {
        stack.push({ opening, index });
      }
    } else if (token.type === TokenType.RightParen || token.type === TokenType.RightBrace || token.type === TokenType.RightBracket) {
      let opening = -1;
      for (const closing of token.value.slice(0, cursor - token.position)) {
        const expected = closing === ")" ? "(" : closing === "}" ? "{" : "[";
        const matched = stack.pop();
        if (matched?.opening !== expected) return undefined;
        opening = matched.index;
      }
      if (stack.at(-1)?.index !== opening) openings.set(index, opening);
    }
  }
  const frame = stack.at(-1);
  if (frame?.opening !== "(") return undefined;
  const continuesLine = (index: number): boolean => continuations[index];
  let start = frame.index - 1;
  const last = tokens[start];
  if (!isCompleteIdentifier(last) || !continuesLine(frame.index)) return undefined;
  let operator: CallCompletionContext["operator"];
  const parts: string[] = [];
  // Find the complete receiver of a named method, including calls, grouping
  // and subscripts. This is syntax for source inference, not authorization to
  // evaluate a chain; the native inspector retains its separate strict grammar.
  const canEndReceiver = (index: number): boolean => {
    const token = tokens[index];
    if (isCompleteIdentifier(token)) return true;
    if (!openings.has(index)) return false;
    const head = tokens[openings.get(index)! - 1];
    return token.type !== TokenType.RightParen || !head ||
      !([TokenType.If, TokenType.For, TokenType.While, TokenType.Function].includes(head.type) ||
        (head.type === TokenType.Operator && head.value === "\\"));
  };
  while (start >= 0) {
    const token = tokens[start];
    if (isCompleteIdentifier(token)) parts.push(token.value);
    else {
      const opening = openings.get(start);
      if (opening === undefined) return undefined;
      parts.push(code.slice(tokens[opening].position, token.position + token.value.length));
      start = opening;
      if (token.type === TokenType.RightBracket || (token.type === TokenType.RightParen &&
          continuesLine(start) && canEndReceiver(start - 1))) {
        if (!continuesLine(start)) return undefined;
        start--;
        continue;
      }
    }
    const previous = tokens[start - 1];
    if (!isNameAccessor(previous)) break;
    if (!continuesLine(start) || !continuesLine(start - 1)) return undefined;
    operator ??= previous.value as CallCompletionContext["operator"];
    parts.push(previous.value);
    start -= 2;
  }
  if (start < 0) return undefined;
  // Never reinterpret the ASCII suffix of an unsupported token as a callable.
  const preceding = tokens[start - 1];
  if (preceding?.type === TokenType.Unknown &&
      preceding.position + preceding.value.length === tokens[start].position) return undefined;
  // Inspect only this call's top-level arguments, including those after the
  // cursor. Nested commas and equals signs belong to their own expressions.
  const argumentTags: (string | null)[] = [];
  const pipe = tokens[start - 1]?.type === TokenType.Operator && continuesLine(start)
    ? tokens[start - 1].value : undefined;
  const piped = pipe === "|>" || pipe === "%>%";
  let hasPipePlaceholder = false;
  let namePosition = false;
  let argumentValue: CallCompletionContext["argumentValue"];
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
      if (named && cursor >= second.position + 1) {
        const value = completionPrefix(tokens, valueStart, end, cursor);
        if (value) argumentValue = { name: first.value, ...value };
      }
      namePosition = argumentStart === end || (
        argumentStart + 1 === end && first.type === TokenType.Identifier &&
        !first.value.startsWith("`") && first.value !== "..." &&
        first.position < cursor && first.position + first.value.length >= cursor
      );
    } else {
      // Only a supplied direct placeholder replaces implicit insertion. A
      // prefix in the cursor slot will be replaced by the selected argument.
      // In magrittr, nested uses such as f(g(.)) still insert a first argument.
      const value = tokens[valueStart];
      hasPipePlaceholder ||= piped && valueStart + 1 === end && value?.type === TokenType.Identifier &&
        (pipe === "|>" ? value.value === "_" : value.value === "." || value.value === "`.`");
      const forwardedDots = argumentStart + 1 === end && first.value === "...";
      argumentTags.push(named ? first.value : forwardedDots ? "..." : "");
      // Keep argument-name completion available, but mark unknown forwarding
      // so providers cannot infer positional consumption or exhaustion.
      hasDots ||= forwardedDots;
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
    name: parts.reverse().join(""),
    operator,
    argumentTags: namePosition && !inComment ? argumentTags : undefined,
    ...(argumentValue && !inComment ? { argumentValue: { ...argumentValue,
      ...(!hasDots ? { argumentTags } : {}) } } : {}),
  };
}

