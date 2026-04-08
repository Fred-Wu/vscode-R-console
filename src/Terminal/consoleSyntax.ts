import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { OnigScanner, OnigString, loadWASM } from "vscode-oniguruma";
import { INITIAL, Registry, parseRawGrammar, type IGrammar, type StateStack } from "vscode-textmate";
import { ANSI } from "./ansi";
import type { DocumentSemanticTokensResult } from "../Language/consoleLspClient";
import type { RendererLineHighlighter } from "./renderer";
import { SyntaxTheme } from "./syntaxTheme";

type SemanticProvider = (content: string) => Promise<DocumentSemanticTokensResult | undefined>;

const R_SCOPE_NAME = "source.r";
const R_SYNTAX_EXTENSION_ID = "REditorSupport.r-syntax";

type GrammarContribution = {
  language?: string;
  scopeName?: string;
  path?: string;
};

const OPEN_TO_CLOSE: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
};

const CLOSING_BRACKETS = new Set([")", "]", "}"]);

export class ConsoleSyntax implements RendererLineHighlighter {
  private readonly theme = new SyntaxTheme();
  private grammar: IGrammar | undefined;
  private grammarPromise: Promise<IGrammar | undefined> | undefined;
  private sourceLines: string[] = [];
  private sourceKey = "";
  private styles: string[][] = [];
  private sourceVersion = 0;
  private appliedSemanticVersion = 0;
  private wantedSemanticVersion = 0;
  private semanticRequestInFlight = false;

  constructor(
    private readonly onDidChange: () => void,
    private readonly requestSemantics?: SemanticProvider
  ) {
    void this.ensureGrammar();
  }

  setSource(lines: string[]): void {
    const nextLines = [...lines];
    const nextKey = nextLines.join("\n");
    if (nextKey === this.sourceKey) {
      return;
    }

    this.sourceLines = nextLines;
    this.sourceKey = nextKey;
    this.styles = this.buildLiveStyles(nextLines);
    this.appliedSemanticVersion = 0;
    void this.ensureGrammar();

    const sourceVersion = ++this.sourceVersion;
    if (!nextKey.trim() || !this.requestSemantics) {
      this.wantedSemanticVersion = 0;
      return;
    }

    this.wantedSemanticVersion = sourceVersion;
    void this.runLatestSemanticRequest();
  }

  invalidateTheme(): void {
    this.theme.invalidate();
    this.styles = this.buildLiveStyles(this.sourceLines);
    this.appliedSemanticVersion = 0;
    const sourceVersion = ++this.sourceVersion;

    if (!this.sourceKey.trim() || !this.requestSemantics) {
      this.wantedSemanticVersion = 0;
      this.onDidChange();
      return;
    }

    this.wantedSemanticVersion = sourceVersion;
    void this.runLatestSemanticRequest();
  }

  dispose(): void {
    this.theme.invalidate();
    this.sourceLines = [];
    this.sourceKey = "";
    this.styles = [];
    this.appliedSemanticVersion = 0;
    this.sourceVersion += 1;
    this.wantedSemanticVersion = 0;
    this.semanticRequestInFlight = false;
  }

  highlightLines(lines: string[], sourceLineMap?: Array<number | undefined>): string[] {
    return lines.map((displayLine, index) => {
      const sourceLineIndex = sourceLineMap ? sourceLineMap[index] : index;
      if (sourceLineIndex === undefined) {
        return this.applyStyles(displayLine, new Array(displayLine.length).fill(""));
      }

      const sourceLine = this.sourceLines[sourceLineIndex];
      const sourceStyles = this.styles[sourceLineIndex];
      const fallbackStyles = new Array(displayLine.length).fill("");
      if (sourceLine === undefined || !sourceStyles || sourceStyles.length === 0) {
        return this.applyStyles(displayLine, fallbackStyles);
      }

      if (displayLine === sourceLine && sourceStyles.length === displayLine.length) {
        return this.applyStyles(displayLine, sourceStyles);
      }

      if (
        displayLine.endsWith("...") &&
        sourceLine.startsWith(displayLine.slice(0, -3)) &&
        displayLine.length >= 3
      ) {
        const prefixLength = displayLine.length - 3;
        return this.applyStyles(
          displayLine,
          sourceStyles.slice(0, prefixLength).concat(["", "", ""])
        );
      }

      return this.applyStyles(displayLine, fallbackStyles);
    });
  }

  prepareSnapshot(input: string | string[]): Promise<string[]> {
    const lines = Array.isArray(input) ? [...input] : input.split("\n");
    const sourceKey = lines.join("\n");

    if (!sourceKey.trim()) {
      return Promise.resolve(lines);
    }

    if (sourceKey === this.sourceKey && this.appliedSemanticVersion === this.sourceVersion) {
      return Promise.resolve(
        lines.map((line, index) => this.applyStyles(line, this.styles[index] ?? []))
      );
    }

    return this.buildSnapshot(lines, sourceKey);
  }

