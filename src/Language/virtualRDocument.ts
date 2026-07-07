import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const DOCUMENT_DIR_NAME = ".vscode-R-console";
const VIRTUAL_DOCUMENT_SCHEME = "r-console";
const GENERATED_CONTROL_FILES = new Set([".gitignore", ".lintr"]);
const initializedDocumentDirs = new Set<string>();
const virtualDocumentContents = new Map<string, string>();

class RConsoleDocumentContentProvider implements vscode.TextDocumentContentProvider {
  private readonly didChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.didChangeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return virtualDocumentContents.get(uri.toString()) ?? "";
  }

  update(uri: vscode.Uri, content: string): void {
    virtualDocumentContents.set(uri.toString(), content);
    this.didChangeEmitter.fire(uri);
  }

  delete(uri: vscode.Uri): void {
    virtualDocumentContents.delete(uri.toString());
    this.didChangeEmitter.fire(uri);
  }
}

let virtualDocumentProvider: RConsoleDocumentContentProvider | undefined;

function ensureVirtualDocumentProvider(): RConsoleDocumentContentProvider {
  if (!virtualDocumentProvider) {
    virtualDocumentProvider = new RConsoleDocumentContentProvider();
    vscode.workspace.registerTextDocumentContentProvider(
      VIRTUAL_DOCUMENT_SCHEME,
      virtualDocumentProvider
    );
  }
  return virtualDocumentProvider;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function resolveDocumentRoot(workspacePath: string | undefined): string {
  if (workspacePath) {
    const candidate = path.resolve(workspacePath);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(candidate));
    if (folder?.uri.scheme === "file") {
      return folder.uri.fsPath;
    }
    return candidate;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.scheme === "file"
  );
  return workspaceFolder?.uri.fsPath ?? path.join(os.tmpdir(), "vscode-R-console");
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.promises.writeFile(filePath, content, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const existing = await fs.promises.readFile(filePath, "utf8");
    if (existing === content) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await fs.promises.writeFile(filePath, content, "utf8");
}

async function makeGeneratedFileWritable(filePath: string): Promise<void> {
  try {
    await fs.promises.chmod(filePath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function unhideGeneratedPath(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("attrib", ["-h", filePath], { windowsHide: true }, () => resolve());
    });
    return;
  }
  if (process.platform === "darwin") {
    await new Promise<void>((resolve) => {
      execFile("chflags", ["nohidden", filePath], () => resolve());
    });
  }
}

async function hideGeneratedPath(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("attrib", ["+h", filePath], { windowsHide: true }, () => resolve());
    });
    return;
  }
  if (process.platform === "darwin") {
    await new Promise<void>((resolve) => {
      execFile("chflags", ["hidden", filePath], () => resolve());
    });
  }
}

function makeGeneratedFileWritableSync(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
  }
}

async function writeGeneratedFile(
  filePath: string,
  content: string
): Promise<void> {
  await unhideGeneratedPath(filePath);
  await makeGeneratedFileWritable(filePath);
  await fs.promises.writeFile(filePath, content, {
    encoding: "utf8",
    mode: 0o600,
  });
  await hideGeneratedPath(filePath);
}

async function ensureDocumentDir(dir: string): Promise<void> {
  if (initializedDocumentDirs.has(dir)) {
    return;
  }

  await fs.promises.mkdir(dir, { recursive: true });
  const gitignorePath = path.join(dir, ".gitignore");
  const lintrPath = path.join(dir, ".lintr");
  await writeFileIfMissing(gitignorePath, "*\n");
  await writeFileIfChanged(
    lintrPath,
    'linters: NULL\nexclusions: list("*.R" = Inf, "*.r" = Inf, "*.rconsole" = Inf)\n'
  );
  await Promise.all([
    hideGeneratedPath(dir),
    hideGeneratedPath(gitignorePath),
    hideGeneratedPath(lintrPath),
  ]);
  initializedDocumentDirs.add(dir);
}

function removeDocumentDirIfEmpty(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir);
    const generatedDocuments = entries.filter(
      (entry) => !GENERATED_CONTROL_FILES.has(entry)
    );
    if (generatedDocuments.length > 0) {
      return false;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    initializedDocumentDirs.delete(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * R document adapter used for console language requests. It can either be a
 * hidden workspace R file for vscode-R completion routing or an in-memory
 * r-console document for transient semantic requests.
 */
export class VirtualRDocument {
  readonly uri: vscode.Uri;
  readonly languageId = "r";
  version = 1;
  private text: string;
  private readonly fileBacked: boolean;

  constructor(
    id: string,
    initialText = "",
    fileName = "console.rconsole",
    workspacePath?: string,
    fileBacked = true
  ) {
    this.fileBacked = fileBacked;
    if (!fileBacked) {
      this.uri = vscode.Uri.parse(
        `${VIRTUAL_DOCUMENT_SCHEME}://${sanitizePathPart(id)}/${sanitizePathPart(fileName)}`
      );
      this.text = initialText;
      return;
    }

    const root = resolveDocumentRoot(workspacePath);
    const safeId = sanitizePathPart(id);
    const safeFileName = sanitizePathPart(fileName) || "console.rconsole";
    const dir = path.join(root, DOCUMENT_DIR_NAME);
    this.uri = vscode.Uri.file(
      path.join(dir, `${safeId || "console"}-${safeFileName}`)
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
    this.text = nextText;
    this.version += 1;
    if (!this.fileBacked && virtualDocumentContents.has(this.uri.toString())) {
      ensureVirtualDocumentProvider().update(this.uri, this.text);
    }
  }

  dispose(): void {
    if (!this.fileBacked) {
      virtualDocumentProvider?.delete(this.uri);
      return;
    }

    const dir = path.dirname(this.uri.fsPath);
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === this.uri.toString()
    );
    if (openDocument?.languageId === this.languageId) {
      void vscode.languages.setTextDocumentLanguage(openDocument, "plaintext");
    }
    makeGeneratedFileWritableSync(this.uri.fsPath);
    try {
      fs.rmSync(this.uri.fsPath, { force: true });
    } catch {
    }
    removeDocumentDirIfEmpty(dir);
  }

  async writeFileBackedDocument(): Promise<vscode.TextDocument> {
    if (!this.fileBacked) {
      return await this.openTextDocument();
    }

    await this.writeFileBackedContent();
    return this as unknown as vscode.TextDocument;
  }

  async openTextDocument(): Promise<vscode.TextDocument> {
    if (this.fileBacked) {
      throw new Error("File-backed R console documents must not be opened.");
    }

    ensureVirtualDocumentProvider().update(this.uri, this.text);
    const document = await vscode.workspace.openTextDocument(this.uri);
    if (document.languageId !== this.languageId) {
      return await vscode.languages.setTextDocumentLanguage(
        document,
        this.languageId
      );
    }
    return document;
  }

  private async writeFileBackedContent(): Promise<void> {
    const dir = path.dirname(this.uri.fsPath);
    await ensureDocumentDir(dir);
    await writeGeneratedFile(this.uri.fsPath, this.text);
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
