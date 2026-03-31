import { ANSI } from "./ansi";
import type { DocumentSemanticTokensResult } from "../Language/consoleLspClient";
import type { RendererLineHighlighter } from "./renderer";
import { SyntaxTheme } from "./syntaxTheme";

type SemanticProvider = (content: string) => Promise<DocumentSemanticTokensResult | undefined>;

const LIVE_SCOPES = {
  comment: ["comment.line.number-sign.r", "comment"],
  function: ["entity.name.function.r", "entity.name.function", "support.function"],
  identifier: ["variable.other.r", "variable.other", "variable"],
  number: ["constant.numeric.float.decimal.r", "constant.numeric"],
  operator: ["keyword.operator.assignment.r", "keyword.operator.other.r", "keyword.operator"],
  string: ["string.quoted.double.r", "string"],
} as const;

const SEMANTIC_SCOPES: Record<string, string[]> = {
  namespace: ["support.namespace.r", "entity.name.namespace", "support.type", "entity.name.type"],
  type: ["support.type", "entity.name.type", "support.class", "entity.name.class"],
  class: ["support.class", "entity.name.class", "support.type", "entity.name.type"],
  enum: ["support.type", "entity.name.type", "constant.language"],
  interface: ["support.type", "entity.name.type", "support.class", "entity.name.class"],
  struct: ["support.type", "entity.name.type", "support.class", "entity.name.class"],
  typeParameter: ["entity.name.type", "support.type"],
  parameter: ["variable.parameter.r", "variable.parameter", "variable.other", "variable"],
  variable: ["variable.other.r", "variable.other", "variable"],
  property: ["variable.other.property", "variable.other", "variable"],
  function: ["entity.name.function.r", "entity.name.function", "support.function"],
  method: ["entity.name.function.r", "entity.name.function", "support.function"],
  keyword: ["keyword.control.r", "keyword.control", "keyword"],
  comment: ["comment.line.number-sign.r", "comment"],
  string: ["string.quoted.double.r", "string"],
  number: ["constant.numeric.float.decimal.r", "constant.numeric"],
  regexp: ["string.regexp", "string"],
  operator: ["keyword.operator.assignment.r", "keyword.operator.other.r", "keyword.operator"],
};

export class ConsoleSyntax implements RendererLineHighlighter {
  private readonly theme = new SyntaxTheme();
  private readonly semanticCache = new Map<string, DocumentSemanticTokensResult>();
  private readonly pendingSemantics = new Map<string, Promise<DocumentSemanticTokensResult | undefined>>();
  private sourceLines: string[] = [];
  private sourceKey = "";
  private styles: string[][] = [];
  private exactSemanticKey = "";
  private requestVersion = 0;

  constructor(
    private readonly onDidChange: () => void,
    private readonly requestSemantics?: SemanticProvider
  ) {}

  setSource(lines: string[]): void {
    const nextLines = [...lines];
    const nextKey = nextLines.join("\n");
    if (nextKey === this.sourceKey) {
      return;
    }

    const previousLines = this.sourceLines;
    const previousStyles = this.styles;
    this.sourceLines = nextLines;
    this.sourceKey = nextKey;
    this.exactSemanticKey = "";
    this.styles = this.buildLiveStyles(nextLines);
    preserveUnchangedStyles(previousLines, previousStyles, nextLines, this.styles);

    if (!nextKey.trim() || !this.requestSemantics) {
      this.requestVersion += 1;
      return;
    }

    const requestVersion = ++this.requestVersion;
    void this.applyCurrentSemantic(nextKey, requestVersion);
  }

  invalidateTheme(): void {
    this.theme.invalidate();
    this.styles = this.buildLiveStyles(this.sourceLines);
    this.exactSemanticKey = "";

    if (!this.sourceKey.trim() || !this.requestSemantics) {
      this.onDidChange();
      return;
    }

    const requestVersion = ++this.requestVersion;
    void this.applyCurrentSemantic(this.sourceKey, requestVersion);
  }

  dispose(): void {
    this.theme.invalidate();
    this.semanticCache.clear();
    this.pendingSemantics.clear();
    this.sourceLines = [];
    this.sourceKey = "";
    this.styles = [];
    this.exactSemanticKey = "";
    this.requestVersion += 1;
  }

