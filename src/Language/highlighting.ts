import { TokenType, tokenize, type Token } from "./lexer";

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

