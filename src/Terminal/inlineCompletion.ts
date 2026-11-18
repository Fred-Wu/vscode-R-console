import type { CompletionPickItem, CompletionQuickPickItem } from "../Language/completion";
import { completionMatch } from "../Language/completionMatch";

type DisplayRow = { item: CompletionQuickPickItem; choice?: number };

export type InlineCompletionColors = {
  matchForeground: string;
  selectedBackground: string;
};

const ESC = "\x1b[";
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
const GROUP_BUTTON_LABELS: Record<string, string> = {
  "Runtime Variables": "Vars", Variables: "Vars", "Runtime Functions": "R.Fns",
  Packages: "Pkgs", Functions: "Fns", Fields: "Flds", Arguments: "Args",
  "Recent Input": "Recent", Other: "Other",
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

function highlightMatch(label: string, query: string, color: string): string {
  if (!query) return label;
  const positions = completionMatch(label, query);
  if (!positions) return label;
  let result = "", offset = 0;
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    let end = start + 1;
    while (positions[i + 1] === end) { i++; end++; }
    result += label.slice(offset, start) + color + label.slice(start, end) + FG_RESET;
    offset = end;
  }
  return result + label.slice(offset);
}

function isChoice(item: CompletionQuickPickItem): item is CompletionPickItem {
  return "insertText" in item && "replaceStart" in item;
}

export class InlineCompletion {
  items: CompletionQuickPickItem[] = [];
  selected = 0;
  private choiceIndexes: number[] = [];
  private rows: DisplayRow[] = [];
  private compactRows: DisplayRow[] = [];
  private hasDetails = false;
  private choiceRows: number[] = [];
  private generation = 0;
  private renderedTargets: Array<number | undefined> = [];
  private renderedWidth = 0;
  private renderedLeft = 0;
  private scrollStart = 0;
  private query = "";
  private resultQuery = "";
  private resetSelectionOnUpdate = false;
  private manuallySelected = false;
  private followSelection = true;
  private viewportRows = 0;
  private totalRows = 0;
  private thumbStart = 0;
  private thumbSize = 0;
  private dragOffset: number | undefined;
  private compact = false;
  private groups: Array<{ label: string; choice: number; row: number }> = [];
  private groupTargets: Array<{ row: number; from: number; to: number; group: number }> = [];
  private bodyTop = 1;
  private scrollbarTop = 1;
  private scrollbarRows = 0;
  private rowBudget = 0;
  private maxScrollStart = 0;
  private highlightSelectedGroup = true;
  private scrollAnchorGroup: string | undefined;

  constructor(private readonly unicode: { wcwidth(codePoint: number): number }) {}

  get visible(): boolean { return this.choiceIndexes.length > 0; }
  get token(): number { return this.generation; }
  get hasRenderedRows(): boolean { return this.renderedTargets.length > 0; }

  isScrollbar(row: number, col: number): boolean {
    return this.hasRenderedRows && this.totalRows > this.viewportRows &&
      Number.isInteger(row) && row >= this.scrollbarTop && row < this.scrollbarTop + this.scrollbarRows &&
      col === this.renderedLeft + this.renderedWidth - 1;
  }

  get dragging(): boolean { return this.dragOffset !== undefined; }

  scroll(delta: number): void {
    this.followSelection = false;
    this.highlightSelectedGroup = false;
    this.scrollStart = Math.max(0, Math.min(this.maxScrollStart, this.scrollStart + delta));
  }

  page(direction: number): void { this.scroll(direction * this.viewportRows); }

  groupButton(row: number, col: number): number | undefined {
    if (!this.hasRenderedRows) return undefined;
    return this.groupTargets.find(target => row >= target.row - 1 && row <= target.row + 1 && col >= target.from && col < target.to)?.group;
  }

  activateGroup(group: number): void {
    this.endScroll();
    const target = this.groups[group];
    if (!target) return;
    this.move(target.choice - this.selected);
    this.scrollAnchorGroup = target.label;
    this.scrollStart = this.compact ? target.choice : target.row;
  }