  highlightLines(lines: string[], sourceLineMap?: Array<number | undefined>): string[] {
    const defaultAnsi = this.theme.getDefaultAnsi();

    return lines.map((displayLine, index) => {
      const sourceLineIndex = sourceLineMap ? sourceLineMap[index] : index;
      if (sourceLineIndex === undefined) {
        return this.applyStyles(displayLine, new Array(displayLine.length).fill(defaultAnsi));
      }

      const sourceLine = this.sourceLines[sourceLineIndex];
      const sourceStyles = this.styles[sourceLineIndex];
      const fallbackStyles = new Array(displayLine.length).fill(defaultAnsi);
      if (sourceLine === undefined || !sourceStyles || sourceStyles.length === 0) {
        return this.applyStyles(displayLine, fallbackStyles);
      }

      if (displayLine === sourceLine && sourceStyles.length === displayLine.length) {
        return this.applyStyles(displayLine, sourceStyles);
      }

      if (
        displayLine.endsWith("...") &&
        sourceLine.startsWith(displayLine.slice(0, -3)) &&
        displayLine.length >= 3
      ) {
        const prefixLength = displayLine.length - 3;
        return this.applyStyles(
          displayLine,
          sourceStyles.slice(0, prefixLength).concat([defaultAnsi, defaultAnsi, defaultAnsi])
        );
      }

      return this.applyStyles(displayLine, fallbackStyles);
    });
  }

  prepareSnapshot(input: string | string[]): Promise<string[]> {
    const lines = Array.isArray(input) ? [...input] : input.split("\n");
    const sourceKey = lines.join("\n");

    if (!sourceKey.trim()) {
      return Promise.resolve(lines);
    }

    if (sourceKey === this.sourceKey && this.exactSemanticKey === sourceKey) {
      return Promise.resolve(lines.map((line, index) => this.applyStyles(line, this.styles[index] ?? [])));
    }

    return this.buildSnapshot(lines, sourceKey);
  }

  snapshotNow(input: string | string[]): string[] {
    const lines = Array.isArray(input) ? [...input] : input.split("\n");
    const sourceKey = lines.join("\n");

    if (sourceKey === this.sourceKey && this.exactSemanticKey === sourceKey) {
      return lines.map((line, index) => this.applyStyles(line, this.styles[index] ?? []));
    }

    const styles = this.buildLiveStyles(lines);
    return lines.map((line, index) => this.applyStyles(line, styles[index] ?? []));
  }

  private async buildSnapshot(lines: string[], sourceKey: string): Promise<string[]> {
    const styles = this.buildLiveStyles(lines);
    const semanticTokens = await this.getSemanticTokens(sourceKey);
    if (semanticTokens) {
      this.applySemanticStyles(styles, semanticTokens);
    }
    return lines.map((line, index) => this.applyStyles(line, styles[index] ?? []));
  }

  private async applyCurrentSemantic(sourceKey: string, requestVersion: number): Promise<void> {
    const semanticTokens = await this.getSemanticTokens(sourceKey);
    if (
      !semanticTokens ||
      requestVersion !== this.requestVersion ||
      sourceKey !== this.sourceKey
    ) {
      return;
    }

    const styles = this.buildLiveStyles(this.sourceLines);
    this.applySemanticStyles(styles, semanticTokens);
    this.styles = styles;
    this.exactSemanticKey = sourceKey;
    this.onDidChange();
  }

  private async getSemanticTokens(sourceKey: string): Promise<DocumentSemanticTokensResult | undefined> {
    const cached = this.semanticCache.get(sourceKey);
    if (cached) {
      return cached;
    }

    if (!this.requestSemantics) {
      return undefined;
    }

    const pending = this.pendingSemantics.get(sourceKey);
    if (pending) {
      return pending;
    }

    const request = this.requestSemantics(sourceKey)
      .then((result) => {
        if (result) {
          this.semanticCache.set(sourceKey, result);
          trimSemanticCache(this.semanticCache);
        }
        return result;
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.pendingSemantics.get(sourceKey) === request) {
          this.pendingSemantics.delete(sourceKey);
        }
      });

