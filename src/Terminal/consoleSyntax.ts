import { ANSI } from "./ansi";
import type { DocumentSemanticTokensResult } from "../Language/semanticTokens";
import { tokenizeForHighlighting, type HighlightTokenKind } from "../Language/parser";
import type { RendererLineHighlighter } from "./renderer";
import { SyntaxTheme } from "./syntaxTheme";

type SemanticProvider = (content: string) => Promise<DocumentSemanticTokensResult | undefined>;

export class ConsoleSyntax implements RendererLineHighlighter {
  private readonly theme = new SyntaxTheme();
  private sourceLines: string[] = [];
  private sourceKey = "";
  private styles: string[][] = [];
  private sourceVersion = 0;
  private appliedSemanticVersion = 0;
  private wantedSemanticVersion = 0;
  private semanticRequestInFlight = false;
  private semanticRequestsPaused = false;

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
    this.styles = this.buildPendingStyles(previousLines, previousStyles, nextLines);
    this.appliedSemanticVersion = 0;

    const sourceVersion = ++this.sourceVersion;
    if (!nextKey.trim() || !this.requestSemantics) {
      this.wantedSemanticVersion = 0;
      return;
    }

    this.wantedSemanticVersion = sourceVersion;
    void this.runLatestSemanticRequest();
  }

  invalidateTheme(): void {
    this.theme.invalidate();
    this.styles = this.buildBaseStyles(this.sourceLines);
    this.appliedSemanticVersion = 0;
    const sourceVersion = ++this.sourceVersion;

    if (!this.sourceKey.trim() || !this.requestSemantics) {
      this.wantedSemanticVersion = 0;
      this.onDidChange();
      return;
    }

    this.wantedSemanticVersion = sourceVersion;
    void this.runLatestSemanticRequest();
  }

  dispose(): void {
    this.theme.invalidate();
    this.sourceLines = [];
    this.sourceKey = "";
    this.styles = [];
    this.appliedSemanticVersion = 0;
    this.sourceVersion += 1;
    this.wantedSemanticVersion = 0;
    this.semanticRequestInFlight = false;
    this.semanticRequestsPaused = false;
  }

  pauseSemanticRequests(): void {
    this.semanticRequestsPaused = true;
    this.wantedSemanticVersion = 0;
  }

  resumeSemanticRequests(): void {
    if (!this.semanticRequestsPaused) {
      return;
    }

    this.semanticRequestsPaused = false;
    if (!this.sourceKey.trim() || !this.requestSemantics) {
      return;
    }

    this.wantedSemanticVersion = ++this.sourceVersion;
    void this.runLatestSemanticRequest();
  }

  highlightLines(lines: string[], sourceLineMap?: Array<number | undefined>): string[] {
    return lines.map((displayLine, index) => {
      const sourceLineIndex = sourceLineMap ? sourceLineMap[index] : index;
      if (sourceLineIndex === undefined) {
        return this.applyStyles(displayLine, this.buildDefaultStyles(displayLine));
      }

      const sourceLine = this.sourceLines[sourceLineIndex];
      const sourceStyles = this.styles[sourceLineIndex];
      const fallbackStyles = this.buildDefaultStyles(displayLine);
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
          sourceStyles
            .slice(0, prefixLength)
            .concat(this.buildDefaultStyles("..."))
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

    if (sourceKey === this.sourceKey && this.appliedSemanticVersion === this.sourceVersion) {
      return Promise.resolve(
        lines.map((line, index) => this.applyStyles(line, this.styles[index] ?? []))
      );
    }

    return this.buildSnapshot(lines, sourceKey);
  }

  snapshotNow(input: string | string[]): string[] {
    const lines = Array.isArray(input) ? [...input] : input.split("\n");
    const sourceKey = lines.join("\n");

    if (sourceKey === this.sourceKey && this.appliedSemanticVersion === this.sourceVersion) {
      return lines.map((line, index) => this.applyStyles(line, this.styles[index] ?? []));
    }

    const styles = this.buildBaseStyles(lines);
    return lines.map((line, index) => this.applyStyles(line, styles[index] ?? []));
  }

  private async buildSnapshot(lines: string[], sourceKey: string): Promise<string[]> {
    const styles = this.buildBaseStyles(lines);
    const semanticTokens = this.requestSemantics && !this.semanticRequestsPaused
      ? await this.requestSemantics(sourceKey)
      : undefined;
    if (semanticTokens) {
      this.applySemanticStyles(styles, semanticTokens);
    }
    return lines.map((line, index) => this.applyStyles(line, styles[index] ?? []));
  }

  private async runLatestSemanticRequest(): Promise<void> {
    if (
      this.semanticRequestsPaused ||
      this.semanticRequestInFlight ||
      !this.requestSemantics
    ) {
      return;
    }

    this.semanticRequestInFlight = true;
    try {
      while (
        this.wantedSemanticVersion > 0 &&
        this.wantedSemanticVersion > this.appliedSemanticVersion &&
        !this.semanticRequestsPaused
      ) {
        const requestedVersion = this.wantedSemanticVersion;
        const requestedContent = this.sourceKey;
        let semanticTokens: DocumentSemanticTokensResult | undefined;
        try {
          semanticTokens = await this.requestSemantics(requestedContent);
        } catch {
          semanticTokens = undefined;
        }

        if (this.semanticRequestsPaused) {
          continue;
        }

        if (requestedVersion !== this.sourceVersion) {
          continue;
        }

        if (!semanticTokens) {
          this.appliedSemanticVersion = requestedVersion;
          continue;
        }

        const styles = this.buildBaseStyles(this.sourceLines);
        this.applySemanticStyles(styles, semanticTokens);
        this.styles = styles;
        this.appliedSemanticVersion = requestedVersion;
        this.onDidChange();
      }
    } finally {
      this.semanticRequestInFlight = false;
      if (
        !this.semanticRequestsPaused &&
        this.wantedSemanticVersion > 0 &&
        this.wantedSemanticVersion > this.appliedSemanticVersion
      ) {
        void this.runLatestSemanticRequest();
      }
    }
  }

  private buildBaseStyles(lines: string[]): string[][] {
    const styles = lines.map((line) => this.buildDefaultStyles(line));
    this.applyLiveTokenStyles(lines, styles);
    this.applyBracketPairStyles(lines, styles);
    return styles;
  }

  private buildDefaultStyles(line: string): string[] {
    return new Array(line.length).fill(this.theme.resolveDefaultForegroundAnsi());
  }

  private buildPendingStyles(
    previousLines: readonly string[],
    previousStyles: readonly string[][],
    nextLines: readonly string[]
  ): string[][] {
    const styles = this.buildBaseStyles([...nextLines]);

    for (let index = 0; index < nextLines.length; index += 1) {
      const line = nextLines[index] ?? "";
      const previousLine = previousLines[index];
      const previousRow = previousStyles[index];
      if (previousLine === undefined || previousRow === undefined) {
        continue;
      }

      if (previousLine === line && previousRow.length === line.length) {
        styles[index] = [...previousRow];
        continue;
      }

      styles[index] = this.remapLineStyles(
        previousLine,
        previousRow,
        line,
        styles[index] ?? []
      );
    }

    this.applyBracketPairStyles(nextLines, styles);
    return styles;
  }

  private remapLineStyles(
    previousLine: string,
    previousRow: string[],
    nextLine: string,
    baseRow: string[]
  ): string[] {
    const row = baseRow.length === nextLine.length ? [...baseRow] : this.buildDefaultStyles(nextLine);
    const prefixLength = commonPrefixLength(previousLine, nextLine);
    const suffixLength = commonSuffixLength(previousLine, nextLine, prefixLength);
    const changedStart = prefixLength;
    const changedEnd = nextLine.length - suffixLength;
    const rebuiltStart = expandWordStart(nextLine, changedStart);
    const rebuiltEnd = expandWordEnd(nextLine, changedEnd);

    for (let index = 0; index < prefixLength; index += 1) {
      if (index >= rebuiltStart && index < rebuiltEnd) {
        continue;
      }
      row[index] = previousRow[index] ?? row[index];
    }

    for (let index = 0; index < suffixLength; index += 1) {
      const previousIndex = previousLine.length - suffixLength + index;
      const nextIndex = nextLine.length - suffixLength + index;
      if (nextIndex >= rebuiltStart && nextIndex < rebuiltEnd) {
        continue;
      }
      row[nextIndex] = previousRow[previousIndex] ?? row[nextIndex];
    }

    this.extendEditedTokenStyle(previousLine, previousRow, nextLine, row, prefixLength, suffixLength);

    return row;
  }

  private extendEditedTokenStyle(
    previousLine: string,
    previousRow: string[],
    nextLine: string,
    row: string[],
    prefixLength: number,
    suffixLength: number
  ): void {
    const nextChangedEnd = nextLine.length - suffixLength;
    const previousChangedEnd = previousLine.length - suffixLength;
    if (nextChangedEnd <= prefixLength) {
      return;
    }

    const inserted = nextLine.slice(prefixLength, nextChangedEnd);
    if (!isWordLikeSegment(inserted)) {
      return;
    }

    const leftChar = prefixLength > 0 ? nextLine[prefixLength - 1] : "";
    const rightChar = nextChangedEnd < nextLine.length ? nextLine[nextChangedEnd] : "";
    const leftStyle = prefixLength > 0 && isWordLikeChar(leftChar) ? row[prefixLength - 1] ?? "" : "";
    const rightStyle =
      nextChangedEnd < nextLine.length && isWordLikeChar(rightChar)
        ? row[nextChangedEnd] ?? ""
        : "";

    const previousLeftStyle =
      prefixLength > 0 && isWordLikeChar(previousLine[prefixLength - 1] ?? "")
        ? previousRow[prefixLength - 1] ?? ""
        : "";
    const previousRightStyle =
      previousChangedEnd < previousLine.length && isWordLikeChar(previousLine[previousChangedEnd] ?? "")
        ? previousRow[previousChangedEnd] ?? ""
        : "";

    const candidate = firstNonEmptyStyle([
      leftStyle,
      rightStyle,
      previousLeftStyle,
      previousRightStyle,
    ]);
    if (!candidate) {
      return;
    }

    for (let index = prefixLength; index < nextChangedEnd; index += 1) {
      row[index] = candidate;
    }
  }

  private applySemanticStyles(
    styles: string[][],
    semanticTokens: DocumentSemanticTokensResult
  ): void {
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

      const ansi = this.theme.resolveSemanticTokenToAnsi(tokenType, tokenModifiers);
      if (!ansi) {
        continue;
      }

      const row = styles[line];
      const end = Math.min(row.length, char + length);
      for (let cursor = Math.max(0, char); cursor < end; cursor += 1) {
        row[cursor] = ansi;
      }
    }

    this.applyBracketPairStyles(this.sourceLines, styles);
  }

  private applyLiveTokenStyles(lines: readonly string[], styles: string[][]): void {
    if (lines.length === 0) {
      return;
    }

    const source = lines.join("\n");
    const lineStarts = buildLineStarts(lines);
    let lineIndex = 0;

    for (const token of tokenizeForHighlighting(source)) {
      const ansi = this.resolveLiveTokenAnsi(token.kind);
      if (!ansi) {
        continue;
      }

      while (
        lineIndex + 1 < lineStarts.length &&
        token.position >= lineStarts[lineIndex + 1]
      ) {
        lineIndex += 1;
      }

      this.applyTokenStyle(styles, lineStarts, lineIndex, token.position, token.value, ansi);
    }
  }

  private applyBracketPairStyles(lines: readonly string[], styles: string[][]): void {
    const stack: string[] = [];
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";
      const row = styles[lineIndex];
      if (!row) {
        continue;
      }

      let escaped = false;
      for (let cursor = 0; cursor < line.length; cursor += 1) {
        const char = line[cursor];

        if (!inSingleQuote && !inDoubleQuote && !inBacktick && char === "#") {
          break;
        }

        if (escaped) {
          escaped = false;
          continue;
        }

        if ((inSingleQuote || inDoubleQuote) && char === "\\") {
          escaped = true;
          continue;
        }

        if (!inDoubleQuote && !inBacktick && char === "'") {
          inSingleQuote = !inSingleQuote;
          continue;
        }
        if (!inSingleQuote && !inBacktick && char === "\"") {
          inDoubleQuote = !inDoubleQuote;
          continue;
        }
        if (!inSingleQuote && !inDoubleQuote && char === "`") {
          inBacktick = !inBacktick;
          continue;
        }

        if (inSingleQuote || inDoubleQuote || inBacktick) {
          continue;
        }

        const close = OPEN_TO_CLOSE[char];
        if (close) {
          const ansi = this.theme.resolveBracketPairAnsi(stack.length);
          if (ansi) {
            row[cursor] = ansi;
          }
          stack.push(close);
          continue;
        }

        if (!CLOSING_BRACKETS.has(char)) {
          continue;
        }

        const current = stack[stack.length - 1];
        const depth = current === char ? Math.max(stack.length - 1, 0) : Math.max(stack.length - 1, 0);
        const ansi = this.theme.resolveBracketPairAnsi(depth);
        if (ansi) {
          row[cursor] = ansi;
        }
        if (current === char) {
          stack.pop();
        }
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

  private resolveLiveTokenAnsi(kind: HighlightTokenKind): string {
    switch (kind) {
      case "comment":
        return this.theme.resolveSemanticTokenToAnsi("comment", []);
      case "string":
        return this.theme.resolveSemanticTokenToAnsi("string", []);
      case "number":
        return this.theme.resolveSemanticTokenToAnsi("number", []);
      case "function":
        return (
          this.theme.resolveSemanticTokenToAnsi("function", []) ||
          this.theme.resolveSemanticTokenToAnsi("method", []) ||
          this.theme.resolveSemanticTokenToAnsi("variable", []) ||
          this.theme.resolveDefaultForegroundAnsi()
        );
      case "keyword":
        return this.theme.resolveSemanticTokenToAnsi("keyword", []);
      case "operator":
        return this.theme.resolveSemanticTokenToAnsi("operator", []);
      case "identifier":
        return (
          this.theme.resolveSemanticTokenToAnsi("variable", []) ||
          this.theme.resolveDefaultForegroundAnsi()
        );
    }
  }

  private applyTokenStyle(
    styles: string[][],
    lineStarts: readonly number[],
    startLineIndex: number,
    position: number,
    value: string,
    ansi: string
  ): void {
    const segments = value.split("\n");
    let lineIndex = startLineIndex;
    let column = position - (lineStarts[lineIndex] ?? 0);

    for (const segment of segments) {
      const row = styles[lineIndex];
      if (row) {
        const start = Math.max(0, column);
        const end = Math.min(row.length, column + segment.length);
        for (let cursor = start; cursor < end; cursor += 1) {
          row[cursor] = ansi;
        }
      }

      lineIndex += 1;
      column = 0;
    }
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

const OPEN_TO_CLOSE: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
};

const CLOSING_BRACKETS = new Set([")", "]", "}"]);

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const leftRemaining = left.length - prefixLength;
  const rightRemaining = right.length - prefixLength;
  const limit = Math.min(leftRemaining, rightRemaining);
  let count = 0;
  while (
    count < limit &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

function isWordLikeChar(char: string): boolean {
  return /[A-Za-z0-9._]/.test(char);
}

function expandWordStart(text: string, start: number): number {
  let cursor = Math.max(0, Math.min(start, text.length));
  while (cursor > 0 && isWordLikeChar(text[cursor - 1] ?? "")) {
    cursor -= 1;
  }
  return cursor;
}

function expandWordEnd(text: string, end: number): number {
  let cursor = Math.max(0, Math.min(end, text.length));
  while (cursor < text.length && isWordLikeChar(text[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function isWordLikeSegment(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9._]+$/.test(value);
}

function firstNonEmptyStyle(values: readonly string[]): string {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return "";
}

function buildLineStarts(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let offset = 0;

  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  return starts;
}
