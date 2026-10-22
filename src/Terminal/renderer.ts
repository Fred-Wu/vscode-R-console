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

  private cursorCellPosition(offset: number, columns: number, atEnd: boolean):
    { row: number; col: number } {
    const lastCell = offset > 0 && offset % columns === 0 && atEnd;
    return {
      row: Math.max(0, Math.floor(offset / columns) - (lastCell ? 1 : 0)),
      col: lastCell ? columns : offset % columns + 1,
    };
  }

  private splitStyledLine(line: string, cells: number): [string, string] {
    let first = "";
    let rest = "";
    let count = 0;
    let style = "";
    for (let i = 0; i < line.length;) {
      const sgr = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
      if (sgr) {
        if (count < cells) first += sgr[0];
        else rest += sgr[0];
        style = sgr[0] === "\x1b[0m" ? "" : style + sgr[0];
        i += sgr[0].length;
        continue;
      }
      const char = String.fromCodePoint(line.codePointAt(i)!);
      if (count < cells) first += char;
      else rest += char;
      count += this.displayWidth(char);
      i += char.length;
    }
    return [first, style + rest];
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
    const safeColumns = Math.max(1, columns);
    const continuationLen = this.continuationPromptText?.length ?? 2;
    const promptLen = promptKinds[cursorRow] === "main" ? this.promptLen : continuationLen;
    const sourceLine = lines[cursorRow] ?? "";
    const caretCells = promptLen + this.displayWidth(sourceLine.slice(0, cursorCol));
    const lineCells = promptLen + this.displayWidth(sourceLine);
    const physicalEnd = (Math.floor(caretCells / safeColumns) + 1) * safeColumns;
    // Split a long logical input line at the end of the caret's physical row.
    // The suffix stays below the panel, while the caret remains in the prefix.
    const split = suggestions.length > 0 && lineCells > physicalEnd;
    let splitIndex = -1;
    let inputLines = input;
    let inputKinds: Array<RenderPromptKind | "none"> = [...promptKinds];
    if (split) {
      const before = this.splitStyledLine(input[cursorRow] ?? "", physicalEnd - promptLen);
      inputLines = [...input.slice(0, cursorRow), before[0], before[1], ...input.slice(cursorRow + 1)];
      inputKinds = [...promptKinds.slice(0, cursorRow + 1), "none", ...promptKinds.slice(cursorRow + 1)];
      splitIndex = cursorRow;
    }
    const insertAt = Math.min(inputLines.length, cursorRow + 1);
    const highlighted = [
      ...inputLines.slice(0, insertAt), ...suggestions, ...inputLines.slice(insertAt),
    ];
    const layoutKinds: Array<RenderPromptKind | "none"> = [
      ...inputKinds.slice(0, insertAt),
      ...suggestions.map(() => "none" as const),
      ...inputKinds.slice(insertAt),
    ];
    const continuationPad = 2;
    const getPromptKind = (index: number): RenderPromptKind | "none" => layoutKinds[index] ?? "none";

    const lineRows = highlighted.map((_, idx) => {
      // Suggestion rows are already fitted to the terminal's cell width.
      if (getPromptKind(idx) === "none" && idx < insertAt + suggestions.length) return 1;
      const pLen = getPromptKind(idx) === "none" ? 0 :
        getPromptKind(idx) === "main" ? this.promptLen : continuationLen;
      const visibleLen =
        pLen + this.displayWidth(highlighted[idx].replace(/\x1b\[[0-9;]*m/g, ""));
      if (idx === splitIndex) return Math.max(1, Math.ceil(visibleLen / safeColumns));
      return Math.max(1, Math.ceil(visibleLen / safeColumns));
    });
    const totalRows = lineRows.reduce((sum, n) => sum + n, 0) || 1;
    const inputRows = lineRows.reduce((sum, n, index) =>
      sum + (getPromptKind(index) === "none" ? 0 : n), 0);
    this.suggestionStartRow = lineRows.slice(0, insertAt).reduce((sum, n) => sum + n, 0);
    const sameSuggestions = suggestions.length > 0 &&
      suggestions.length === this.lastSuggestions.length &&
      suggestions.every((line, index) => line === this.lastSuggestions[index]);
    const repaintInputOnly = !split && insertAt === lines.length &&
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
      const position = this.cursorCellPosition(offset, safeColumns,
        cursorCol >= (lines[cursorRow]?.length ?? 0));
      const terminalRow = prefix + position.row;
      const delta = Math.max(0, inputRows - 1 - terminalRow);
      if (delta > 0) this.write(`\x1b[${delta}A`);
      this.write(`\r\x1b[${position.col}G`);
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
    const position = this.cursorCellPosition(cursorOffset, safeColumns,
      cursorCol >= (lines[cursorRow]?.length ?? 0));
    const terminalRow = prefixRows + position.row;
    const col = position.col;

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
    const cursorOffset = pLen + this.displayWidth(lines[cursorRow]?.slice(0, cursorCol) ?? "");
    const position = this.cursorCellPosition(cursorOffset, safeColumns,
      cursorCol >= (lines[cursorRow]?.length ?? 0));
    const terminalRow = prefixRows + position.row;
    const col = position.col;

    const deltaUp = Math.max(0, totalRows - 1 - terminalRow);
    if (deltaUp > 0) {
      this.write(`\x1b[${deltaUp}A`);
    }
    this.write(`\r\x1b[${col}G`);

    this.renderedLineCount = totalRows;
    this.cursorRowFromTop = terminalRow;
  }
}