    this.pendingSemantics.set(sourceKey, request);
    return request;
  }

  private buildLiveStyles(lines: string[]): string[][] {
    const defaultAnsi = this.theme.getDefaultAnsi();
    const palette = {
      comment: this.theme.resolveScopesToAnsi(LIVE_SCOPES.comment) || defaultAnsi,
      function: this.theme.resolveScopesToAnsi(LIVE_SCOPES.function) || defaultAnsi,
      identifier: this.theme.resolveScopesToAnsi(LIVE_SCOPES.identifier) || defaultAnsi,
      number: this.theme.resolveScopesToAnsi(LIVE_SCOPES.number) || defaultAnsi,
      operator: this.theme.resolveScopesToAnsi(LIVE_SCOPES.operator) || defaultAnsi,
      string: this.theme.resolveScopesToAnsi(LIVE_SCOPES.string) || defaultAnsi,
    };

    return lines.map((line) => lexLine(line, defaultAnsi, palette));
  }

  private applySemanticStyles(styles: string[][], semanticTokens: DocumentSemanticTokensResult): void {
    let line = 0;
    let char = 0;

    for (let index = 0; index + 4 < semanticTokens.data.length; index += 5) {
      const deltaLine = semanticTokens.data[index];
      const deltaStart = semanticTokens.data[index + 1];
      const length = semanticTokens.data[index + 2];
      const tokenTypeIndex = semanticTokens.data[index + 3];
      const tokenModifierBits = semanticTokens.data[index + 4];
      const tokenType = semanticTokens.legend.tokenTypes[tokenTypeIndex];
      const tokenModifiers = decodeTokenModifiers(
        tokenModifierBits,
        semanticTokens.legend.tokenModifiers
      );

      line += deltaLine;
      char = deltaLine === 0 ? char + deltaStart : deltaStart;

      if (!tokenType || line < 0 || line >= styles.length || length <= 0) {
        continue;
      }

      const ansi =
        this.theme.resolveSemanticTokenToAnsi(tokenType, tokenModifiers) ||
        this.theme.resolveScopesToAnsi(SEMANTIC_SCOPES[tokenType] ?? []);
      if (!ansi) {
        continue;
      }

      const row = styles[line];
      const end = Math.min(row.length, char + length);
      for (let cursor = Math.max(0, char); cursor < end; cursor += 1) {
        row[cursor] = ansi;
      }
    }
  }

  private applyStyles(text: string, styles: string[]): string {
    if (text.length === 0 || styles.length === 0) {
      return text;
    }

    let result = "";
    let currentStyle = "";

    for (let index = 0; index < text.length; index += 1) {
      const nextStyle = styles[index] ?? "";
      if (nextStyle !== currentStyle) {
        if (currentStyle) {
          result += ANSI.reset;
        }
        if (nextStyle) {
          result += nextStyle;
        }
        currentStyle = nextStyle;
      }
      result += text[index];
    }

    if (currentStyle) {
      result += ANSI.reset;
    }

    return result;
  }
}

function decodeTokenModifiers(bits: number, legend: readonly string[]): string[] {
  const modifiers: string[] = [];
  for (let index = 0; index < legend.length; index += 1) {
    if ((bits & (1 << index)) !== 0) {
      modifiers.push(legend[index]);
    }
  }
  return modifiers;
}

function lexLine(
  line: string,
  defaultAnsi: string,
  palette: {
    comment: string;
    function: string;
    identifier: string;
    number: string;
    operator: string;
    string: string;
  }
): string[] {
  const styles = new Array(line.length).fill(defaultAnsi);
  let index = 0;

  while (index < line.length) {
    const char = line[index];

    if (char === "#") {
      for (let cursor = index; cursor < line.length; cursor += 1) {
        styles[cursor] = palette.comment;
      }
      break;
    }

    if ((char === "r" || char === "R") && index + 1 < line.length) {
      const rawStringEnd = findRawStringEnd(line, index);
      if (rawStringEnd !== null) {
        for (let cursor = index; cursor < rawStringEnd; cursor += 1) {
          styles[cursor] = palette.string;
        }
        index = Math.max(index + 1, rawStringEnd);
        continue;
      }
    }

    if (char === "\"" || char === "'" || char === "`") {
      const quote = char;
      let end = index + 1;
      let escaped = false;
      while (end < line.length) {
        const next = line[end];
        if (!escaped && next === quote) {
          end += 1;
          break;
        }
        if (next === "\\" && !escaped) {
          escaped = true;
        } else {
          escaped = false;
        }
        end += 1;
      }
      for (let cursor = index; cursor < Math.min(end, line.length); cursor += 1) {
        styles[cursor] = palette.string;
      }
      index = Math.max(index + 1, end);
      continue;
    }

    if (isIdentifierStart(char, index === 0 ? undefined : line[index - 1])) {
      let end = index + 1;
      while (end < line.length && isIdentifierContinue(line[end])) {
        end += 1;
      }
      const style = isCallHead(line, end) ? palette.function : palette.identifier;
      for (let cursor = index; cursor < end; cursor += 1) {
        styles[cursor] = style;
      }
      index = end;
      continue;
    }

    if (isNumberStart(line, index)) {
      let end = index + 1;
      while (end < line.length && /[0-9A-Fa-fxXbBeE.+-]/.test(line[end])) {
        end += 1;
      }
      for (let cursor = index; cursor < end; cursor += 1) {
        styles[cursor] = palette.number;
      }
      index = end;
      continue;
    }

    if (isOperatorChar(char)) {
      let end = index + 1;
      while (end < line.length && isOperatorChar(line[end])) {
        end += 1;
      }
      for (let cursor = index; cursor < end; cursor += 1) {
        styles[cursor] = palette.operator;
      }
      index = end;
      continue;
    }

    index += 1;
  }

  return styles;
}

