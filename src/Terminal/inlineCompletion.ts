import type { CompletionPickItem, CompletionQuickPickItem } from "../Language/completion";

type DisplayRow = { text: string; choice?: number; group?: boolean; detail?: boolean };

const ESC = "\x1b[";
const RESET = ESC + "0m";
const DIM = ESC + "2m";
const BORDER = ESC + "90m";
const SELECTED = ESC + "7m"; // terminal-theme foreground/background contrast
const ICON = /^\$\(symbol-([a-z-]+)\)\s*/;
const ICON_COLORS: Record<string, number> = {
  variable: 75, field: 75, property: 75, function: 141, method: 141,
  class: 215, interface: 215, module: 75, enum: 215, constant: 81,
  keyword: 176, operator: 176, snippet: 110, text: 245,
};

function clean(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function fit(value: string, width: number): string {
  const characters = [...clean(value)];
  return characters.length <= width ? characters.join("") :
    characters.slice(0, Math.max(0, width - 1)).join("") + "…";
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
  private scrollStart = 0;

  get visible(): boolean { return this.choiceIndexes.length > 0; }
  get token(): number { return this.generation; }
  get hasRenderedRows(): boolean { return this.renderedTargets.length > 0; }
  contains(row: number, col: number): boolean {
    return Number.isInteger(row) && row > 0 && row < this.renderedTargets.length - 2 &&
      col > 1 && col < this.renderedWidth;
  }

  invalidate(): number { return ++this.generation; }

  clear(): void {
    this.generation++;
    this.items = [];
    this.choiceIndexes = [];
    this.selected = 0;
    this.renderedTargets = [];
    this.renderedWidth = 0;
    this.scrollStart = 0;
  }

  set(items: CompletionQuickPickItem[], token: number, query = ""): boolean {
    if (token !== this.generation) return false;
    const previous = this.current();
    this.items = items;
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
    this.selected = exact !== undefined && exact >= 0 ? exact :
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

  /** Row is zero-based from the top border; columns use terminal coordinates (1-based). */
  hitTest(row: number, col: number): CompletionPickItem | undefined {
    if (col < 2 || col >= this.renderedWidth || !Number.isInteger(row)) return undefined;
    const choice = this.renderedTargets[row];
    const index = choice === undefined ? undefined : this.choiceIndexes[choice];
    const item = index === undefined ? undefined : this.items[index];
    return item && isChoice(item) ? item : undefined;
  }

  lines(width: number, availableRows: number): string[] {
    this.renderedTargets = [];
    this.renderedWidth = 0;
    if (!this.visible || width < 20 || availableRows < 5) return [];
    const boxWidth = Math.min(72, width - 1);
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
      const description = clean(item.description ?? "");
      const color = ESC + "38;5;" + (ICON_COLORS[iconKind ?? ""] ?? 245) + "m";
      const icon = color + (moduleIcon ? "{}" : "●") + RESET;
      const labelWidth = [...label].length;
      const rest = contentWidth - labelWidth - (moduleIcon ? 4 : 3);
      const suffix = description && rest >= [...description].length + 2
        ? " ".repeat(rest - [...description].length) + DIM + description + RESET
        : "";
      rows.push({ text: icon + " " + label + suffix, choice });
      if (item.detail) {
        rows.push({ text: "  " + fit(item.detail, contentWidth - 2), choice, detail: true });
      }
      choice++;
    }

    // Keep the active completion in view; headers and details share the same row budget.
    const capacity = availableRows - 3; // top border, position footer, bottom border
    const activeRow = rows.findIndex(row => row.choice === this.selected && !row.detail);
    // Only scroll after the selected row actually leaves the visible viewport.
    if (activeRow < this.scrollStart) this.scrollStart = activeRow;
    if (activeRow >= this.scrollStart + capacity) this.scrollStart = activeRow - capacity + 1;
    this.scrollStart = Math.max(0, Math.min(this.scrollStart, Math.max(0, rows.length - capacity)));
    const start = this.scrollStart;
    const body = rows.slice(start, start + capacity);
    const frame = (text: string, selected = false, isGroup = false, isDetail = false, bar = " "): string => {
      const plainLength = [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
      const padded = text + " ".repeat(Math.max(0, contentWidth - 1 - plainLength));
      const styled = selected ? SELECTED + padded.replace(/\x1b\[0m/g, SELECTED) + RESET :
        isGroup || isDetail ? DIM + padded + RESET : padded;
      return BORDER + "│" + RESET + " " + styled + BORDER + bar + RESET + BORDER + "│" + RESET;
    };
    const border = (left: string, right: string) =>
      BORDER + left + "─".repeat(boxWidth - 2) + right + RESET;

    const output = [border("╭", "╮")];
    this.renderedWidth = boxWidth;
    this.renderedTargets.push(undefined);
    const overflow = rows.length > capacity;
    const thumb = overflow ? Math.max(1, Math.round(capacity * capacity / rows.length)) : 0;
    const thumbStart = overflow ? Math.round(start * (capacity - thumb) / (rows.length - capacity)) : 0;
    for (const [index, row] of body.entries()) {
      const bar = !overflow ? " " : index >= thumbStart && index < thumbStart + thumb ? "█" : "│";
      output.push(frame(row.text, row.choice === this.selected && !row.detail, row.group, row.detail, bar));
      this.renderedTargets.push(row.choice);
    }
    const first = body.find(row => row.choice !== undefined)?.choice;
    const last = [...body].reverse().find(row => row.choice !== undefined)?.choice;
    const status = first === undefined ? "" : (first + 1) + "–" + (last! + 1) + " of " + this.choiceIndexes.length;
    output.push(frame(DIM + fit(status, contentWidth) + RESET));
    output.push(border("╰", "╯"));
    this.renderedTargets.push(undefined, undefined);
    return output;
  }
}
