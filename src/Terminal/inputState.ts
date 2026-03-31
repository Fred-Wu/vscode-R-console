import {
  classifyExpressionLocal as parserClassifyExpressionLocal,
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

  /** Array of all lines (split by \n) */
  get lines(): string[] {
    return this._text.split("\n");
  }

  /** Current row (0-based) */
  get cursorRow(): number {
    const textBefore = this._text.slice(0, this._cursorPosition);
    return (textBefore.match(/\n/g) || []).length;
  }

  /** Current column (0-based) */
  get cursorCol(): number {
    const textBefore = this._text.slice(0, this._cursorPosition);
    const lastNewline = textBefore.lastIndexOf("\n");
    return lastNewline === -1 ? this._cursorPosition : this._cursorPosition - lastNewline - 1;
  }

  /** Text on the current line */
  get currentLine(): string {
    return this.lines[this.cursorRow];
  }

  /** Text before cursor on current line */
  get currentLineBeforeCursor(): string {
    const line = this.currentLine;
    return line.slice(0, this.cursorCol);
  }

  /** Text after cursor on current line */
  get currentLineAfterCursor(): string {
    const line = this.currentLine;
    return line.slice(this.cursorCol);
  }

  /** Text before cursor (entire document) */
  get textBeforeCursor(): string {
    return this._text.slice(0, this._cursorPosition);
  }

  /** Text after cursor (entire document) */
  get textAfterCursor(): string {
    return this._text.slice(this._cursorPosition);
  }

  /** Character at cursor position (or empty string if at end) */
  get currentChar(): string {
    return this._text[this._cursorPosition] || "";
  }

  /** Character before cursor (or empty string if at start) */
  get charBeforeCursor(): string {
    return this._cursorPosition > 0 ? this._text[this._cursorPosition - 1] : "";
  }

  /** True when cursor is at the end of the text */
  get isAtEnd(): boolean {
    return this._cursorPosition === this._text.length;
  }

  /** True when cursor is at the start of the text */
  get isAtStart(): boolean {
    return this._cursorPosition === 0;
  }

  /** 
   * Get the starting index of each line in the text.
   * Line 0 starts at index 0, line 1 starts after first \n, etc.
   */
  private getLineStartIndexes(): number[] {
    const indexes = [0];
    let pos = 0;
    for (const line of this.lines) {
      pos += line.length + 1; // +1 for \n
      indexes.push(pos);
    }
    indexes.pop(); // Remove last (beyond end of text)
    return indexes;
  }

  /**
   * Translate (row, col) to absolute cursor position.
   * Clamps to valid range.
   */
  translateRowColToIndex(row: number, col: number): number {
    const lines = this.lines;
    row = Math.max(0, Math.min(row, lines.length - 1));
    const lineStarts = this.getLineStartIndexes();
    const lineStart = lineStarts[row];
    const line = lines[row];
    col = Math.max(0, Math.min(col, line.length));
    
    return lineStart + col;
  }

  /**
   * Get relative position for moving cursor left.
   * Only moves within the current line (stops at line start).
   */
  getCursorLeftPosition(count: number = 1): number {
    return -Math.min(this.cursorCol, count);
  }

  /**
   * Get relative position for moving cursor right.
   * Only moves within the current line (stops at line end).
   */
  getCursorRightPosition(count: number = 1): number {
    return Math.min(count, this.currentLineAfterCursor.length);
  }

  /**
   * Get position of start of current line.
   */
  getStartOfLinePosition(): number {
    return -this.cursorCol;
  }

  /**
   * Get position of end of current line.
   */
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

  /**
   * Auto up: Move cursor up if not on first line, otherwise return "history"
   * to indicate caller should navigate history.
   */
  autoUp(renderMetrics: InputRenderMetrics): "moved" | "history" {
    return this.moveByRenderedRows(-1, renderMetrics) ? "moved" : "history";
  }

  /**
   * Auto down: Move cursor down if not on last line, otherwise return "history"
   * to indicate caller should navigate history.
   */
  autoDown(renderMetrics: InputRenderMetrics): "moved" | "history" {
    return this.moveByRenderedRows(1, renderMetrics) ? "moved" : "history";
  }

  /**
   * Move cursor to end of text.
   */
  cursorToEnd(): void {
    this._cursorPosition = this._text.length;
    this.preferredColumn = null;
  }

  /**
   * Insert text at cursor position.
   */
  insertText(text: string): void {
    this._text = this._text.slice(0, this._cursorPosition) + text + this._text.slice(this._cursorPosition);
    this._cursorPosition += text.length;
    this.preferredColumn = null;
  }

  /**
   * Delete characters before cursor. Returns deleted text.
   */
  deleteBeforeCursor(count: number = 1): string {
    const deleteCount = Math.min(count, this._cursorPosition);
    const deleted = this._text.slice(this._cursorPosition - deleteCount, this._cursorPosition);
    this._text = this._text.slice(0, this._cursorPosition - deleteCount) + this._text.slice(this._cursorPosition);
    this._cursorPosition -= deleteCount;
    this.preferredColumn = null;
    return deleted;
  }

  /**
   * Delete characters after cursor. Returns deleted text.
   */
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

  /**
   * Apply a history entry (replace entire text, cursor at end).
   */
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

  static checkExpressionComplete(text: string): boolean {
    return parserClassifyExpressionLocal(text) === "complete";
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

  /**
   * Check if cursor is inside a string, backtick identifier, or special operator (simplified heuristic).
   * Counts unescaped quotes/backticks/percent signs before cursor.
   */
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

  /**
   * Check if character after cursor allows auto-bracket insertion.
   * Auto-close is allowed when followed by `,)}\]` whitespace, or end of line.
   */
  canAutoCloseBracket(): boolean {
    const after = this.currentChar;
    return after === "" || /^[,)}\]\s]/.test(after);
  }

  /**
   * Get the matching closing bracket for an opening bracket.
   */
  getClosingBracket(openBracket: string): string | undefined {
    return InputState.BRACKET_PAIRS[openBracket];
  }

  /**
   * Check if a character is a closing bracket.
   */
  isClosingBracket(ch: string): boolean {
    return InputState.CLOSING_BRACKETS.has(ch);
  }

  /**
   * Check if cursor is between curly braces {|}.
   * Only {|} triggers multiline expansion on Enter.
   */
  isBetweenCurlyBraces(): boolean {
    return this.charBeforeCursor === "{" && this.currentChar === "}";
  }

  /**
   * Check if cursor is between matching bracket pairs for backspace deletion.
   * Includes (), [], {}, "", '', ``
   */
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

  /**
   * Calculate indentation for a new line based on bracket depth.
   * Returns the number of spaces to indent.
   */
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

  /**
   * Check if we should dedent when typing a closing bracket.
   * Returns the number of spaces to remove (0 if no dedent needed).
   */
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
