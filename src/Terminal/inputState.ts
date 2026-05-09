import {
  isExpressionCompleteAsync as parserIsExpressionCompleteAsync,
} from "../Language/parser";
import {
  moveCursorByRenderedRows,
  type InputRenderMetrics,
} from "./inputViewport";

export class InputState {
  private _text: string = "";
  private _cursorPosition: number = 0;

  preferredColumn: number | null = null;

  get text(): string {
    return this._text;
  }

  set text(value: string) {
    this._text = value;
    if (this._cursorPosition > value.length) {
      this._cursorPosition = value.length;
    }
  }

  get cursorPosition(): number {
    return this._cursorPosition;
  }

  set cursorPosition(value: number) {
    this._cursorPosition = Math.max(0, Math.min(value, this._text.length));
  }

  get lines(): string[] {
    return this._text.split("\n");
  }

  get cursorRow(): number {
    const textBefore = this._text.slice(0, this._cursorPosition);
    return (textBefore.match(/\n/g) || []).length;
  }

  get cursorCol(): number {
    const textBefore = this._text.slice(0, this._cursorPosition);
    const lastNewline = textBefore.lastIndexOf("\n");
    return lastNewline === -1 ? this._cursorPosition : this._cursorPosition - lastNewline - 1;
  }

  get currentLine(): string {
    return this.lines[this.cursorRow];
  }

  get currentLineBeforeCursor(): string {
    const line = this.currentLine;
    return line.slice(0, this.cursorCol);
  }

  get currentLineAfterCursor(): string {
    const line = this.currentLine;
    return line.slice(this.cursorCol);
  }

  get textBeforeCursor(): string {
    return this._text.slice(0, this._cursorPosition);
  }

  get textAfterCursor(): string {
    return this._text.slice(this._cursorPosition);
  }

  get currentChar(): string {
    return this._text[this._cursorPosition] || "";
  }

  get charBeforeCursor(): string {
    return this._cursorPosition > 0 ? this._text[this._cursorPosition - 1] : "";
  }

  get isAtEnd(): boolean {
    return this._cursorPosition === this._text.length;
  }

  get isAtStart(): boolean {
    return this._cursorPosition === 0;
  }

  private getLineStartIndexes(): number[] {
    const indexes = [0];
    let pos = 0;
    for (const line of this.lines) {
      pos += line.length + 1;
      indexes.push(pos);
    }
    indexes.pop();
    return indexes;
  }

  translateRowColToIndex(row: number, col: number): number {
    const lines = this.lines;
    row = Math.max(0, Math.min(row, lines.length - 1));
    const lineStarts = this.getLineStartIndexes();
    const lineStart = lineStarts[row];
    const line = lines[row];
    col = Math.max(0, Math.min(col, line.length));
    
    return lineStart + col;
  }

  getCursorLeftPosition(count: number = 1): number {
    return -Math.min(this.cursorCol, count);
  }

  getCursorRightPosition(count: number = 1): number {
    return Math.min(count, this.currentLineAfterCursor.length);
  }

  getStartOfLinePosition(): number {
    return -this.cursorCol;
  }

  getEndOfLinePosition(): number {
    return this.currentLine.length - this.cursorCol;
  }

  cursorLeft(count: number = 1): void {
    this._cursorPosition += this.getCursorLeftPosition(count);
    this.preferredColumn = null;
  }

  cursorRight(count: number = 1): void {
    this._cursorPosition += this.getCursorRightPosition(count);
    this.preferredColumn = null;
  }

  autoUp(renderMetrics: InputRenderMetrics): "moved" | "history" {
    return this.moveByRenderedRows(-1, renderMetrics) ? "moved" : "history";
  }

  autoDown(renderMetrics: InputRenderMetrics): "moved" | "history" {
    return this.moveByRenderedRows(1, renderMetrics) ? "moved" : "history";
  }

  cursorToEnd(): void {
    this._cursorPosition = this._text.length;
    this.preferredColumn = null;
  }

  insertText(text: string): void {
    this._text = this._text.slice(0, this._cursorPosition) + text + this._text.slice(this._cursorPosition);
    this._cursorPosition += text.length;
    this.preferredColumn = null;
  }

  deleteBeforeCursor(count: number = 1): string {
    const deleteCount = Math.min(count, this._cursorPosition);
    const deleted = this._text.slice(this._cursorPosition - deleteCount, this._cursorPosition);
    this._text = this._text.slice(0, this._cursorPosition - deleteCount) + this._text.slice(this._cursorPosition);
    this._cursorPosition -= deleteCount;
    this.preferredColumn = null;
    return deleted;
  }

  deleteAfterCursor(count: number = 1): string {
    const deleteCount = Math.min(count, this._text.length - this._cursorPosition);
    const deleted = this._text.slice(this._cursorPosition, this._cursorPosition + deleteCount);
    this._text = this._text.slice(0, this._cursorPosition) + this._text.slice(this._cursorPosition + deleteCount);
    this.preferredColumn = null;
    return deleted;
  }

  reset(): void {
    this._text = "";
    this._cursorPosition = 0;
    this.preferredColumn = null;
  }