  pageButton(row: number, col: number): -1 | 1 | undefined {
    if (!this.hasRenderedRows || row !== this.renderedTargets.length - 2) return undefined;
    if (col === this.renderedLeft + this.renderedWidth - 4) return -1;
    if (col === this.renderedLeft + this.renderedWidth - 2) return 1;
    return undefined;
  }

  startScroll(row: number): void {
    const position = row - this.scrollbarTop;
    if (position >= this.thumbStart && position < this.thumbStart + this.thumbSize) {
      this.dragOffset = position - this.thumbStart;
    } else {
      this.page(position < this.thumbStart ? -1 : 1);
    }
  }

  dragScroll(row: number): void {
    if (this.dragOffset === undefined) return;
    const travel = this.scrollbarRows - this.thumbSize;
    if (travel <= 0) return;
    const position = Math.max(0, Math.min(travel, row - this.scrollbarTop - this.dragOffset));
    this.scroll(Math.round(position / travel * this.maxScrollStart) - this.scrollStart);
  }

  endScroll(): void { this.dragOffset = undefined; }

  contains(row: number, col: number): boolean {
    return Number.isInteger(row) && row > 0 && row < this.renderedTargets.length - 1 &&
      col > this.renderedLeft + 1 && col < this.renderedLeft + this.renderedWidth - 1;
  }

  invalidate(resetSelection = false): number {
    if (resetSelection) {
      this.scrollAnchorGroup = undefined;
      this.selected = 0;
      this.scrollStart = 0;
      this.resetSelectionOnUpdate = true;
      this.manuallySelected = false;
      this.followSelection = true;
    }
    return ++this.generation;
  }

  clear(): void {
    this.generation++;
    this.items = [];
    this.choiceIndexes = [];
    this.rows = [];
    this.compactRows = [];
    this.hasDetails = false;
    this.choiceRows = [];
    this.selected = 0;
    this.renderedTargets = [];
    this.renderedWidth = 0;
    this.renderedLeft = 0;
    this.scrollStart = 0;
    this.query = "";
    this.resultQuery = "";
    this.resetSelectionOnUpdate = false;
    this.manuallySelected = false;
    this.followSelection = true;
    this.viewportRows = this.totalRows = 0;
    this.groups = [];
    this.groupTargets = [];
    this.maxScrollStart = this.rowBudget = 0;
    this.bodyTop = 1;
    this.scrollbarTop = 1;
    this.scrollbarRows = 0;
    this.highlightSelectedGroup = true;
    this.scrollAnchorGroup = undefined;
    this.endScroll();
  }

  setQuery(query: string): void {
    this.query = query;
  }

  set(items: CompletionQuickPickItem[], token: number, query = ""): boolean {
    if (token !== this.generation) return false;
    const previous = this.current();
    const queryChanged = query !== this.resultQuery;
    if (queryChanged) {
      this.scrollAnchorGroup = undefined;
      this.manuallySelected = false;
    }
    this.resultQuery = query;
    this.items = items;
    this.query = query;
    this.choiceIndexes = [];
    this.rows = [];
    this.compactRows = [];
    this.hasDetails = false;
    this.choiceRows = [];
    const previousAnchor = this.groups.find(group => group.label === this.scrollAnchorGroup);
    const anchoredAtTop = previousAnchor && this.scrollStart === (this.compact ? previousAnchor.choice : previousAnchor.row);
    this.groups = [];
    let heading: { label: string; row: number } | undefined;
    items.forEach((item, index) => {
      if (isChoice(item)) {
        const choice = this.choiceIndexes.length;
        if (heading) {
          this.groups.push({ ...heading, choice });
          heading = undefined;
        }
        this.choiceIndexes.push(index);
        this.choiceRows.push(this.rows.length);
        this.rows.push({ item, choice });
        this.compactRows.push({ item, choice });
        this.hasDetails ||= !!item.detail;
      } else {
        heading = { label: item.label, row: this.rows.length };
        this.rows.push({ item });
      }
    });
    const nextAnchor = anchoredAtTop && this.groups.find(group => group.label === this.scrollAnchorGroup);
    if (nextAnchor) this.scrollStart = this.compact ? nextAnchor.choice : nextAnchor.row;
    this.groupTargets = [];
    const matching = previous && this.choiceIndexes.findIndex(index => {
      const entry = items[index];
      return isChoice(entry) && entry.label === previous.label &&
        entry.insertText === previous.insertText &&
        entry.description === previous.description && entry.detail === previous.detail;
    });
    // Ranking and grouping already determine the displayed order. Start there,
    // preserving only explicit navigation while the same query is refreshed.
    this.selected = !this.resetSelectionOnUpdate && this.manuallySelected &&
      matching !== undefined && matching >= 0 ? matching : 0;
    if (matching !== this.selected) this.manuallySelected = false;
    this.followSelection ||= queryChanged || matching !== this.selected;
    this.highlightSelectedGroup ||= queryChanged || this.resetSelectionOnUpdate || matching !== this.selected;
    this.endScroll();
    return true;
  }