  snapshotNow(input: string | string[]): string[] {
    const lines = Array.isArray(input) ? [...input] : input.split("\n");
    const sourceKey = lines.join("\n");

    if (sourceKey === this.sourceKey && this.appliedSemanticVersion === this.sourceVersion) {
      return lines.map((line, index) => this.applyStyles(line, this.styles[index] ?? []));
    }

    const styles = this.buildLiveStyles(lines);
    return lines.map((line, index) => this.applyStyles(line, styles[index] ?? []));
  }

  private async buildSnapshot(lines: string[], sourceKey: string): Promise<string[]> {
    await this.ensureGrammar();
    const styles = this.buildLiveStyles(lines);
    const semanticTokens = this.requestSemantics
      ? await this.requestSemantics(sourceKey)
      : undefined;
    if (semanticTokens) {
      this.applySemanticStyles(styles, semanticTokens);
    }
    return lines.map((line, index) => this.applyStyles(line, styles[index] ?? []));
  }

  private async runLatestSemanticRequest(): Promise<void> {
    if (this.semanticRequestInFlight || !this.requestSemantics) {
      return;
    }

    this.semanticRequestInFlight = true;
    try {
      while (
        this.wantedSemanticVersion > 0 &&
        this.wantedSemanticVersion > this.appliedSemanticVersion
      ) {
        await this.ensureGrammar();
        const requestedVersion = this.wantedSemanticVersion;
        const requestedContent = this.sourceKey;
        const semanticTokens = await this.requestSemantics(requestedContent);
        if (!semanticTokens || requestedVersion !== this.sourceVersion) {
          console.log("[r-console][semantic] applyCurrentSemantic skipped", {
            hasTokens: Boolean(semanticTokens),
            sourceVersion: requestedVersion,
            currentSourceVersion: this.sourceVersion,
            contentPreview: requestedContent.slice(0, 120),
          });
          continue;
        }

        const styles = this.buildLiveStyles(this.sourceLines);
        this.applySemanticStyles(styles, semanticTokens);
        this.styles = styles;
        this.appliedSemanticVersion = requestedVersion;
        console.log("[r-console][semantic] applyCurrentSemantic applied", {
          sourceVersion: requestedVersion,
          contentPreview: requestedContent.slice(0, 120),
          tokenCount: semanticTokens.data.length / 5,
        });
        this.onDidChange();
      }
    } finally {
      this.semanticRequestInFlight = false;
      if (this.wantedSemanticVersion > 0 && this.wantedSemanticVersion > this.appliedSemanticVersion) {
        void this.runLatestSemanticRequest();
      }
    }
  }

  private buildLiveStyles(lines: string[]): string[][] {
    if (!this.grammar) {
      return lines.map((line) => new Array(line.length).fill(""));
    }

    let state: StateStack | null = INITIAL;
    const bracketStack: Array<{ close: string; depth: number }> = [];
    return lines.map((line) => {
      const row = new Array(line.length).fill("");
      const result = this.grammar?.tokenizeLine(line, state);
      state = result?.ruleStack ?? INITIAL;

      for (const token of result?.tokens ?? []) {
        const ansi = this.theme.resolveScopesToAnsi(token.scopes);
        if (!ansi) {
          continue;
        }
        const start = Math.max(0, token.startIndex);
        const end = Math.min(row.length, token.endIndex);
        for (let cursor = start; cursor < end; cursor += 1) {
          row[cursor] = ansi;
        }
      }

      this.applyBracketPairStyles(line, row, result?.tokens ?? [], bracketStack);

      return row;
    });
  }

  private ensureGrammar(): Promise<IGrammar | undefined> {
    if (this.grammar) {
      return Promise.resolve(this.grammar);
    }

    if (this.grammarPromise) {
      return this.grammarPromise;
    }

    const request = loadRGrammar()
      .then((grammar) => {
        this.grammar = grammar;
        return grammar;
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.grammarPromise === request) {
          this.grammarPromise = undefined;
        }
      });

    this.grammarPromise = request;

    void request.then((grammar) => {
      if (!grammar || this.sourceLines.length === 0) {
        return;
      }

      this.appliedSemanticVersion = 0;
      if (!this.sourceKey.trim() || !this.requestSemantics) {
        this.styles = this.buildLiveStyles(this.sourceLines);
        this.onDidChange();
        return;
      }

      const sourceVersion = ++this.sourceVersion;
      this.wantedSemanticVersion = sourceVersion;
      void this.runLatestSemanticRequest();
    });

