import { tokenize, TokenType, type Token } from "../../../Language/lexer";
import type { SessionCompletionData, SessionCompletionKind, WorkspaceData } from "../types";

type Step = { operator: "$" | "@" | "[["; value: string | number };
type Request = (method: "hover", params: Record<string, unknown>) => Promise<unknown>;
const MAX_INSPECTION_DEPTH = 16;

function literalName(token: Token | undefined): string | undefined {
  if (!token) return undefined;
  if (token.type === TokenType.Identifier && !token.value.startsWith("`")) return token.value;
  if (token.type === TokenType.RawString) {
    const opening = /^[rR]["']-*[([{]/.exec(token.value)?.[0];
    return token.closed && opening ? token.value.slice(opening.length, -(opening.length - 1)) : undefined;
  }
  if (token.type !== TokenType.String && token.type !== TokenType.Identifier) return undefined;
  if (token.closed === false || token.value.at(-1) !== token.value[0]) return undefined;
  let valid = true;
  const value = token.value.slice(1, -1).replace(/\\(x[0-9a-fA-F]{1,2}|u\{[0-9a-fA-F]{1,4}\}|U\{[0-9a-fA-F]{1,8}\}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|[\s\S])/g, (_, escape: string) => {
    const simple: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "`": "`" };
    if (Object.hasOwn(simple, escape)) return simple[escape];
    const code = /^[0-7]/.test(escape) ? parseInt(escape, 8)
      : /^[xuU]/.test(escape) ? parseInt(escape.slice(1).replace(/[{}]/g, ""), 16) : NaN;
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      valid = false;
      return "";
    }
    return String.fromCodePoint(code);
  });
  return valid && value.length > 0 && !value.includes("\0") ? value : undefined;
}

function inspectionPath(expression: string): { name: string; steps: Step[] } | undefined {
  const tokens = tokenize(expression).filter(token => token.type !== TokenType.EOF && token.type !== TokenType.Newline);
  if (tokens[0]?.type !== TokenType.Identifier) return undefined;
  const name = literalName(tokens[0]);
  if (!name) return undefined;
  const steps: Step[] = [];
  for (let index = 1; index < tokens.length;) {
    const operator = tokens[index++].value;
    const token = tokens[index++];
    if (operator === "$" || operator === "@") {
      const value = literalName(token);
      if (!value) return undefined;
      steps.push({ operator, value });
    } else if (operator === "[[") {
      const value = token?.type === TokenType.Number ? Number(token.value.replace(/L$/, ""))
        : token?.type === TokenType.String || token?.type === TokenType.RawString ? literalName(token) : undefined;
      if (value === undefined || (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1)) ||
          tokens[index++]?.value !== "]]") return undefined;
      steps.push({ operator, value });
    } else return undefined;
  }
  return { name, steps };
}

export async function inspectSessionCompletion(
  expression: string, kind: SessionCompletionKind, request: Request, workspace?: WorkspaceData
): Promise<SessionCompletionData | undefined> {
  const target = inspectionPath(expression);
  if (!target || target.steps.length > MAX_INSPECTION_DEPTH) return undefined;
  if (kind === "subscript" || kind === "doubleSubscript") {
    // Lookup a visible S3 method by name through the supported sess hover.
    // Installed, non-exported package methods are resolved by the LSP process.
    if (target.steps.length) return undefined;
    const classes = workspace?.globalenv[target.name]?.class;
    if (!Array.isArray(classes)) return undefined;
    const usable = classes.slice(0, 4).filter(name => typeof name === "string" &&
      /^(?:[A-Za-z]|\.(?![0-9]))[A-Za-z0-9._]*$/.test(name));
    const prefix = kind === "subscript" ? "[." : "[[.";
    for (const className of usable) {
      const methodName = "`" + prefix + className + "`";
      const result = await request("hover", { expr: methodName }) as { str?: unknown } | undefined;
      if (typeof result?.str === "string" && /^\s*function\s*\(/.test(result.str)) {
        return { signature: result.str, classes: usable };
      }
    }
    return { classes: usable };
  }
  if (kind === "function") {
    if (target.steps.some(step => step.operator === "[[")) return undefined;
    if (!target.steps.length && workspace?.globalenv) {
      const item = workspace.globalenv[target.name];
      if (!item || !["closure", "builtin", "special"].includes(item.type ?? "")) return undefined;
    }
    const result = await request("hover", { expr: expression }) as { str?: unknown } | undefined;
    return typeof result?.str === "string" && /^\s*function\s*\(/.test(result.str)
      ? { signature: result.str } : undefined;
  }

  // Nested object inspection may call user-defined extraction/format methods.
  // Automatic member and column completions use cached workspace names or LSP.
  return undefined;
}
