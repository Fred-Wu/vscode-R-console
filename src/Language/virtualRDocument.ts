import * as vscode from "vscode";

/**
 * In-memory R document used only for console LSP synchronization.
 * It is never opened in VS Code's workspace document registry.
 */
export class VirtualRDocument {
  readonly uri: vscode.Uri;
  readonly languageId = "r";
  version = 1;
  private text: string;

  constructor(id: string, initialText = "", fileName = "completion.R") {
    this.uri = vscode.Uri.parse(`r-console://${id}/${fileName}`);
    this.text = initialText;
  }

  get lineCount(): number {
    return this.text.length === 0 ? 1 : this.text.split("\n").length;
  }

  update(nextText: string): void {
    if (nextText === this.text) {
      return;
    }
    this.text = nextText;
    this.version += 1;
  }

  getText(range?: vscode.Range): string {
    if (!range) {
      return this.text;
    }
    const start = this.offsetAt(range.start);
    const end = this.offsetAt(range.end);
    return this.text.slice(start, end);
  }

  positionAt(offset: number): vscode.Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    const lines = this.text.split("\n");
    let remaining = clamped;
    for (let line = 0; line < lines.length; line += 1) {
      const lineLen = lines[line].length;
      if (remaining <= lineLen) {
        return new vscode.Position(line, remaining);
      }
      // Account for newline char.
      remaining -= lineLen + 1;
    }
    const last = lines.length - 1;
    return new vscode.Position(last, lines[last].length);
  }

  offsetAt(position: vscode.Position): number {
    const lines = this.text.split("\n");
    const line = Math.max(0, Math.min(position.line, lines.length - 1));
    const char = Math.max(0, Math.min(position.character, lines[line].length));
    let offset = 0;
    for (let i = 0; i < line; i += 1) {
      offset += lines[i].length + 1;
    }
    return offset + char;
  }
}
