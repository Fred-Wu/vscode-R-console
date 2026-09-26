import * as vscode from "vscode";
import { tokenizeForHighlighting } from "./parser";

const VIRTUAL_DOCUMENT_SCHEME = "r-console";

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export class VirtualRDocument {
  readonly uri: vscode.Uri;
  readonly languageId = "r";
  version = 1;
  private text: string;
  private selections: { start: number; name: string; packageName: string }[] = [];
  private projectedDocument: VirtualRDocument | undefined;

  constructor(private readonly id: string, initialText = "") {
    this.uri = vscode.Uri.parse(
      `${VIRTUAL_DOCUMENT_SCHEME}://${sanitizePathPart(id)}/console.R`
    );
    this.text = initialText;
  }

  get lineCount(): number {
    return this.text.length === 0 ? 1 : this.text.split("\n").length;
  }

  update(nextText: string): void {
    if (nextText === this.text) {
      return;
    }
    this.selections = this.getSelections(nextText);
    this.text = nextText;
    this.version += 1;
  }

  selectFunction(start: number, insertedText: string, packageName?: string): void {
    this.selections = this.selections.filter((selection) =>
      selection.start + selection.name.length <= start || selection.start >= start + insertedText.length
    );
    const token = tokenizeForHighlighting(insertedText)[0];
    if (packageName && token?.position === 0 && (token.kind === "function" || token.kind === "identifier")) {
      this.selections.push({ start, name: token.value, packageName });
      this.selections.sort((a, b) => a.start - b.start);
    }
  }

  project(content: string) {
    // Picker previews must not change the selections saved with the actual input.
    const visible = new VirtualRDocument(this.id, content);
    const insertions = this.getSelections(content).filter((selection) =>
      /^\s*\(/.test(content.slice(selection.start + selection.name.length))
    );
    const parts: string[] = [];
    let previous = 0;
    for (const selection of insertions) {
      parts.push(content.slice(previous, selection.start), `${selection.packageName}::`);
      previous = selection.start;
    }
    parts.push(content.slice(previous));
    const text = parts.join("");
    if (!this.projectedDocument || this.projectedDocument.getText() !== text) {
      const version = (this.projectedDocument?.version ?? 0) + 1;
      this.projectedDocument = new VirtualRDocument(this.id, text);
      this.projectedDocument.version = version;
    }
    const document = this.projectedDocument;
    return {
      document: document as unknown as vscode.TextDocument,
      toServerPosition(position: vscode.Position): vscode.Position {
        const offset = visible.offsetAt(position);
        const added = insertions.reduce((sum, selection) =>
          sum + (selection.start <= offset ? selection.packageName.length + 2 : 0), 0
        );
        return document.positionAt(offset + added);
      },
      toConsolePosition(position: vscode.Position): vscode.Position {
        let offset = document.offsetAt(position);
        for (const selection of insertions) {
          if (offset < selection.start) break;
          offset = Math.max(selection.start, offset - selection.packageName.length - 2);
        }
        return visible.positionAt(offset);
      },
    };
  }

  private getSelections(content: string): typeof this.selections {
    if (this.selections.length === 0) return [];
    let start = 0;
    while (start < this.text.length && start < content.length && this.text[start] === content[start]) start++;
    let oldEnd = this.text.length;
    let newEnd = content.length;
    while (oldEnd > start && newEnd > start && this.text[oldEnd - 1] === content[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    const tokens = new Map(tokenizeForHighlighting(content).map((token) => [token.position, token]));
    return this.selections.flatMap((selection) => {
      if (oldEnd <= selection.start) {
        selection = { ...selection, start: selection.start + newEnd - oldEnd };
      } else if (start < selection.start + selection.name.length) {
        return [];
      }
      const token = tokens.get(selection.start);
      return token?.value === selection.name && (token.kind === "identifier" || token.kind === "function") &&
        !/[$@:]\s*$/.test(content.slice(0, selection.start)) ? [selection] : [];
    });
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
