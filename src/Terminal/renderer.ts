import { ANSI } from "./ansi";

export interface RendererLineHighlighter {
  highlightLines(lines: string[], sourceLineMap?: Array<number | undefined>): string[];
}

type RenderPromptKind = "main" | "cont";

export class Renderer {
  renderedLineCount = 1;
  cursorRowFromTop = 0;
  suggestionStartRow = 0;
  promptText = "R> ";
  promptColor = ANSI.brightGreen;
  promptLen = 3;
  continuationPromptText: string | null = null;
  continuationPromptColor = ANSI.reset;
  private readonly write: (text: string) => void;
  private lineHighlighter: RendererLineHighlighter | undefined;
  private lastSuggestions: string[] = [];
  private lastInputRows = 0;

  constructor(
    write: (text: string) => void,
    lineHighlighter?: RendererLineHighlighter,
    readonly displayWidth: (text: string) => number = text => text.length
  ) {
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

  renderWithCursor(
    lines: string[],
    cursorRow: number,
    cursorCol: number,
    columns: number,
    sourceLineMap: Array<number | undefined>,
    promptKinds: RenderPromptKind[],
    suggestions: string[] = []
  ): void {
    const input = this.lineHighlighter
      ? this.lineHighlighter.highlightLines(lines, sourceLineMap)
      : lines;
    const insertAt = Math.min(lines.length, cursorRow + 1);
    const highlighted = [
      ...input.slice(0, insertAt), ...suggestions, ...input.slice(insertAt),
    ];
    const layoutKinds: Array<RenderPromptKind | "none"> = [
      ...promptKinds.slice(0, insertAt),
      ...suggestions.map(() => "none" as const),
      ...promptKinds.slice(insertAt),
    ];
    const safeColumns = Math.max(1, columns);
    const continuationPad = 2;
    const continuationLen = this.continuationPromptText
      ? this.continuationPromptText.length
      : continuationPad;
    const getPromptKind = (index: number): RenderPromptKind | "none" => layoutKinds[index] ?? "none";

    const lineRows = highlighted.map((_, idx) => {
      // Suggestion rows are already fitted to the terminal's cell width.
      if (getPromptKind(idx) === "none") return 1;
      const pLen = getPromptKind(idx) === "none" ? 0 :
        getPromptKind(idx) === "main" ? this.promptLen : continuationLen;
      const visibleLen =
        pLen + this.displayWidth(highlighted[idx].replace(/\x1b\[[0-9;]*m/g, ""));
      return Math.max(1, Math.floor(visibleLen / safeColumns) + 1);
    });
    const totalRows = lineRows.reduce((sum, n) => sum + n, 0) || 1;
    const inputRows = lineRows.reduce((sum, n, index) =>
      sum + (getPromptKind(index) === "none" ? 0 : n), 0);
    this.suggestionStartRow = lineRows.slice(0, insertAt).reduce((sum, n) => sum + n, 0);
    const sameSuggestions = suggestions.length > 0 &&
      suggestions.length === this.lastSuggestions.length &&
      suggestions.every((line, index) => line === this.lastSuggestions[index]);
    const repaintInputOnly = insertAt === lines.length &&
      sameSuggestions && inputRows === this.lastInputRows &&
      totalRows === this.renderedLineCount;
    this.lastSuggestions = [...suggestions];
    this.lastInputRows = inputRows;
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

    // A changed command does not need to repaint a stable suggestion panel.
    // Cursor movements and changed suggestions still use the standard redraw.
    if (repaintInputOnly) {
      this.write("\r");
      if (this.cursorRowFromTop > 0) this.write(`\x1b[${this.cursorRowFromTop}A`);
      for (let row = 0; row < inputRows; row++) {
        this.write("\x1b[2K");
        if (row < inputRows - 1) this.write("\x1b[1B\r");
      }
      if (inputRows > 1) this.write(`\x1b[${inputRows - 1}A\r`);
      highlighted.slice(0, lines.length).forEach((line, idx) => {
        if (idx > 0) this.write("\r\n");
        const promptKind = getPromptKind(idx);
        const prompt = promptKind === "main"
          ? `${ANSI.reset}${this.promptColor}${this.promptText}${ANSI.reset}`
          : (this.continuationPromptText === null
              ? " ".repeat(continuationPad)
              : `${ANSI.reset}${this.continuationPromptColor}${this.continuationPromptText}${ANSI.reset}`);
        this.write(prompt + line);
      });
      const prefix = lineRows.slice(0, cursorRow).reduce((sum, n) => sum + n, 0);
      const promptLen = getPromptKind(cursorRow) === "main" ? this.promptLen : continuationLen;
      const offset = promptLen + this.displayWidth(lines[cursorRow]?.slice(0, cursorCol) ?? "");
      const terminalRow = prefix + (offset > 0 ? Math.floor(offset / safeColumns) : 0);
      const delta = Math.max(0, inputRows - 1 - terminalRow);
      if (delta > 0) this.write(`\x1b[${delta}A`);
      this.write(`\r\x1b[${(offset % safeColumns) + 1}G`);
      this.cursorRowFromTop = terminalRow;
      return;
    }

    this.write("\r");
    if (this.cursorRowFromTop > 0) {
      this.write(`\x1b[${this.cursorRowFromTop}A`);
    }
    clearRenderedArea(areaRows);
    if (areaRows > 1) {
      this.write(`\x1b[${areaRows - 1}A\r`);
    } else {
      this.write("\r");
    }

    highlighted.forEach((line, idx) => {
      if (idx > 0) this.write("\r\n");
      const promptKind = getPromptKind(idx);
      const prompt = promptKind === "none" ? "" :
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
    const cursorOffset = pLen + this.displayWidth(lines[cursorRow]?.slice(0, cursorCol) ?? "");
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
        pLen + this.displayWidth(highlighted[idx].replace(/\x1b\[[0-9;]*m/g, ""));
      return Math.max(1, Math.floor(visibleLen / safeColumns) + 1);
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
    const cursorOffset = pLen + this.displayWidth(lines[cursorRow]?.slice(0, cursorCol) ?? "");
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
