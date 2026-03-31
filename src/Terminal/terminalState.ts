import { Terminal } from "@xterm/headless";
import type { IBufferCell } from "@xterm/headless";

type StyledTerminalViewport = {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
};

type TerminalCellStyle = {
  fgMode: number;
  fgColor: number;
  bgMode: number;
  bgColor: number;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
};

type HeadlessTerminalWithCore = Terminal & {
  _core?: {
    writeSync?: (data: string | Uint8Array, callback?: () => void) => void;
  };
};

export class TerminalState {
  private readonly terminal: HeadlessTerminalWithCore;

  constructor(columns: number, rows: number) {
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: Math.max(1, columns),
      rows: Math.max(1, rows),
      convertEol: false,
      logLevel: "off",
      scrollback: 10000,
    }) as HeadlessTerminalWithCore;
  }

  dispose(): void {
    this.terminal.dispose();
  }

  reset(): void {
    this.terminal.reset();
  }

  resize(columns: number, rows: number): void {
    this.terminal.resize(Math.max(1, columns), Math.max(1, rows));
  }

  write(text: string): void {
    if (!text) {
      return;
    }
    const writeSync = this.terminal._core?.writeSync;
    if (typeof writeSync !== "function") {
      throw new Error("@xterm/headless writeSync is unavailable");
    }
    writeSync.call(this.terminal._core, text);
  }

  getStyledViewport(rows: number): StyledTerminalViewport {
    const buffer = this.terminal.buffer.active;
    const safeRows = Math.max(1, rows);
    const cursorRow = Math.max(0, Math.min(safeRows - 1, buffer.cursorY));
    const viewportTop = Math.max(0, buffer.baseY);
    const lines: string[] = [];

    for (let i = 0; i < safeRows; i += 1) {
      lines.push(this.getStyledLine(viewportTop + i));
    }

    return {
      lines,
      cursorRow,
      cursorCol: Math.max(0, buffer.cursorX),
    };
  }

  private getStyledLine(absoluteRow: number): string {
    if (absoluteRow < 0) {
      return "";
    }

    const line = this.terminal.buffer.active.getLine(absoluteRow);
    if (!line) {
      return "";
    }

    let rendered = "";
    let previousStyle: TerminalCellStyle | null = null;

    for (let column = 0; column < line.length; column += 1) {
      const cell = line.getCell(column);
      if (!cell) {
        continue;
      }
      if (cell.getWidth() === 0) {
        continue;
      }

      const style = this.getCellStyle(cell);
      const transition = this.buildStyleTransition(previousStyle, style);
      if (transition.length > 0) {
        rendered += transition;
      }

      const chars = cell.getChars();
      rendered += chars.length > 0 ? chars : " ";
      previousStyle = style;
    }

    if (previousStyle && !this.isDefaultStyle(previousStyle)) {
      rendered += "\x1b[0m";
    }

    return rendered;
  }

  private getCellStyle(cell: IBufferCell): TerminalCellStyle {
    return {
      fgMode: cell.getFgColorMode(),
      fgColor: cell.getFgColor(),
      bgMode: cell.getBgColorMode(),
      bgColor: cell.getBgColor(),
      bold: cell.isBold() !== 0,
      italic: cell.isItalic() !== 0,
      dim: cell.isDim() !== 0,
      underline: cell.isUnderline() !== 0,
      blink: cell.isBlink() !== 0,
      inverse: cell.isInverse() !== 0,
      invisible: cell.isInvisible() !== 0,
      strikethrough: cell.isStrikethrough() !== 0,
      overline: cell.isOverline() !== 0,
    };
  }

  private buildStyleTransition(
    previousStyle: TerminalCellStyle | null,
    nextStyle: TerminalCellStyle
  ): string {
    if (previousStyle && this.stylesEqual(previousStyle, nextStyle)) {
      return "";
    }

    if (this.isDefaultStyle(nextStyle)) {
      return previousStyle && !this.isDefaultStyle(previousStyle) ? "\x1b[0m" : "";
    }

    const codes = [
      ...this.buildColorCodes(nextStyle.fgMode, nextStyle.fgColor, true),
      ...this.buildColorCodes(nextStyle.bgMode, nextStyle.bgColor, false),
    ];

    if (nextStyle.bold) codes.push("1");
    if (nextStyle.dim) codes.push("2");
    if (nextStyle.italic) codes.push("3");
    if (nextStyle.underline) codes.push("4");
    if (nextStyle.blink) codes.push("5");
    if (nextStyle.inverse) codes.push("7");
    if (nextStyle.invisible) codes.push("8");
    if (nextStyle.strikethrough) codes.push("9");
    if (nextStyle.overline) codes.push("53");

    if (codes.length === 0) {
      return previousStyle ? "\x1b[0m" : "";
    }

    const prefix =
      previousStyle && !this.isDefaultStyle(previousStyle) ? "\x1b[0m" : "";
    return `${prefix}\x1b[${codes.join(";")}m`;
  }

  private buildColorCodes(mode: number, color: number, isForeground: boolean): string[] {
    if (mode === 0) {
      return [];
    }

    if (mode === 50331648) {
      const red = (color >> 16) & 0xff;
      const green = (color >> 8) & 0xff;
      const blue = color & 0xff;
      return [isForeground ? "38" : "48", "2", String(red), String(green), String(blue)];
    }

    if (color >= 0 && color < 8) {
      return [String((isForeground ? 30 : 40) + color)];
    }
    if (color >= 8 && color < 16) {
      return [String((isForeground ? 90 : 100) + (color - 8))];
    }

    return [isForeground ? "38" : "48", "5", String(color)];
  }

  private stylesEqual(a: TerminalCellStyle, b: TerminalCellStyle): boolean {
    return (
      a.fgMode === b.fgMode &&
      a.fgColor === b.fgColor &&
      a.bgMode === b.bgMode &&
      a.bgColor === b.bgColor &&
      a.bold === b.bold &&
      a.italic === b.italic &&
      a.dim === b.dim &&
      a.underline === b.underline &&
      a.blink === b.blink &&
      a.inverse === b.inverse &&
      a.invisible === b.invisible &&
      a.strikethrough === b.strikethrough &&
      a.overline === b.overline
    );
  }

  private isDefaultStyle(style: TerminalCellStyle): boolean {
    return (
      style.fgMode === 0 &&
      style.bgMode === 0 &&
      !style.bold &&
      !style.italic &&
      !style.dim &&
      !style.underline &&
      !style.blink &&
      !style.inverse &&
      !style.invisible &&
      !style.strikethrough &&
      !style.overline
    );
  }
}