  move(delta: number): void {
    if (this.visible) {
      this.resetSelectionOnUpdate = false;
      this.manuallySelected = true;
      this.selected = Math.max(0, Math.min(this.choiceIndexes.length - 1, this.selected + delta));
      this.highlightSelectedGroup = true;
      this.followSelection = true;
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

  private cellWidth(value: string): number {
    let width = 0;
    for (const character of value) {
      width += this.unicode.wcwidth(character.codePointAt(0)!);
    }
    return width;
  }

  private fit(value: string, width: number): string {
    if (width <= 0) return "";
    const text = value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    let cells = 0;
    let offset = 0;
    let ellipsisOffset = 0;
    for (const character of text) {
      cells += this.unicode.wcwidth(character.codePointAt(0)!);
      if (cells > width) return text.slice(0, ellipsisOffset) + "…";
      offset += character.length;
      if (cells < width) ellipsisOffset = offset;
    }
    return text;
  }

  lines(
    width: number,
    availableRows: number,
    anchorColumn = 1,
    colors: InlineCompletionColors = DEFAULT_COLORS
  ): string[] {
    const previousWidth = this.renderedWidth;
    const previousLeft = this.renderedLeft;
    this.renderedTargets = [];
    this.renderedWidth = 0;
    this.renderedLeft = 0;
    this.groupTargets = [];
    if (!this.visible || width < 12 || availableRows < 4) return [];

    const boxWidth = Math.min(60, width - 1);
    const left = Math.max(0, Math.min(
      Math.max(1, Math.floor(anchorColumn)) - 1,
      width - boxWidth - 1
    ));
    const indent = " ".repeat(left);
    if (previousWidth !== boxWidth || previousLeft !== left) this.endScroll();
    const contentWidth = boxWidth - 4;
    const compact = width < 30 || availableRows < 7;
    if (compact !== this.compact) {
      const anchor = this.groups.find(group => group.label === this.scrollAnchorGroup);
      if (anchor && this.scrollStart === (this.compact ? anchor.choice : anchor.row)) {
        this.scrollStart = compact ? anchor.choice : anchor.row;
      }
      this.compact = compact;
      this.followSelection = true;
      this.endScroll();
    }
    const rows = compact ? this.compactRows : this.rows;
    // Reserve a stable detail row only when useful and space permits. The
    // candidates themselves always occupy one row, so scrolling has one model.
    const showDetail = !compact && this.hasDetails;
    const buttonRows: Array<Array<{ group: number; label: string; offset: number }>> = [];
    if (this.groups.length > 1) {
      let used = 0;
      for (const [group, entry] of this.groups.entries()) {
        const name = GROUP_BUTTON_LABELS[entry.label] ?? entry.label;
        const label = this.fit(name, contentWidth - 2);
        const size = this.cellWidth(label) + 2;
        if (!buttonRows.length || used + size > contentWidth) {
          buttonRows.push([]);
          used = 0;
        }
        buttonRows[buttonRows.length - 1].push({ group, label, offset: used });
        used += size;
      }
      // Keep room for a heading and a suggestion in very short terminals.
      if (buttonRows.length * 3 > availableRows - 5 - Number(showDetail)) buttonRows.length = 0;
    }
    const headerHeight = buttonRows.length * 3;

    // Recheck selection visibility when capacity changes, even after a render
    // consumed followSelection. Ordinary redraws preserve independent scrolling.
    const budget = availableRows - 3 - Number(showDetail) - headerHeight;
    const groupAtRow = (row: number): number => {
      const next = this.groups.findIndex(group => (compact ? group.choice : group.row) > row);
      return (next < 0 ? this.groups.length : next) - 1;
    };
    const needsHeading = (row: number): boolean => budget >= 2 &&
      rows[row]?.choice !== undefined && groupAtRow(row) >= 0;
    // Count suggestions rather than headings toward the ten-result limit.
    const windowSize = (start: number, direction: 1 | -1): number => {
      let count = 0, choices = 0;
      const limit = budget - Number(direction === 1 && needsHeading(start));
      for (let row = start; row >= 0 && row < rows.length && count < limit; row += direction) {
        if (rows[row].choice !== undefined && ++choices > 10) break;
        count++;
      }
      if (direction === -1 && count === budget && needsHeading(start - count + 1)) count--;
      return count;
    };
    this.maxScrollStart = Math.max(0, rows.length - windowSize(rows.length - 1, -1));
    // An explicit group jump may leave a short final page. Do not backfill it
    // with earlier groups just to fill the viewport. Resolve by label so the
    // anchor survives refreshed results and compact-layout changes.
    const anchor = this.groups.find(group => group.label === this.scrollAnchorGroup);
    if (anchor) this.maxScrollStart = Math.max(this.maxScrollStart, compact ? anchor.choice : anchor.row);
    this.scrollStart = Math.min(this.scrollStart, this.maxScrollStart);
    let capacity = windowSize(this.scrollStart, 1);
    const activeRow = compact ? this.selected : this.choiceRows[this.selected];
    if (this.followSelection || this.rowBudget !== budget) {
      if (activeRow < this.scrollStart) this.scrollStart = activeRow;
      if (activeRow >= this.scrollStart + capacity) this.scrollStart = activeRow - windowSize(activeRow, -1) + 1;
      if (this.selected === 0) this.scrollStart = 0;
      else if (this.selected === this.choiceIndexes.length - 1) this.scrollStart = this.maxScrollStart;
      this.followSelection = false;
    }
    if (this.rowBudget !== budget) this.endScroll();
    this.rowBudget = budget;
    this.scrollStart = Math.max(0, Math.min(this.scrollStart, this.maxScrollStart));
    capacity = windowSize(this.scrollStart, 1);
    const start = this.scrollStart;
    const body = rows.slice(start, start + capacity);
    const activeGroup = groupAtRow(start);
    const activeGroupLabel = this.groups[activeGroup]?.label;
    const stickyHeading = needsHeading(start) ? activeGroupLabel : undefined;
    this.scrollbarTop = 1 + headerHeight;
    this.bodyTop = this.scrollbarTop + Number(stickyHeading !== undefined);
    const highlightedGroup = this.highlightSelectedGroup ? groupAtRow(activeRow) : activeGroup;
    const frame = (text: string, selected = false, muted = false, bar = " "): string => {
      const plainLength = this.cellWidth(text.replace(/\x1b\[[0-9;]*m/g, ""));
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
    for (const [index, buttons] of buttonRows.entries()) {
      const used = buttons.reduce((sum, button) => sum + this.cellWidth(button.label) + 2, 0);
      const buttonFrame = (text: string): string => BORDER + "│" + FG_RESET + text +
        " ".repeat(boxWidth - 2 - used) + BORDER + "│" + FG_RESET;
      output.push(buttonFrame(buttons.map(({ label }) => BORDER + "╭" + "─".repeat(this.cellWidth(label)) + "╮" + FG_RESET).join("")));
      const text = buttons.map(({ group, label, offset }) => {
        const from = left + 2 + offset;
        this.groupTargets.push({ row: index * 3 + 2,
          from, to: from + this.cellWidth(label) + 2, group });
        return BORDER + "│" + FG_RESET +
          (group === highlightedGroup ? colors.matchForeground : "") + label + FG_RESET +
          BORDER + "│" + FG_RESET;
      }).join("");
      output.push(buttonFrame(text));
      output.push(buttonFrame(buttons.map(({ label }) => BORDER + "╰" + "─".repeat(this.cellWidth(label)) + "╯" + FG_RESET).join("")));
      this.renderedTargets.push(undefined, undefined, undefined);
    }
    const overflow = rows.length > capacity;
    // The pinned heading shares the track, keeping its origin fixed while scrolling.
    this.scrollbarRows = capacity + this.bodyTop - this.scrollbarTop;
    const thumb = overflow ? Math.max(1, Math.round(this.scrollbarRows * capacity / rows.length)) : 0;
    const thumbStart = overflow && this.maxScrollStart > 0 ? Math.round(start * (this.scrollbarRows - thumb) / this.maxScrollStart) : 0;
    this.viewportRows = capacity;
    this.totalRows = rows.length;
    this.thumbStart = thumbStart;
    this.thumbSize = thumb;
    const scrollbar = (index: number): string => !overflow ? " " :
      index >= thumbStart && index < thumbStart + thumb ? "█" : "│";
    if (stickyHeading !== undefined) {
      output.push(frame(this.fit(stickyHeading, contentWidth), false, true, scrollbar(0)));
      this.renderedTargets.push(undefined);
    }
    for (const [index, row] of body.entries()) {
      const item = row.item;
      let text: string;
      const group = !isChoice(item);
      if (group) {
        text = this.fit(item.label, contentWidth);
      } else if (compact) {
        text = highlightMatch(this.fit(item.label.replace(ICON, ""), contentWidth), this.query, colors.matchForeground);
      } else {
        const iconKind = ICON.exec(item.label)?.[1];
        const moduleIcon = iconKind === "module";
        const label = this.fit(item.label.replace(ICON, ""), contentWidth - (moduleIcon ? 4 : 3));
        const description = this.fit(item.description ?? "", contentWidth);
        const iconColor = ESC + "38;5;" + (ICON_COLORS[iconKind ?? ""] ?? 245) + "m";
        const icon = iconColor + (moduleIcon ? "{}" : "●") + FG_RESET;
        const rest = contentWidth - this.cellWidth(label) - (moduleIcon ? 4 : 3);
        const descriptionWidth = this.cellWidth(description);
        const suffix = description && rest >= descriptionWidth + 2
          ? " ".repeat(rest - descriptionWidth) + DIM + description + DIM_RESET
          : "";
        text = icon + " " + highlightMatch(label, this.query, colors.matchForeground) + suffix;
      }
      const bar = scrollbar(index + this.bodyTop - this.scrollbarTop);
      output.push(frame(text, row.choice === this.selected, group, bar));
      this.renderedTargets.push(row.choice);
    }
    const first = body.find(row => row.choice !== undefined)?.choice;
    const last = [...body].reverse().find(row => row.choice !== undefined)?.choice;
    if (showDetail) {
      output.push(frame(this.fit(this.current()?.detail ?? "", contentWidth), false, true));
      this.renderedTargets.push(undefined);
    }
    const status = first === undefined ? "" : (first + 1) + "–" + (last! + 1) + "/" + this.choiceIndexes.length;
    const statusWidth = contentWidth - 3;
    const fittedStatus = this.fit(status, statusWidth);
    // Pseudoterminals cannot render $(triangle-left/right) Codicon markup.
    // Text triangles keep the same controls usable with ordinary terminal fonts.
    const previous = (start === 0 ? DIM : "") + "◀" + DIM_RESET;
    const next = (start + capacity >= rows.length ? DIM : "") + "▶" + DIM_RESET;
    output.push(frame(fittedStatus + " ".repeat(Math.max(0, statusWidth - this.cellWidth(fittedStatus))) + previous + " " + next));
    output.push(border("╰", "╯"));
    this.renderedTargets.push(undefined, undefined);
    return output.map(line => indent + line);
  }
}