  applyHistoryEntry(entry: string | null): void {
    if (entry === null) {
      this._text = "";
      this._cursorPosition = 0;
    } else {
      this._text = entry;
      this._cursorPosition = entry.length;
    }
    this.preferredColumn = null;
  }

  async isExpressionCompleteAsync(code: string = this._text): Promise<boolean> {
    return parserIsExpressionCompleteAsync(code);
  }

  private moveByRenderedRows(
    deltaRows: number,
    renderMetrics: InputRenderMetrics
  ): boolean {
    const result = moveCursorByRenderedRows(
      this.lines,
      this.cursorRow,
      this.cursorCol,
      deltaRows,
      renderMetrics,
      this.preferredColumn ?? undefined
    );
    if (!result.moved) {
      return false;
    }

    this._cursorPosition = this.translateRowColToIndex(result.row, result.col);
    this.preferredColumn = result.preferredColumn;
    return true;
  }

  private static readonly BRACKET_PAIRS: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
    '"': '"',
    "'": "'",
    "`": "`",
    "%": "%",
  };

  private static readonly CLOSING_BRACKETS = new Set([")", "]", "}"]);

  private isCommentOnlyLine(line: string): boolean {
    return /^\s*#/.test(line);
  }

  private getIndentContextLine(fromRow: number): string | null {
    for (let row = fromRow; row >= 0; row -= 1) {
      const line = this.lines[row] ?? "";
      if (!line.trim()) {
        continue;
      }
      if (this.isCommentOnlyLine(line)) {
        continue;
      }
      return line;
    }
    return null;
  }

  isInString(): boolean {
    const beforeCursor = this.textBeforeCursor;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;
    let inPercent = false;
    
    for (let i = 0; i < beforeCursor.length; i++) {
      const ch = beforeCursor[i];
      const escaped = i > 0 && beforeCursor[i - 1] === "\\";
      
      if (!escaped) {
        if (ch === '"' && !inSingleQuote && !inBacktick && !inPercent) {
          inDoubleQuote = !inDoubleQuote;
        } else if (ch === "'" && !inDoubleQuote && !inBacktick && !inPercent) {
          inSingleQuote = !inSingleQuote;
        } else if (ch === '`' && !inDoubleQuote && !inSingleQuote && !inPercent) {
          inBacktick = !inBacktick;
        } else if (ch === '%' && !inDoubleQuote && !inSingleQuote && !inBacktick) {
          inPercent = !inPercent;
        }
      }
    }
    
    return inSingleQuote || inDoubleQuote || inBacktick || inPercent;
  }

  canAutoCloseBracket(): boolean {
    const after = this.currentChar;
    return after === "" || /^[,)}\]\s]/.test(after);
  }

  getClosingBracket(openBracket: string): string | undefined {
    return InputState.BRACKET_PAIRS[openBracket];
  }

  isClosingBracket(ch: string): boolean {
    return InputState.CLOSING_BRACKETS.has(ch);
  }

  isBetweenCurlyBraces(): boolean {
    return this.charBeforeCursor === "{" && this.currentChar === "}";
  }

  isBetweenMatchingPair(): boolean {
    const before = this.charBeforeCursor;
    const after = this.currentChar;
    return (
      (before === "(" && after === ")") ||
      (before === "[" && after === "]") ||
      (before === "{" && after === "}") ||
      (before === '"' && after === '"') ||
      (before === "'" && after === "'") ||
      (before === "`" && after === "`")
    );
  }

  calculateNewLineIndent(tabSize: number = 2): number {
    const currentBefore = this.currentLineBeforeCursor;
    const currentLineIsCommentOnly = /^\s*#/.test(currentBefore.trimEnd());
    const contextLine =
      currentBefore.trim().length > 0 && !currentLineIsCommentOnly
        ? currentBefore
        : this.getIndentContextLine(this.cursorRow - 1);

    if (!contextLine) {
      return 0;
    }

    const leadingMatch = contextLine.match(/^(\s*)/);
    const baseIndent = leadingMatch ? leadingMatch[1].length : 0;
    const trimmedContext = contextLine.trimEnd();
    const lastChar = trimmedContext[trimmedContext.length - 1] ?? "";

    if (lastChar === "{" || lastChar === "[" || lastChar === "(") {
      return baseIndent + tabSize;
    }

    return baseIndent;
  }

  calculateClosingBracketDedent(tabSize: number = 2): number {
    const beforeOnLine = this.currentLineBeforeCursor;
    if (!/^\s*$/.test(beforeOnLine)) {
      return 0;
    }

    if (this.cursorRow === 0) {
      return 0;
    }

    const prevLine = this.getIndentContextLine(this.cursorRow - 1);
    if (!prevLine) {
      return 0;
    }

    const prevIndentMatch = prevLine.match(/^(\s*)/);
    const prevIndent = prevIndentMatch ? prevIndentMatch[1].length : 0;
    const currentIndent = beforeOnLine.length;

    if (currentIndent >= tabSize && currentIndent === prevIndent) {
      return tabSize;
    }
    
    return 0;
  }
}
