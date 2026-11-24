import * as vscode from "vscode";
import { getCallOpenings, tokenizeForHighlighting } from "./parser";
import { runtimeCompletionText } from "./completion/runtimeDocument";
import { backtickRName } from "./completion/rText";
import type { NativeSourceBinding } from "./completion/staticProvider";

const VIRTUAL_DOCUMENT_SCHEME = "r-console";

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export class VirtualRDocument {
  readonly uri: vscode.Uri;
  readonly languageId = "r";
  version = 1;
  private text: string;
  private lineOffsets: number[] | undefined;
  private selections: { start: number; name: string; packageName: string }[] = [];
  private projectedDocument: VirtualRDocument | undefined;

  constructor(private readonly id: string, initialText = "") {
    this.uri = vscode.Uri.parse(
      `${VIRTUAL_DOCUMENT_SCHEME}://${sanitizePathPart(id)}/console.R`
    );
    this.text = initialText;
  }

  get lineCount(): number {
    return this.getLineOffsets().length;
  }

  update(nextText: string): void {
    if (nextText === this.text) {
      return;
    }
    this.selections = this.getSelections(nextText);
    this.text = nextText;
    this.lineOffsets = undefined;
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

  project(content: string, staticAnalysis = true, cursor?: vscode.Position,
    sourceBinding?: NativeSourceBinding) {
    // Picker previews must not change the selections saved with the actual input.
    const visible = new VirtualRDocument(this.id, content);
    const selections = this.getSelections(content);
    const openings = selections.length ? getCallOpenings(content) : undefined;
    const insertions = selections.filter((selection) => openings?.has(selection.start + selection.name.length));
    const parts: string[] = [];
    let previous = 0;
    for (const selection of insertions) {
      parts.push(content.slice(previous, selection.start), `${selection.packageName}::`);
      previous = selection.start;
    }
    parts.push(content.slice(previous));
    const text = parts.join("");
    const position = visible.offsetAt(cursor ?? visible.positionAt(content.length));
    const projectedOffset = position + insertions.reduce((sum, selection) =>
      sum + (selection.start <= position ? selection.packageName.length + 2 : 0), 0);
    // A guarded live closure definition is projected ahead of the editable
    // source. The user input remains last so draft redefinitions still win.
    // All mapping is local to this request; no session source journal exists.
    const prelude = staticAnalysis && sourceBinding?.body
      ? `${backtickRName(sourceBinding.name)} <- ${sourceBinding.body}\n` : "";
    const completionText = staticAnalysis ? prelude + text : runtimeCompletionText(text, projectedOffset);
    if (!this.projectedDocument || this.projectedDocument.getText() !== completionText) {
      const version = (this.projectedDocument?.version ?? 0) + 1;
      this.projectedDocument = new VirtualRDocument(this.id, completionText);
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
        return document.positionAt(prelude.length + offset + added);
      },
      toConsolePosition(position: vscode.Position): vscode.Position {
        let offset = Math.max(0, document.offsetAt(position) - prelude.length);
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
    const meaningful = tokenizeForHighlighting(content).filter(token => token.kind !== "comment");
    const tokens = new Map(meaningful.map((token, index) => [token.position, { token, previous: meaningful[index - 1] }]));
    return this.selections.flatMap((selection) => {
      if (oldEnd <= selection.start) {
        selection = { ...selection, start: selection.start + newEnd - oldEnd };
      } else if (start < selection.start + selection.name.length) {
        return [];
      }
      const { token, previous } = tokens.get(selection.start) ?? {};
      return token?.value === selection.name && (token.kind === "identifier" || token.kind === "function") &&
        !(previous?.kind === "operator" && ["$", "@", "::", ":::"].includes(previous.value)) ? [selection] : [];
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
    const offsets = this.getLineOffsets();
    let low = 0, high = offsets.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsets[middle] <= clamped) low = middle;
      else high = middle;
    }
    return new vscode.Position(low, clamped - offsets[low]);
  }

  offsetAt(position: vscode.Position): number {
    const offsets = this.getLineOffsets();
    const line = Math.max(0, Math.min(position.line, offsets.length - 1));
    const end = line + 1 < offsets.length ? offsets[line + 1] - 1 : this.text.length;
    return offsets[line] + Math.max(0, Math.min(position.character, end - offsets[line]));
  }

  private getLineOffsets(): number[] {
    if (!this.lineOffsets) {
      const offsets = [0];
      for (let next = this.text.indexOf("\n"); next >= 0; next = this.text.indexOf("\n", next + 1)) {
        offsets.push(next + 1);
      }
      this.lineOffsets = offsets;
    }
    return this.lineOffsets;
  }
}
