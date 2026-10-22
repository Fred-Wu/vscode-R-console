import type { CompletionPickItem, CompletionQuickPickItem } from "../Language/completion";

type DisplayRow = { text: string; choice?: number; group?: boolean; detail?: boolean };

export type InlineCompletionColors = {
  matchForeground: string;
  selectedBackground: string;
};

const ESC = "\x1b[";
const RESET = ESC + "0m";
const FG_RESET = ESC + "39m";
const BG_RESET = ESC + "49m";
const DIM = ESC + "2m";
const DIM_RESET = ESC + "22m";
const BORDER = ESC + "90m";
const ICON = /^\$\(symbol-([a-z-]+)\)\s*/;
const ICON_COLORS: Record<string, number> = {
  variable: 75, field: 75, property: 75, function: 141, method: 141,
  class: 215, interface: 215, module: 75, enum: 215, constant: 81,
  keyword: 176, operator: 176, snippet: 110, text: 245,
};
const DEFAULT_COLORS: InlineCompletionColors = {
  matchForeground: ESC + "38;2;79;193;255m",
  selectedBackground: ESC + "48;2;38;79;120m",
};

/** The terminal API cannot resolve VS Code ThemeColor values. Respect explicit
 * workbench overrides, otherwise use contrasting terminal-safe light/dark colors. */
export function resolveInlineCompletionColors(
  isLight: boolean,
  overrides: Record<string, unknown> = {}
): InlineCompletionColors {
  const foreground = parseHexColor(overrides["editorSuggestWidget.highlightForeground"]) ??
    (isLight ? [0, 91, 175] : [79, 193, 255]);
  const background = parseHexColor(overrides["editorSuggestWidget.selectedBackground"]) ??
    (isLight ? [208, 225, 245] : [38, 79, 120]);
  return {
    matchForeground: ESC + "38;2;" + foreground.join(";") + "m",
    selectedBackground: ESC + "48;2;" + background.join(";") + "m",
  };
}

function parseHexColor(value: unknown): number[] | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) return undefined;
  const hex = match[1].length === 3
    ? [...match[1]].map(character => character + character).join("")
    : match[1];
  return [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
}

