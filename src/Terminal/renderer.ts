import { ANSI } from "./ansi";

export interface RendererLineHighlighter {
  highlightLines(lines: string[], sourceLineMap?: Array<number | undefined>): string[];
}

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

  setLineHighlighter(lineHighlighter: RendererLineHighlighter | undefined): void {
    this.lineHighlighter = lineHighlighter;
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
    sourceLineMap?: Array<number | undefined>
  ): void {
    const highlighted = this.lineHighlighter
      ? this.lineHighlighter.highlightLines(lines, sourceLineMap)
      : lines;
    const safeColumns = Math.max(1, columns);
    const continuationPad =
      this.promptText === ">>> " ? this.promptLen : 2;
    const continuationLen = this.continuationPromptText
      ? this.continuationPromptText.length
      : continuationPad;

    const lineRows = lines.map((_, idx) => {
      const pLen =
        idx === 0
          ? this.promptLen
          : continuationLen;
      const visibleLen =
        pLen + highlighted[idx].replace(/\x1b\[[0-9;]*m/g, "").length;
      return Math.max(1, Math.ceil(visibleLen / safeColumns));
    });
    const totalRows = lineRows.reduce((sum, n) => sum + n, 0) || 1;

    // Move to start of render area
    // The cursor is currently at row `cursorRowFromTop` within the render area
    // Move up from there to the top of the render area (row 0)
    this.write("\r");
    if (this.cursorRowFromTop > 0) {
      this.write(`\x1b[${this.cursorRowFromTop}A`);
    }
    // Clear only the previously rendered lines, not beyond
    // Use \x1b[K (clear line) for each line instead of \x1b[J (clear to end of screen)
    for (let i = 0; i < this.renderedLineCount; i++) {
      this.write("\x1b[2K"); // Clear entire line
      if (i < this.renderedLineCount - 1) {
        this.write("\x1b[1B\r"); // Move down and return to column 0
      }
    }
    // Move back to the top of render area
    if (this.renderedLineCount > 1) {
      this.write(`\x1b[${this.renderedLineCount - 1}A\r`);
    } else {
      this.write("\r");
    }

    highlighted.forEach((line, idx) => {
      if (idx > 0) this.write("\r\n");
      const prompt =
        idx === 0
          ? `${ANSI.reset}${this.promptColor}${this.promptText}${ANSI.reset}`
          : (this.continuationPromptText === null
              ? " ".repeat(continuationPad)
              : `${ANSI.reset}${this.continuationPromptColor}${this.continuationPromptText}${ANSI.reset}`);
      this.write(prompt + line);
    });

    this.renderedLineCount = totalRows;

    // Calculate cursor position in terminal
    // Sum up wrapped rows for lines before cursor line
    const prefixRows = lineRows.slice(0, cursorRow).reduce((sum, n) => sum + n, 0);
    const pLen =
      cursorRow === 0
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

  /**
   * Clear the current rendered input area without re-rendering.
   * Useful before changing state that would alter the number of rendered lines.
   */
  clearInputRender(): void {
    // Move to start of render area
    this.write("\r");
    if (this.cursorRowFromTop > 0) {
      this.write(`\x1b[${this.cursorRowFromTop}A`);
    }
    // Clear all rendered lines
    for (let i = 0; i < this.renderedLineCount; i++) {
      this.write("\x1b[2K"); // Clear entire line
      if (i < this.renderedLineCount - 1) {
        this.write("\x1b[1B\r"); // Move down and return to column 0
      }
    }
    // Move back to the top of render area
    if (this.renderedLineCount > 1) {
      this.write(`\x1b[${this.renderedLineCount - 1}A\r`);
    } else {
      this.write("\r");
    }
    // Reset state
    this.renderedLineCount = 1;
    this.cursorRowFromTop = 0;
  }
}