    return request;
  }

  private applySemanticStyles(
    styles: string[][],
    semanticTokens: DocumentSemanticTokensResult
  ): void {
    let line = 0;
    let char = 0;

    for (let index = 0; index + 4 < semanticTokens.data.length; index += 5) {
      const deltaLine = semanticTokens.data[index];
      const deltaStart = semanticTokens.data[index + 1];
      const length = semanticTokens.data[index + 2];
      const tokenTypeIndex = semanticTokens.data[index + 3];
      const tokenModifierBits = semanticTokens.data[index + 4];
      const tokenType = semanticTokens.legend.tokenTypes[tokenTypeIndex];
      const tokenModifiers = decodeTokenModifiers(
        tokenModifierBits,
        semanticTokens.legend.tokenModifiers
      );

      line += deltaLine;
      char = deltaLine === 0 ? char + deltaStart : deltaStart;

      if (!tokenType || line < 0 || line >= styles.length || length <= 0) {
        continue;
      }

      const ansi = this.theme.resolveSemanticTokenToAnsi(tokenType, tokenModifiers);
      if (tokenType === "function" || tokenType === "method") {
        console.log("[r-console][semantic] applying function-like token", {
          line,
          char,
          length,
          tokenType,
          tokenModifiers,
          ansi,
        });
      }
      if (!ansi) {
        continue;
      }

      const row = styles[line];
      const end = Math.min(row.length, char + length);
      for (let cursor = Math.max(0, char); cursor < end; cursor += 1) {
        row[cursor] = ansi;
      }
    }
  }

  private applyBracketPairStyles(
    line: string,
    row: string[],
    tokens: readonly { startIndex: number; endIndex: number; scopes: string[] }[],
    stack: Array<{ close: string; depth: number }>
  ): void {
    for (const token of tokens) {
      if (hasNonCodeScope(token.scopes)) {
        continue;
      }

      const start = Math.max(0, token.startIndex);
      const end = Math.min(line.length, token.endIndex);
      for (let cursor = start; cursor < end; cursor += 1) {
        const char = line[cursor];
        const close = OPEN_TO_CLOSE[char];
        if (close) {
          const ansi = this.theme.resolveBracketPairAnsi(stack.length);
          if (ansi) {
            row[cursor] = ansi;
          }
          stack.push({ close, depth: stack.length });
          continue;
        }

        if (!CLOSING_BRACKETS.has(char)) {
          continue;
        }

        const current = stack[stack.length - 1];
        const depth =
          current && current.close === char ? current.depth : Math.max(stack.length - 1, 0);
        const ansi = this.theme.resolveBracketPairAnsi(depth);
        if (ansi) {
          row[cursor] = ansi;
        }
        if (current && current.close === char) {
          stack.pop();
        }
      }
    }
  }

  private applyStyles(text: string, styles: string[]): string {
    if (text.length === 0 || styles.length === 0) {
      return text;
    }

    let result = "";
    let currentStyle = "";

    for (let index = 0; index < text.length; index += 1) {
      const nextStyle = styles[index] ?? "";
      if (nextStyle !== currentStyle) {
        if (currentStyle) {
          result += ANSI.reset;
        }
        if (nextStyle) {
          result += nextStyle;
        }
        currentStyle = nextStyle;
      }
      result += text[index];
    }

    if (currentStyle) {
      result += ANSI.reset;
    }

    return result;
  }
}

function decodeTokenModifiers(bits: number, legend: readonly string[]): string[] {
  const modifiers: string[] = [];
  for (let index = 0; index < legend.length; index += 1) {
    if ((bits & (1 << index)) !== 0) {
      modifiers.push(legend[index]);
    }
  }
  return modifiers;
}

function hasNonCodeScope(scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope.startsWith("string") || scope.startsWith("comment"));
}

async function loadRGrammar(): Promise<IGrammar | undefined> {
  const grammarPath = resolveRGrammarPath();
  if (!grammarPath) {
    return undefined;
  }

  const onigWasmPath = path.resolve(
    __dirname,
    "..",
    "node_modules",
    "vscode-oniguruma",
    "release",
    "onig.wasm"
  );
  const wasm = await fs.promises.readFile(onigWasmPath);
  const onigLib = loadWASM(wasm).then(() => ({
    createOnigScanner(patterns: string[]): OnigScanner {
      return new OnigScanner(patterns);
    },
    createOnigString(content: string): OnigString {
      return new OnigString(content);
    },
  }));

  const registry = new Registry({
    onigLib,
    loadGrammar: async (scopeName) => {
      if (scopeName !== R_SCOPE_NAME) {
        return null;
      }

      const rawGrammar = await fs.promises.readFile(grammarPath, "utf8");
      return parseRawGrammar(rawGrammar, grammarPath);
    },
  });

  return (await registry.loadGrammar(R_SCOPE_NAME)) ?? undefined;
}

function resolveRGrammarPath(): string | undefined {
  const preferred = vscode.extensions.getExtension(R_SYNTAX_EXTENSION_ID);
  const preferredPath = preferred
    ? findGrammarPath(preferred.extensionPath, preferred.packageJSON?.contributes?.grammars)
    : undefined;
  if (preferredPath) {
    return preferredPath;
  }

  for (const extension of vscode.extensions.all) {
    const grammarPath = findGrammarPath(
      extension.extensionPath,
      extension.packageJSON?.contributes?.grammars
    );
    if (grammarPath) {
      return grammarPath;
    }
  }

  return undefined;
}

function findGrammarPath(
  extensionPath: string,
  grammars: GrammarContribution[] | undefined
): string | undefined {
  if (!Array.isArray(grammars)) {
    return undefined;
  }

  for (const grammar of grammars) {
    if (
      grammar.language !== "r" ||
      grammar.scopeName !== R_SCOPE_NAME ||
      typeof grammar.path !== "string"
    ) {
      continue;
    }

    return path.join(extensionPath, grammar.path);
  }

  return undefined;
}
