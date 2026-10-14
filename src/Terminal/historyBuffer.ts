export class HistoryBuffer {
  protected historyBuffer: string[] = [];
  protected sessionEntries: string[] = [];
  protected historyIndex = 0;
  protected readonly maxHistorySize = 20000;
  private searchNoDuplicates = false;

  setSearchNoDuplicates(value: boolean): void {
    this.searchNoDuplicates = value;
  }

  protected refreshFromDisk(): void {}

  push(entry: string): void {
    if (!entry.trim()) return;
    this.historyBuffer.push(entry);
    if (this.historyBuffer.length > this.maxHistorySize) this.historyBuffer.shift();
    this.sessionEntries.push(entry);
    if (this.sessionEntries.length > this.maxHistorySize) this.sessionEntries.shift();
    this.historyIndex = this.historyBuffer.length;
  }

  getEntries(): string[] {
    this.refreshFromDisk();
    return [...this.historyBuffer];
  }

  selectEntry(entry: string): void {
    this.refreshFromDisk();
    const index = this.historyBuffer.lastIndexOf(entry);
    if (index >= 0) {
      this.historyIndex = index;
    }
  }

  selectEntryAt(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.historyBuffer.length) {
      return;
    }
    // The picker holds a snapshot of this buffer. Set the original position
    // before refreshing, so a concurrent compaction remaps the same occurrence.
    this.historyIndex = index;
    this.refreshFromDisk();
  }

  getRecentSessionEntries(limit = 200): string[] {
    return limit > 0 ? this.sessionEntries.slice(-limit) : [];
  }

  resetIndex(): void {
    this.refreshFromDisk();
    this.historyIndex = this.historyBuffer.length;
  }

  navigate(direction: number): string | null | undefined {
    this.refreshFromDisk();
    if (this.historyBuffer.length === 0) return undefined;

    const length = this.historyBuffer.length;
    let nextIndex = this.historyIndex + direction;
    if (this.searchNoDuplicates && direction !== 0 && this.historyIndex < length) {
      const current = this.historyBuffer[this.historyIndex];
      // Skip commands identical to the currently displayed entry in either
      // direction. Comparing with the destination incorrectly visits the same
      // run again when navigating forward.
      while (nextIndex >= 0 && nextIndex < length &&
        this.historyBuffer[nextIndex] === current) {
        nextIndex += direction;
      }
    }
    if (nextIndex < 0 || nextIndex > length) return undefined;
    this.historyIndex = nextIndex;
    return nextIndex === length ? null : this.historyBuffer[nextIndex];
  }

  searchBackward(term: string, fromIndex?: number): string | null {
    this.refreshFromDisk();
    if (!term) return null;
    const start = fromIndex === undefined ? this.historyIndex - 1 : fromIndex;
    for (let i = start; i >= 0; i--) {
      if (this.historyBuffer[i].includes(term)) {
        this.historyIndex = i;
        return this.historyBuffer[i];
      }
    }
    return null;
  }
}