function preserveUnchangedStyles(
  previousLines: string[],
  previousStyles: string[][],
  nextLines: string[],
  nextStyles: string[][]
): void {
  if (previousLines.length === 0 || previousStyles.length === 0) {
    return;
  }

  const prefixLineCount = sharedPrefixLineCount(previousLines, nextLines);
  const suffixLineCount = sharedSuffixLineCount(previousLines, nextLines, prefixLineCount);

  for (let lineIndex = 0; lineIndex < prefixLineCount; lineIndex += 1) {
    copyWholeLineStyle(previousLines, previousStyles, nextLines, nextStyles, lineIndex, lineIndex);
  }

  for (let offset = 0; offset < suffixLineCount; offset += 1) {
    const previousIndex = previousLines.length - suffixLineCount + offset;
    const nextIndex = nextLines.length - suffixLineCount + offset;
    copyWholeLineStyle(previousLines, previousStyles, nextLines, nextStyles, previousIndex, nextIndex);
  }
}

function copyWholeLineStyle(
  previousLines: string[],
  previousStyles: string[][],
  nextLines: string[],
  nextStyles: string[][],
  previousIndex: number,
  nextIndex: number
): void {
  const previousStyle = previousStyles[previousIndex];
  const previousLine = previousLines[previousIndex];
  const nextLine = nextLines[nextIndex];
  if (!previousStyle || previousLine === undefined || nextLine === undefined || previousLine.length !== nextLine.length) {
    return;
  }
  nextStyles[nextIndex] = previousStyle.slice();
}

function trimSemanticCache(cache: Map<string, DocumentSemanticTokensResult>): void {
  while (cache.size > 20) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

function isIdentifierStart(char: string, previousChar?: string): boolean {
  if (/[A-Za-z_]/.test(char)) {
    return true;
  }
  return char === "." && (previousChar === undefined || !/[A-Za-z0-9._]/.test(previousChar));
}

function isIdentifierContinue(char: string): boolean {
  return /[A-Za-z0-9._]/.test(char);
}

function isCallHead(line: string, end: number): boolean {
  let index = end;
  while (index < line.length && /\s/.test(line[index])) {
    index += 1;
  }
  return line[index] === "(";
}

function isNumberStart(line: string, index: number): boolean {
  const char = line[index];
  if (!/[0-9]/.test(char)) {
    return false;
  }
  const previous = index > 0 ? line[index - 1] : "";
  return previous.length === 0 || !/[A-Za-z0-9._]/.test(previous);
}

function isOperatorChar(char: string): boolean {
  return /[+\-*/^<>=!$@~:%&|]/.test(char);
}

function findRawStringEnd(line: string, start: number): number | null {
  const quote = line[start + 1];
  if (quote !== "\"" && quote !== "'") {
    return null;
  }

  let index = start + 2;
  let delimiter = "";
  if (index < line.length) {
    const marker = line[index];
    if (marker === "(" || marker === "[" || marker === "{") {
      delimiter = marker;
      index += 1;
    } else if (marker === "-") {
      while (index < line.length && line[index] === "-") {
        delimiter += "-";
        index += 1;
      }
    }
  }

  const closeDelimiter =
    delimiter === "("
      ? ")"
      : delimiter === "["
        ? "]"
        : delimiter === "{"
          ? "}"
          : delimiter;

  while (index < line.length) {
    if (!delimiter) {
      if (line[index] === quote) {
        return index + 1;
      }
      index += 1;
      continue;
    }

    if (line.startsWith(closeDelimiter, index)) {
      const closingSequence = `${closeDelimiter}${quote}`;
      if (line.startsWith(closingSequence, index)) {
        return index + closingSequence.length;
      }
    }
    index += 1;
  }

  return line.length;
}

function sharedPrefixLineCount(previousLines: string[], nextLines: string[]): number {
  const sharedLength = Math.min(previousLines.length, nextLines.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (previousLines[index] !== nextLines[index]) {
      return index;
    }
  }
  return sharedLength;
}

function sharedSuffixLineCount(
  previousLines: string[],
  nextLines: string[],
  prefixLineCount: number
): number {
  const previousRemaining = previousLines.length - prefixLineCount;
  const nextRemaining = nextLines.length - prefixLineCount;
  const sharedLength = Math.min(previousRemaining, nextRemaining);
  let count = 0;
  while (count < sharedLength) {
    if (
      previousLines[previousLines.length - 1 - count] !==
      nextLines[nextLines.length - 1 - count]
    ) {
      break;
    }
    count += 1;
  }
  return count;
}
