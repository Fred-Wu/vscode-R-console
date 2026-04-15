import { ANSI } from "./ansi";

export interface RendererLineHighlighter {
  highlightLines(lines: string[], sourceLineMap?: Array<number | undefined>): string[];
}

type RenderPromptKind = "main" | "cont";

export class Renderer {
  renderedLineCount = 1;
  /** The row (0-indexed from render start) where cursor is positioned after render */
  cursorRowFromTop = 0;
  /** The prompt to display (default "R> ") */
  promptText = "R> ";
  /** The ANSI color for the prompt */
  promptColor = ANSI.brightGreen;
  /** The prompt length for cursor calculations */
  promptLen = 3;
  /** The continuation prompt to display for multiline input */
  continuationPromptText: string | null = null;
  /** The ANSI color for the continuation prompt */
  continuationPromptColor = ANSI.reset;
  private readonly write: (text: string) => void;
  private lineHighlighter: RendererLineHighlighter | undefined;

  constructor(write: (text: string) => void, lineHighlighter?: RendererLineHighlighter) {
    this.write = write;
    this.lineHighlighter = lineHighlighter;
  }

  setPrompt(text: string, color: string = ANSI.brightGreen): void {
    this.promptText = text;
    this.promptColor = color;
    this.promptLen = text.length;
  }

  setContinuationPrompt(text: string, color: string = ANSI.reset): void {
    this.continuationPromptText = text;
    this.continuationPromptColor = color;
  }

  clearContinuationPrompt(): void {
    this.continuationPromptText = null;
    this.continuationPromptColor = ANSI.reset;
  }

