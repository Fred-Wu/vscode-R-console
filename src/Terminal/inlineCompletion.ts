import type { CompletionPickItem, CompletionQuickPickItem } from "../Language/completion";

type DisplayRow = { text: string; choice?: number; group?: boolean; detail?: boolean };

const ESC = "\x1b[";
const RESET = ESC + "0m";
const DIM = ESC + "2m";
const BORDER = ESC + "90m";
const SELECTED = ESC + "1m";
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

  get visible(): boolean { return this.choiceIndexes.length > 0; }
  get token(): number { return this.generation; }

  invalidate(): number { return ++this.generation; }

  clear(): void {
    this.generation++;
    this.items = [];
    this.choiceIndexes = [];
    this.selected = 0;
  }

  set(items: CompletionQuickPickItem[], token: number): boolean {
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
    this.selected = matching !== undefined && matching >= 0 ? matching : 0;
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

  lines(width: number, availableRows: number): string[] {
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
      const label = fit(item.label.replace(ICON, ""), contentWidth - (moduleIcon ? 3 : 2));
      const description = clean(item.description ?? "");
      const color = ESC + "38;5;" + (ICON_COLORS[iconKind ?? ""] ?? 245) + "m";
      const icon = color + (moduleIcon ? "{}" : choice === this.selected ? "◉" : "●") + RESET;
      const labelWidth = [...label].length;
      const rest = contentWidth - labelWidth - (moduleIcon ? 3 : 2);
      const suffix = description && rest >= [...description].length + 2
        ? " ".repeat(rest - [...description].length) + description
        : "";
      rows.push({ text: icon + " " + (choice === this.selected ? SELECTED : "") + label + (choice === this.selected ? RESET : "") + suffix, choice });
      if (item.detail) {
        rows.push({ text: "  " + fit(item.detail, contentWidth - 2), choice, detail: true });
      }
      choice++;
    }

    // Keep the active completion in view; headers and details share the same row budget.
    const capacity = availableRows - 3; // top border, position footer, bottom border
    const activeRow = rows.findIndex(row => row.choice === this.selected && !row.detail);
    const start = Math.max(0, Math.min(activeRow - Math.floor(capacity / 2), rows.length - capacity));
    const body = rows.slice(start, start + capacity);
    const frame = (text: string, isGroup = false, isDetail = false): string => {
      const plainLength = [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
      const padded = text + " ".repeat(Math.max(0, contentWidth - plainLength));
      const styled = isGroup ? SELECTED + padded + RESET :
        isDetail ? DIM + padded + RESET : padded;
      return BORDER + "│" + RESET + " " + styled + " " + BORDER + "│" + RESET;
    };
    const border = (left: string, right: string) =>
      BORDER + left + "─".repeat(boxWidth - 2) + right + RESET;

    const output = [border("╭", "╮")];
    for (const row of body) {
      output.push(frame(row.text, row.group, row.detail));
    }
    const first = body.find(row => row.choice !== undefined)?.choice;
    const last = [...body].reverse().find(row => row.choice !== undefined)?.choice;
    const status = first === undefined ? "" : (first + 1) + "–" + (last! + 1) + " of " + this.choiceIndexes.length;
    output.push(frame(DIM + fit(status, contentWidth) + RESET));
    output.push(border("╰", "╯"));
    return output;
  }
}
