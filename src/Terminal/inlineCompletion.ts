import type { CompletionPickItem } from "../Language/completion";

export class InlineCompletion {
  items: CompletionPickItem[] = [];
  selected = 0;
  private generation = 0;

  get visible(): boolean { return this.items.length > 0; }
  get token(): number { return this.generation; }

  clear(): void {
    this.generation++;
    this.items = [];
    this.selected = 0;
  }

  set(items: CompletionPickItem[], token: number): boolean {
    if (token !== this.generation) return false;
    this.items = items;
    this.selected = 0;
    return true;
  }

  move(delta: number): void {
    if (this.items.length) {
      this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + delta));
    }
  }

  current(): CompletionPickItem | undefined { return this.items[this.selected]; }

  lines(width: number, availableRows: number): string[] {
    if (!this.visible || width < 15 || availableRows < 2) return [];
    const count = Math.min(8, Math.max(1, availableRows - 1), this.items.length);
    const start = Math.max(0, Math.min(this.selected - Math.floor(count / 2), this.items.length - count));
    const lines: string[] = [];
    for (let i = start; i < start + count; i++) {
      const entry = this.items[i];
      const marker = i === this.selected ? "> " : "  ";
      const label = entry.label.replace(/[\x00-\x1f\x7f\x1b]/g, " ");
      const detail = (entry.description ?? "").replace(/[\x00-\x1f\x7f\x1b]/g, " ");
      const max = width - 1;
      const suffix = detail ? "  " + detail : "";
      const main = marker + label;
      const line = (main + (main.length + suffix.length <= max ? suffix : "")).slice(0, max);
      lines.push(i === this.selected ? "\x1b[7m" + line + "\x1b[0m" : "\x1b[2m" + line + "\x1b[0m");
    }
    if (this.items.length > count) lines.push("\x1b[2m" + (start + 1) + "-" + (start + count) + "/" + this.items.length + "\x1b[0m");
    return lines;
  }
}
