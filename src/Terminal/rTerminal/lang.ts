import * as vscode from "vscode";
import {
  CompletionPickItem,
  collectCompletionEntries,
  getCompletionContext,
  toCompletionPick,
} from "../../Language/completion";
import {
  ConsoleLspClient,
  type DocumentSemanticTokensResult,
} from "../../Language/consoleLspClient";
import { VirtualRDocument } from "../../Language/virtualRDocument";
import type {
  SessionMemberCompletionItem,
  WorkspaceData,
} from "../../Runtime/sessionWatcher";

export type InputSnapshot = {
  text: string;
  currentLine: string;
  cursorCol: number;
  cursorRow: number;
  lines: string[];
  textBeforeCursor: string;
};

type LangOptions = {
  rPath: string;
  requestMemberCompletions: (
    expression: string,
    operator: "$" | "@"
  ) => Promise<SessionMemberCompletionItem[] | undefined> | undefined;
};

type AutocompleteRequest = {
  input: InputSnapshot;
  getCurrentInput: () => InputSnapshot;
  getWorkspaceData: () => WorkspaceData | undefined;
  applyCompletion: (selection: CompletionPickItem) => void;
};

export class RTermLang {
  private completionInProgress = false;
  private completionDocument: VirtualRDocument | undefined;
  private readonly completionDocumentId = `${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  private readonly semanticRequestBaseId = `${this.completionDocumentId}-semantic`;
  private semanticRequestCounter = 0;
  private consoleLsp: ConsoleLspClient | undefined;
  private cachedLibraryContent = "";
  private cachedSearchPackages: string[] = [];
  private pendingLibraryPackages = new Set<string>();

  constructor(private readonly options: LangOptions) {}

  async start(): Promise<void> {
    await this.ensureConsoleLspStarted();
  }

  async handleAutocomplete({
    input,
    getCurrentInput,
    getWorkspaceData,
    applyCompletion,
  }: AutocompleteRequest): Promise<void> {
    if (this.completionInProgress) {
      return;
    }

    const context = getCompletionContext(
      input.currentLine,
      input.cursorCol,
      input.textBeforeCursor
    );
    if (!context) {
      return;
    }

    this.completionInProgress = true;
    try {
      const useLibraryLines =
        context.kind === "default" ||
        context.kind === "argument" ||
        context.kind === "package";
      await this.ensureConsoleLspStarted();

      const latestInput = getCurrentInput();
      if (
        latestInput.currentLine !== context.snapshotInput ||
        latestInput.cursorCol !== context.snapshotCursor
      ) {
        return;
      }

      const sessionData = getWorkspaceData();
      const libraryPrefix = useLibraryLines ? this.getEffectiveLibraryContent() : "";
      const content = libraryPrefix + latestInput.text;
      const libraryLineCount = libraryPrefix ? libraryPrefix.split("\n").length - 1 : 0;

      const doc = this.getOrUpdateCompletionDocument(content);
      if (!doc) {
        return;
      }
      if (this.consoleLsp) {
        await this.consoleLsp.prepareDocument(doc);
      }

      const position = new vscode.Position(
        latestInput.cursorRow + libraryLineCount,
        context.snapshotCursor
      );

      const linesBefore = latestInput.lines.slice(0, latestInput.cursorRow);
      const entries = await collectCompletionEntries(
        context,
        doc,
        position,
        sessionData,
        linesBefore,
        this.consoleLsp
      );

      if (entries.length === 0) {
        return;
      }

      const picks = entries.map((entry) => toCompletionPick(entry, context));
      const selection = await vscode.window.showQuickPick(picks, {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: "R console completions",
      });

      if (!selection) {
        return;
      }

      const currentInput = getCurrentInput();
      if (
        currentInput.currentLine !== selection.snapshotInput ||
        currentInput.cursorCol !== selection.snapshotCursor
      ) {
        return;
      }

      applyCompletion(selection);
    } finally {
      this.completionInProgress = false;
    }
  }

  cleanupCompletionDocument(): void {
    this.completionDocument = undefined;
  }

  stopConsoleLsp(): void {
    const lsp = this.consoleLsp;
    this.consoleLsp = undefined;
    if (!lsp) {
      return;
    }
    void lsp.dispose();
  }

  clearPendingLibraries(): void {
    this.pendingLibraryPackages.clear();
  }

  async requestSemanticTokens(
    content: string
  ): Promise<DocumentSemanticTokensResult | undefined> {
    await this.ensureConsoleLspStarted();
    if (!this.consoleLsp) {
      return undefined;
    }

    const requestId = `${this.semanticRequestBaseId}-${++this.semanticRequestCounter}`;
    const requestDocument = new VirtualRDocument(
      requestId,
      content,
      "semantic.R"
    ) as unknown as vscode.TextDocument;

    try {
      return await this.consoleLsp.provideDocumentSemanticTokens(requestDocument);
    } finally {
      this.consoleLsp.closeDocument(requestDocument);
    }
  }

  async refreshCompletionContextDocument(inputText: string): Promise<void> {
    await this.ensureConsoleLspStarted();
    if (!this.consoleLsp) {
      return;
    }

    const content = this.getEffectiveLibraryContent() + inputText;
    const doc = this.getOrUpdateCompletionDocument(content);
    if (!doc) {
      return;
    }
    await this.consoleLsp.prepareDocument(doc);
  }

  trackPendingLibraries(code: string): void {
    // Track package attach/detach intents from executed console code.
    const attachPattern =
      /\b(?:library|require)\s*\(\s*(?:package\s*=\s*)?(?:(["'])([A-Za-z][A-Za-z0-9._]*)\1|([A-Za-z][A-Za-z0-9._]*))/g;
    let match: RegExpExecArray | null;
    while ((match = attachPattern.exec(code)) !== null) {
      const pkg = (match[2] || match[3] || "").trim();
      if (!pkg) {
        continue;
      }
      this.pendingLibraryPackages.add(pkg);
    }

    const detachPattern =
      /\bdetach\s*\(\s*(?:(["'])package:([A-Za-z][A-Za-z0-9._]*)\1|package\s*=\s*(["'])([A-Za-z][A-Za-z0-9._]*)\3)\s*[,\)]/g;
    while ((match = detachPattern.exec(code)) !== null) {
      const pkg = (match[2] || match[4] || "").trim();
      if (!pkg) {
        continue;
      }
      this.pendingLibraryPackages.delete(pkg);
    }
  }

  updateSessionData(data: WorkspaceData | undefined): boolean {
    const currentSearch = data?.search ?? [];
    if (this.arraysEqual(currentSearch, this.cachedSearchPackages)) {
      return false;
    }

    const basePackages = new Set([
      "base",
      "methods",
      "datasets",
      "utils",
      "grDevices",
      "graphics",
      "stats",
    ]);
    const libraryLines = currentSearch
      .filter((value) => value.startsWith("package:"))
      .map((value) => value.slice(8))
      .filter((pkg) => !basePackages.has(pkg))
      .map((pkg) => `library(${pkg})`);

    this.cachedSearchPackages = [...currentSearch];
    this.cachedLibraryContent = libraryLines.length > 0 ? `${libraryLines.join("\n")}\n` : "";
    if (this.pendingLibraryPackages.size > 0) {
      const attached = new Set(
        currentSearch
          .filter((value) => value.startsWith("package:"))
          .map((value) => value.slice(8))
      );
      for (const pkg of this.pendingLibraryPackages) {
        if (attached.has(pkg)) {
          this.pendingLibraryPackages.delete(pkg);
        }
      }
    }

    return true;
  }

  private getOrUpdateCompletionDocument(
    content: string
  ): vscode.TextDocument | undefined {
    try {
      if (this.completionDocument) {
        this.completionDocument.update(content);
        return this.completionDocument as unknown as vscode.TextDocument;
      }

      this.completionDocument = new VirtualRDocument(
        this.completionDocumentId,
        content,
        "completion.R"
      );
      return this.completionDocument as unknown as vscode.TextDocument;
    } catch {
      return undefined;
    }
  }

  private async ensureConsoleLspStarted(): Promise<void> {
    if (this.consoleLsp) {
      try {
        await this.consoleLsp.start();
      } catch {
      }
      return;
    }

    this.consoleLsp = new ConsoleLspClient({
      consoleId: this.completionDocumentId,
      rPath: this.options.rPath,
      requestMemberCompletions: async (expression, operator) =>
        await this.options.requestMemberCompletions(expression, operator),
    });

    try {
      await this.consoleLsp.start();
    } catch {
    }
  }

  private getEffectiveLibraryContent(): string {
    const pendingPackages = [...this.pendingLibraryPackages];
    if (pendingPackages.length === 0) {
      return this.cachedLibraryContent;
    }

    const searchPackages = new Set(
      this.cachedSearchPackages
        .filter((value) => value.startsWith("package:"))
        .map((value) => value.slice(8))
    );
    const extraLines = pendingPackages
      .filter((pkg) => !searchPackages.has(pkg))
      .map((pkg) => `library(${pkg})`);
    if (extraLines.length === 0) {
      return this.cachedLibraryContent;
    }

    return `${this.cachedLibraryContent}${extraLines.join("\n")}\n`;
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) {
        return false;
      }
    }
    return true;
  }
}
