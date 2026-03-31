import * as fs from "fs";

export class HistoryManager {
  private historyBuffer: string[] = [];
  private historyIndex = 0;
  private searchNoDuplicates = false;
  private maxHistorySize = 10000;

  constructor(private historyFile: string) {}

  setSearchNoDuplicates(value: boolean): void {
    this.searchNoDuplicates = value;
  }

  load(): void {
    try {
      if (!fs.existsSync(this.historyFile)) {
        this.historyBuffer = [];
        this.historyIndex = 0;
        return;
      }

      const content = fs.readFileSync(this.historyFile, "utf-8");
      const entries = this.parseConsoleHistoryFormat(content);
      this.historyBuffer = entries;
      this.historyIndex = this.historyBuffer.length;
    } catch {
      this.historyBuffer = [];
      this.historyIndex = 0;
    }
  }

  private parseConsoleHistoryFormat(content: string): string[] {
    const entries: string[] = [];
    const lines = content.split(/\r?\n/);
    let currentLines: string[] = [];

    const flush = () => {
      if (currentLines.length > 0) {
        const entry = currentLines.join("\n");
        if (entry.trim()) {
          entries.push(entry);
        }
        currentLines = [];
      }
    };

    for (const line of lines) {
      if (line.startsWith("+")) {
        currentLines.push(line.substring(1));
      } else if (line.startsWith("#")) {
      } else if (line.trim() === "") {
        flush();
      }
    }

    flush();

    return entries;
  }

  save(): void {
    try {
      const entriesToSave = this.historyBuffer.slice(-this.maxHistorySize);
      let output = "";
      for (const entry of entriesToSave) {
        const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
        output += `\n# time: ${now}\n`;

        for (const line of entry.split("\n")) {
          output += `+${line}\n`;
        }
      }

      fs.writeFileSync(this.historyFile, output);
    } catch {
    }
  }

  private appendToFile(entry: string): void {
    try {
      const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
      let output = `\n# time: ${now}\n`;
      for (const line of entry.split("\n")) {
        output += `+${line}\n`;
      }
      fs.appendFileSync(this.historyFile, output);
    } catch {
    }
  }

  push(entry: string): void {
    this.historyBuffer.push(entry);
    this.historyIndex = this.historyBuffer.length;
    this.appendToFile(entry);
  }

  resetIndex(): void {
    this.historyIndex = this.historyBuffer.length;
  }

  navigate(direction: number): string | null | undefined {
    if (this.historyBuffer.length === 0) return undefined;

    const newIndex = this.historyIndex + direction;
    if (newIndex < 0 || newIndex > this.historyBuffer.length) return undefined;
    this.historyIndex = newIndex;
    if (newIndex === this.historyBuffer.length) {
      return null;
    }
    if (!this.searchNoDuplicates) {
      return this.historyBuffer[newIndex];
    }
    const current = this.historyBuffer[newIndex];
    let idx = newIndex;
    if (direction < 0) {
      while (idx > 0 && this.historyBuffer[idx - 1] === current) {
        idx -= 1;
      }
    } else {
      while (idx < this.historyBuffer.length - 1 && this.historyBuffer[idx + 1] === current) {
        idx += 1;
      }
    }
    this.historyIndex = idx;
    return this.historyBuffer[idx];
  }

  searchBackward(term: string, fromIndex?: number): string | null {
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
