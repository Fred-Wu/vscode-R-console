import { TokenType, continuesExpressionLine, tokenize, type Token } from "../lexer";

/**
 * Limit native LSP analysis to the expression currently being completed.
 *
 * A console's editable buffer is not an executed program: previous statements
 * and declarations must not create or replace runtime functions or objects.
 * Replace those statements with spaces (preserving newline/UTF-16 offsets) so
 * the language server still understands the current call and edit range.
 * Static mode keeps the complete original input instead.
 */
export function runtimeCompletionText(text: string, cursor: number): string {
  const tokens = tokenize(text);
  const frames: string[] = [];
  let last: Token | undefined;
  let start = 0;

  for (const token of tokens) {
    if (token.position >= cursor) break;
    if (token.type === TokenType.Semicolon) {
      start = token.position + token.value.length;
    } else if (token.type === TokenType.Newline) {
      if (!continuesExpressionLine(true, frames.at(-1), last)) start = token.position + 1;
    } else if (token.type === TokenType.LeftBrace) {
      frames.push(...token.value);
      start = token.position + token.value.length;
    } else if (token.type === TokenType.LeftParen || token.type === TokenType.LeftBracket) {
      frames.push(...token.value);
    } else if (token.type === TokenType.RightParen ||
               token.type === TokenType.RightBracket || token.type === TokenType.RightBrace) {
      for (const closing of token.value) {
        const expected = closing === ")" ? "(" : closing === "}" ? "{" : "[";
        if (frames.at(-1) === expected) frames.pop();
      }
    }
    if (token.type !== TokenType.Newline && token.type !== TokenType.Comment) last = token;
  }
  if (!start) return text;

  // A closing delimiter after the cursor may pair with a hidden earlier '{'.
  // Hide only those orphaned closers; keep the current expression's closers.
  const orphaned = new Set<number>();
  const open: Array<{ value: string; offset: number }> = [];
  for (const token of tokens) {
    if (token.type === TokenType.LeftParen || token.type === TokenType.LeftBracket ||
        token.type === TokenType.LeftBrace) {
      for (let index = 0; index < token.value.length; index++) {
        open.push({ value: token.value[index], offset: token.position + index });
      }
    } else if (token.type === TokenType.RightParen || token.type === TokenType.RightBracket ||
               token.type === TokenType.RightBrace) {
      for (let index = 0; index < token.value.length; index++) {
        const expected = token.value[index] === ")" ? "(" : token.value[index] === "}" ? "{" : "[";
        const top = open.at(-1);
        if (top?.value !== expected) continue;
        open.pop();
        if (top.offset < start && token.position + index >= start) {
          orphaned.add(token.position + index);
        }
      }
    }
  }
  const masked = (text.slice(0, start).replace(/[^\r\n]/g, " ") + text.slice(start)).split("");
  for (const offset of orphaned) masked[offset] = " ";
  return masked.join("");
}
