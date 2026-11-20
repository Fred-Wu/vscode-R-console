import { tokenize, TokenType, type Token } from "../../../Language/lexer";
import type { SessionCompletionData, SessionCompletionKind, SessionMemberCompletionItem, WorkspaceData } from "../types";

type Selector = { kind: "index" | "name" | "slot"; value: string | number; name?: string };
type Step = { operator: "$" | "@" | "[["; value: string | number };
type Child = { selector: Selector; class?: string | string[]; type?: string };
type Request = (method: "hover" | "workspace_children", params: Record<string, unknown>) => Promise<unknown>;

// A sess request already has its own timeout. Bound the *total* amount of
// sequential child paging that can block one interactive completion.
const MAX_INSPECTION_PAGES = 64;
const MAX_INSPECTION_DURATION_MS = 2000;
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
  if (kind === "function") {
    if (target.steps.some(step => step.operator === "[[")) return undefined;
    const result = await request("hover", { expr: expression }) as { str?: unknown } | undefined;
    return typeof result?.str === "string" && /^\s*function\s*\(/.test(result.str)
      ? { signature: result.str } : undefined;
  }

  const path: Selector[] = [];
  const deadline = Date.now() + MAX_INSPECTION_DURATION_MS;
  let pages = 0;
  let metadata: { class?: string | string[]; type?: string } | undefined = workspace?.globalenv[target.name];
  // sess workspace_children serializes class vectors as one comma-separated
  // string, unlike top-level workspace metadata which carries an array.
  const classNames = (classes: string | string[] | undefined): string[] | undefined =>
    classes === undefined ? undefined : (Array.isArray(classes) ? classes : [classes])
      .flatMap(value => value.split(",").map(name => name.trim()).filter(Boolean));
  // Use selectors returned by sess: list indices, environment names and S4
  // slots have different meanings even when their displayed names are equal.
  for (let depth = 0; depth <= target.steps.length; depth++) {
    const step = target.steps[depth];
    if (!step && kind === "members" && metadata?.type &&
        !["list", "pairlist", "environment"].includes(metadata.type)) return { members: [] };
    const names: string[] = [];
    const members: SessionMemberCompletionItem[] = [];
    let selected: Child | undefined;
    let start = 1;
    do {
      if (pages >= MAX_INSPECTION_PAGES || Date.now() >= deadline) {
        if (step) return undefined;
        return kind === "columns" ? { names, class: classNames(metadata?.class), incomplete: true }
          : { members, incomplete: true };
      }
      pages++;
      const result = await request("workspace_children", { name: target.name, path: [...path], start }) as
        { children?: Child[]; next_start?: unknown } | undefined;
      if (!Array.isArray(result?.children)) return undefined;
      for (const child of result.children) {
        const selector = child?.selector;
        if (!selector || !["index", "name", "slot"].includes(selector.kind)) continue;
        const name = selector.kind === "index" ? selector.name : selector.value;
        if (!step) {
          if (typeof name === "string" && name) {
            if (kind === "columns") names.push(name);
            else if (kind === "slots" ? selector.kind === "slot" : selector.kind !== "slot") {
              members.push({ name, type: child.type });
            }
          }
        } else if (step.operator === "@" ? selector.kind === "slot" && selector.value === step.value
          : selector.kind !== "slot" && (typeof step.value === "number"
            ? selector.kind === "index" && selector.value === step.value : name === step.value)) {
          selected = child;
          break;
        }
      }
      if (selected) break;
      if (result.next_start == null) break;
      if (!Number.isSafeInteger(result.next_start) || (result.next_start as number) <= start) return undefined;
      start = result.next_start as number;
    } while (true);
    if (!step) return kind === "columns"
      ? { names, class: classNames(metadata?.class) }
      : { members };
    if (!selected) return undefined;
    metadata = selected;
    path.push(selected.selector);
  }
  return undefined;
}