  /**
   * Render with 2D cursor position (row, col).
   * This is the new preferred method for multi-line editing.
   */
  renderWithCursor(
    lines: string[],
    cursorRow: number,
    cursorCol: number,
    columns: number,
    sourceLineMap: Array<number | undefined>,
    promptKinds: RenderPromptKind[]
  ): void {
    const highlighted = this.lineHighlighter
      ? this.lineHighlighter.highlightLines(lines, sourceLineMap)
      : lines;
    const safeColumns = Math.max(1, columns);
    const continuationPad = 2;
    const continuationLen = this.continuationPromptText
      ? this.continuationPromptText.length
      : continuationPad;
    const getPromptKind = (index: number): RenderPromptKind => promptKinds[index]!;

    const lineRows = lines.map((_, idx) => {
      const pLen =
        getPromptKind(idx) === "main"
          ? this.promptLen
          : continuationLen;
      const visibleLen =
        pLen + highlighted[idx].replace(/\x1b\[[0-9;]*m/g, "").length;
      return Math.max(1, Math.ceil(visibleLen / safeColumns));
    });
    const totalRows = lineRows.reduce((sum, n) => sum + n, 0) || 1;
    const previousRows = this.renderedLineCount;
    const clearRenderedArea = (rowCount: number): void => {
      for (let i = 0; i < rowCount; i++) {
        this.write("\x1b[2K");
        if (i < rowCount - 1) {
          this.write("\x1b[1B\r");
        }
      }
    };

    if (totalRows > previousRows) {
      // Blank the current prompt area before growing it. Otherwise, if the
      // render expands at the bottom of the viewport, the transient history/edit
      // rows can be pushed into scrollback before submit clears them.
      this.write("\r");
      if (this.cursorRowFromTop > 0) {
        this.write(`\x1b[${this.cursorRowFromTop}A`);
      }
      clearRenderedArea(previousRows);
      const growth = totalRows - previousRows;
      for (let row = 0; row < growth; row += 1) {
        this.write("\r\n");
      }
      this.renderedLineCount = totalRows;
      this.cursorRowFromTop = this.renderedLineCount - 1;
    }
    const areaRows = this.renderedLineCount;

    // Move to start of render area
    // The cursor is currently at row `cursorRowFromTop` within the render area
    // Move up from there to the top of the render area (row 0)
    this.write("\r");
    if (this.cursorRowFromTop > 0) {
      this.write(`\x1b[${this.cursorRowFromTop}A`);
    }
    // Clear only the previously rendered lines, not beyond
    // Use \x1b[K (clear line) for each line instead of \x1b[J (clear to end of screen)
    clearRenderedArea(areaRows);
    // Move back to the top of render area
    if (areaRows > 1) {
      this.write(`\x1b[${areaRows - 1}A\r`);
    } else {
      this.write("\r");
    }

    highlighted.forEach((line, idx) => {
      if (idx > 0) this.write("\r\n");
      const promptKind = getPromptKind(idx);
      const prompt =
        promptKind === "main"
          ? `${ANSI.reset}${this.promptColor}${this.promptText}${ANSI.reset}`
          : (this.continuationPromptText === null
              ? " ".repeat(continuationPad)
              : `${ANSI.reset}${this.continuationPromptColor}${this.continuationPromptText}${ANSI.reset}`);
      this.write(prompt + line);
    });

    // Calculate cursor position in terminal
    // Sum up wrapped rows for lines before cursor line
    const prefixRows = lineRows.slice(0, cursorRow).reduce((sum, n) => sum + n, 0);
    const pLen =
      getPromptKind(cursorRow) === "main"
        ? this.promptLen
        : continuationLen;
    const cursorOffset = pLen + cursorCol;
    const rowWithinLine = cursorOffset > 0 ? Math.floor(cursorOffset / safeColumns) : 0;
    const terminalRow = prefixRows + rowWithinLine;
    const col = (cursorOffset % safeColumns) + 1;

    const deltaUp = Math.max(0, totalRows - 1 - terminalRow);
    if (deltaUp > 0) {
      this.write(`\x1b[${deltaUp}A`);
    }
    this.write(`\r\x1b[${col}G`);

    // Track where the cursor actually is (for clearInputRender)
    this.cursorRowFromTop = terminalRow;
  }

  renderFreshWithCursor(
    lines: string[],
    cursorRow: number,
    cursorCol: number,
    columns: number,
    sourceLineMap: Array<number | undefined>,
    promptKinds: RenderPromptKind[]
  ): void {
    const highlighted = this.lineHighlighter
      ? this.lineHighlighter.highlightLines(lines, sourceLineMap)
      : lines;
    const safeColumns = Math.max(1, columns);
    const continuationPad = 2;
    const continuationLen = this.continuationPromptText
      ? this.continuationPromptText.length
      : continuationPad;
    const getPromptKind = (index: number): RenderPromptKind => promptKinds[index]!;

    const lineRows = lines.map((_, idx) => {
      const pLen =
        getPromptKind(idx) === "main"
          ? this.promptLen
          : continuationLen;
      const visibleLen =
        pLen + highlighted[idx].replace(/\x1b\[[0-9;]*m/g, "").length;
      return Math.max(1, Math.ceil(visibleLen / safeColumns));
    });
    const totalRows = lineRows.reduce((sum, n) => sum + n, 0) || 1;

    this.write("\r");
    highlighted.forEach((line, idx) => {
      if (idx > 0) {
        this.write("\r\n");
      }
      const promptKind = getPromptKind(idx);
      const prompt =
        promptKind === "main"
          ? `${ANSI.reset}${this.promptColor}${this.promptText}${ANSI.reset}`
          : (this.continuationPromptText === null
              ? " ".repeat(continuationPad)
              : `${ANSI.reset}${this.continuationPromptColor}${this.continuationPromptText}${ANSI.reset}`);
      this.write(prompt + line);
    });

    const prefixRows = lineRows.slice(0, cursorRow).reduce((sum, n) => sum + n, 0);
    const pLen =
      getPromptKind(cursorRow) === "main"
        ? this.promptLen
        : continuationLen;
    const cursorOffset = pLen + cursorCol;
    const rowWithinLine = cursorOffset > 0 ? Math.floor(cursorOffset / safeColumns) : 0;
    const terminalRow = prefixRows + rowWithinLine;
    const col = (cursorOffset % safeColumns) + 1;

    const deltaUp = Math.max(0, totalRows - 1 - terminalRow);
    if (deltaUp > 0) {
      this.write(`\x1b[${deltaUp}A`);
    }
    this.write(`\r\x1b[${col}G`);

    this.renderedLineCount = totalRows;
    this.cursorRowFromTop = terminalRow;
  }
}