function clean(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function fit(value: string, width: number): string {
  const characters = [...clean(value)];
  return characters.length <= width ? characters.join("") :
    characters.slice(0, Math.max(0, width - 1)).join("") + "…";
}

function highlightMatch(label: string, query: string, color: string): string {
  if (!query) return label;
  const start = label.toLowerCase().indexOf(query.toLowerCase());
  if (start < 0) return label;
  return label.slice(0, start) + color + label.slice(start, start + query.length) +
    FG_RESET + label.slice(start + query.length);
}

function isChoice(item: CompletionQuickPickItem): item is CompletionPickItem {
  return "insertText" in item && "replaceStart" in item;
}

export class InlineCompletion {
  items: CompletionQuickPickItem[] = [];
  selected = 0;
  private choiceIndexes: number[] = [];
  private generation = 0;
  private renderedTargets: Array<number | undefined> = [];
  private renderedWidth = 0;
  private renderedLeft = 0;
  private scrollStart = 0;
  private query = "";

  get visible(): boolean { return this.choiceIndexes.length > 0; }
  get token(): number { return this.generation; }
  get hasRenderedRows(): boolean { return this.renderedTargets.length > 0; }

  contains(row: number, col: number): boolean {
    return Number.isInteger(row) && row > 0 && row < this.renderedTargets.length - 2 &&
      col > this.renderedLeft + 1 && col < this.renderedLeft + this.renderedWidth;
  }

  invalidate(): number { return ++this.generation; }

  clear(): void {
    this.generation++;
    this.items = [];
    this.choiceIndexes = [];
    this.selected = 0;
    this.renderedTargets = [];
    this.renderedWidth = 0;
    this.renderedLeft = 0;
    this.scrollStart = 0;
    this.query = "";
  }

  setQuery(query: string): void {
    this.query = query;
  }

  set(items: CompletionQuickPickItem[], token: number, query = ""): boolean {
    if (token !== this.generation) return false;
    const previous = this.current();
    this.items = items;
    this.query = query;
    this.choiceIndexes = [];
    items.forEach((item, index) => {
      if (isChoice(item)) this.choiceIndexes.push(index);
    });
    const matching = previous && this.choiceIndexes.findIndex(index => {
      const entry = items[index];
      return isChoice(entry) && entry.label === previous.label &&
        entry.insertText === previous.insertText &&
        entry.description === previous.description && entry.detail === previous.detail;
    });
    const exact = query.length > 0 ? this.choiceIndexes.findIndex(index => {
      const entry = items[index];
      return isChoice(entry) && entry.label.replace(ICON, "").toLowerCase() === query.toLowerCase();
    }) : -1;
    this.selected = exact >= 0 ? exact :
      matching !== undefined && matching >= 0 ? matching : 0;
    this.scrollStart = 0;
    return true;
  }

  move(delta: number): void {
    if (this.visible) {
      this.selected = Math.max(0, Math.min(this.choiceIndexes.length - 1, this.selected + delta));
    }
  }

  current(): CompletionPickItem | undefined {
    const index = this.choiceIndexes[this.selected];
    const item = index === undefined ? undefined : this.items[index];
    return item && isChoice(item) ? item : undefined;
  }

  /** Row is zero-based from the top border; column is the one-based terminal column. */
  hitTest(row: number, col: number): CompletionPickItem | undefined {
    if (!this.contains(row, col)) return undefined;
    const choice = this.renderedTargets[row];
    const index = choice === undefined ? undefined : this.choiceIndexes[choice];
    const item = index === undefined ? undefined : this.items[index];
    return item && isChoice(item) ? item : undefined;
  }

  lines(
    width: number,
    availableRows: number,
    anchorColumn = 1,
    colors: InlineCompletionColors = DEFAULT_COLORS
  ): string[] {
    this.renderedTargets = [];
    this.renderedWidth = 0;
    this.renderedLeft = 0;
    if (!this.visible || width < 20 || availableRows < 5) return [];

    const boxWidth = Math.min(60, width - 1);
    const left = Math.max(0, Math.min(
      Math.max(1, Math.floor(anchorColumn)) - 1,
      width - boxWidth - 1
    ));
    const indent = " ".repeat(left);
    const contentWidth = boxWidth - 4;
    const rows: DisplayRow[] = [];
    let choice = 0;

    for (const item of this.items) {
      if (!isChoice(item)) {
        rows.push({ text: fit(item.label, contentWidth), group: true });
        continue;
      }

      const iconKind = ICON.exec(item.label)?.[1];
      const moduleIcon = iconKind === "module";
      const label = fit(item.label.replace(ICON, ""), contentWidth - (moduleIcon ? 4 : 3));
      const description = fit(item.description ?? "", contentWidth);
      const iconColor = ESC + "38;5;" + (ICON_COLORS[iconKind ?? ""] ?? 245) + "m";
      const icon = iconColor + (moduleIcon ? "{}" : "●") + FG_RESET;
      const rest = contentWidth - [...label].length - (moduleIcon ? 4 : 3);
      const suffix = description && rest >= [...description].length + 2
        ? " ".repeat(rest - [...description].length) + DIM + description + DIM_RESET
        : "";
      rows.push({
        text: icon + " " + highlightMatch(label, this.query, colors.matchForeground) + suffix,
        choice,
      });
      if (item.detail) {
        rows.push({ text: "  " + fit(item.detail, contentWidth - 2), choice, detail: true });
      }
      choice++;
    }

    // Include boundary headings/details at the endpoints; otherwise scroll only
    // when selection leaves the visible viewport.
    const capacity = availableRows - 3;
    const activeRow = rows.findIndex(row => row.choice === this.selected && !row.detail);
    if (activeRow < this.scrollStart) this.scrollStart = activeRow;
    if (activeRow >= this.scrollStart + capacity) this.scrollStart = activeRow - capacity + 1;
    if (this.selected === 0) this.scrollStart = 0;
    else if (this.selected === this.choiceIndexes.length - 1) this.scrollStart = rows.length - capacity;
    this.scrollStart = Math.max(0, Math.min(this.scrollStart, Math.max(0, rows.length - capacity)));
    const start = this.scrollStart;
    const body = rows.slice(start, start + capacity);
    const frame = (text: string, selected = false, muted = false, bar = " "): string => {
      const plainLength = [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
      const padded = text + " ".repeat(Math.max(0, contentWidth - plainLength));
      const styled = muted ? DIM + padded + DIM_RESET : padded;
      // Selected background begins before the text, and foreground spans reset
      // only the foreground. This prevents icon/match styling from punching holes.
      return BORDER + "│" + FG_RESET +
        (selected ? colors.selectedBackground : "") + " " + styled +
        (selected ? BG_RESET : "") +
        BORDER + bar + FG_RESET + BORDER + "│" + FG_RESET;
    };
    const border = (leftChar: string, rightChar: string): string =>
      BORDER + leftChar + "─".repeat(boxWidth - 2) + rightChar + FG_RESET;

    const output = [border("╭", "╮")];
    this.renderedWidth = boxWidth;
    this.renderedLeft = left;
    this.renderedTargets.push(undefined);
    const overflow = rows.length > capacity;
    const thumb = overflow ? Math.max(1, Math.round(capacity * capacity / rows.length)) : 0;
    const thumbStart = overflow ? Math.round(start * (capacity - thumb) / (rows.length - capacity)) : 0;
    for (const [index, row] of body.entries()) {
      const bar = !overflow ? " " : index >= thumbStart && index < thumbStart + thumb ? "█" : "│";
      output.push(frame(row.text, row.choice === this.selected && !row.detail, row.group || row.detail, bar));
      this.renderedTargets.push(row.choice);
    }
    const first = body.find(row => row.choice !== undefined)?.choice;
    const last = [...body].reverse().find(row => row.choice !== undefined)?.choice;
    const status = first === undefined ? "" : (first + 1) + "–" + (last! + 1) + " of " + this.choiceIndexes.length;
    output.push(frame(fit(status, contentWidth), false, true));
    output.push(border("╰", "╯"));
    this.renderedTargets.push(undefined, undefined);
    return output.map(line => indent + line);
  }
}
