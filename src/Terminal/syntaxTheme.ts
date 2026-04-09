import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ANSI } from "./ansi";

type ThemeContribution = {
  id?: string;
  label?: string;
  path?: string;
};

type ThemeDocument = {
  include?: string;
  colors?: Record<string, string>;
  semanticTokenColors?: Record<string, string | SemanticTokenRule>;
  tokenColors?: TokenRule[] | string;
  settings?: TokenRule[];
};

type TokenRule = {
  scope?: string | string[];
  settings: {
    foreground?: string;
    fontStyle?: string;
  };
};

type SemanticTokenRule = {
  foreground?: string;
  fontStyle?: string;
};

type LoadedTheme = {
  key: string;
  rules: TokenRule[];
  semanticRules: Map<string, SemanticTokenRule>;
  semanticScopeRules: Map<string, readonly (readonly string[])[]>;
  bracketPairAnsi: string[];
  defaultForegroundAnsi: string;
};

const BUILTIN_SEMANTIC_SCOPE_RULES = new Map<string, readonly (readonly string[])[]>([
  ["comment", [["comment"]]],
  ["string", [["string"]]],
  ["keyword", [["keyword.control"]]],
  ["number", [["constant.numeric"]]],
  ["regexp", [["constant.regexp"]]],
  ["operator", [["keyword.operator"]]],
  ["namespace", [["entity.name.namespace"]]],
  ["type", [["entity.name.type"], ["support.type"]]],
  ["struct", [["entity.name.type.struct"]]],
  ["class", [["entity.name.type.class"], ["support.class"]]],
  ["interface", [["entity.name.type.interface"]]],
  ["enum", [["entity.name.type.enum"]]],
  ["typeParameter", [["entity.name.type.parameter"]]],
  ["function", [["entity.name.function"], ["support.function"]]],
  ["method", [["entity.name.function.member"], ["support.function"]]],
  ["member", [["entity.name.function.member"], ["support.function"]]],
  ["macro", [["entity.name.function.preprocessor"]]],
  ["variable", [["variable.other.readwrite"], ["entity.name.variable"]]],
  ["parameter", [["variable.parameter"]]],
  ["property", [["variable.other.property"]]],
  ["enumMember", [["variable.other.enummember"]]],
  ["event", [["variable.other.event"]]],
  ["decorator", [["entity.name.decorator"], ["entity.name.function"]]],
  ["variable.readonly", [["variable.other.constant"]]],
  ["property.readonly", [["variable.other.constant.property"]]],
  ["type.defaultLibrary", [["support.type"]]],
  ["class.defaultLibrary", [["support.class"]]],
  ["interface.defaultLibrary", [["support.class"]]],
  ["variable.defaultLibrary", [["support.variable"], ["support.other.variable"]]],
  ["variable.defaultLibrary.readonly", [["support.constant"]]],
  ["property.defaultLibrary", [["support.variable.property"]]],
  ["property.defaultLibrary.readonly", [["support.constant.property"]]],
  ["function.defaultLibrary", [["support.function"]]],
  ["method.defaultLibrary", [["support.function"]]],
  ["member.defaultLibrary", [["support.function"]]],
]);

const DEFAULT_BRACKET_COLORS = {
  dark: ["#FFD700", "#DA70D6", "#179FFF"],
  light: ["#0431FA", "#319331", "#7B3814"],
  highContrastDark: ["#FFD700", "#DA70D6", "#87CEFA"],
  highContrastLight: ["#0431FA", "#319331", "#7B3814"],
} as const;

const extensionNlsCache = new Map<string, Record<string, string>>();

export class SyntaxTheme {
  private current: LoadedTheme | undefined;
  private strictScopeCache = new Map<string, string>();
  private semanticCache = new Map<string, string>();

  invalidate(): void {
    this.current = undefined;
    this.strictScopeCache.clear();
    this.semanticCache.clear();
  }

  resolveBracketPairAnsi(depth: number): string {
    const theme = this.ensureLoaded();
    const enabled = vscode.workspace
      .getConfiguration("editor")
      .get<boolean>("bracketPairColorization.enabled", true);
    if (!enabled || theme.bracketPairAnsi.length === 0) {
      return "";
    }
    return theme.bracketPairAnsi[depth % theme.bracketPairAnsi.length] ?? "";
  }

  resolveDefaultForegroundAnsi(): string {
    return this.ensureLoaded().defaultForegroundAnsi;
  }

  private resolveScopedRuleToAnsi(scopes: readonly string[]): string {
    return this.resolveScopesToAnsiInternal(scopes);
  }

  private resolveScopesToAnsiInternal(scopes: readonly string[]): string {
    const key = scopes.join("|");
    const cached = this.strictScopeCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const { rules } = this.ensureLoaded();
    let foreground: string | undefined;
    let foregroundScore = Number.NEGATIVE_INFINITY;
    let foregroundIndex = -1;
    let bold = false;
    let italic = false;
    let underline = false;
    let fontStyleScore = Number.NEGATIVE_INFINITY;
    let fontStyleIndex = -1;

    for (const [ruleIndex, rule] of rules.entries()) {
      if (rule.scope === undefined) {
        continue;
      }

      const score = scoreRule(rule.scope, scopes);
      if (score === undefined) {
        continue;
      }

      if (typeof rule.settings.foreground === "string") {
        const normalized = normalizeHex(rule.settings.foreground);
        if (
          normalized &&
          (score > foregroundScore || (score === foregroundScore && ruleIndex > foregroundIndex))
        ) {
          foreground = normalized;
          foregroundScore = score;
          foregroundIndex = ruleIndex;
        }
      }

      if (rule.settings.fontStyle !== undefined) {
        if (score > fontStyleScore || (score === fontStyleScore && ruleIndex > fontStyleIndex)) {
          const fontStyle = parseFontStyle(rule.settings.fontStyle);
          bold = fontStyle.bold;
          italic = fontStyle.italic;
          underline = fontStyle.underline;
          fontStyleScore = score;
          fontStyleIndex = ruleIndex;
        }
      }
    }

    const ansi = [
      foreground ? ansiFromHex(foreground) : "",
      bold ? ANSI.bold : "",
      italic ? ANSI.italic : "",
      underline ? ANSI.underline : "",
    ].join("");

    this.strictScopeCache.set(key, ansi);
    return ansi;
  }

  resolveSemanticTokenToAnsi(tokenType: string, modifiers: readonly string[]): string {
    const key = `${tokenType}|${modifiers.slice().sort().join(",")}`;
    const cached = this.semanticCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const theme = this.ensureLoaded();
    const semanticRule = selectSemanticRule(theme.semanticRules, tokenType, modifiers);
    if (semanticRule) {
      const foreground = normalizeHex(semanticRule.foreground);
      const fontStyle = parseFontStyle(semanticRule.fontStyle ?? "");
      const ansi = [
        foreground ? ansiFromHex(foreground) : "",
        fontStyle.bold ? ANSI.bold : "",
        fontStyle.italic ? ANSI.italic : "",
        fontStyle.underline ? ANSI.underline : "",
      ].join("");

      if (ansi) {
        this.semanticCache.set(key, ansi);
        return ansi;
      }
    }

    const ansi = resolveSemanticScopeAnsi(
      theme.semanticScopeRules,
      tokenType,
      modifiers,
      (scopes) => this.resolveScopedRuleToAnsi(scopes)
    );
    this.semanticCache.set(key, ansi);
    return ansi;
  }

  private ensureLoaded(): LoadedTheme {
    const themeKey =
      vscode.workspace.getConfiguration("workbench").get<string>("colorTheme")?.trim() ?? "";
    if (this.current?.key === themeKey) {
      return this.current;
    }

    const loaded = loadTheme(themeKey);
    this.strictScopeCache.clear();
    this.semanticCache.clear();
    this.current = {
      key: themeKey,
      rules: loaded.rules,
      semanticRules: loaded.semanticRules,
      semanticScopeRules: loadSemanticScopeRules("r"),
      bracketPairAnsi: loaded.bracketColors.map((color) => ansiFromHex(color)),
      defaultForegroundAnsi: resolveDefaultForegroundAnsi(loaded.rules, loaded.colors),
    };
    return this.current;
  }
}

function loadTheme(themeName: string): {
  rules: TokenRule[];
  semanticRules: Map<string, SemanticTokenRule>;
  bracketColors: string[];
  colors: Record<string, string>;
} {
  const themePath = resolveThemePath(themeName);
  const theme = themePath
    ? readTheme(themePath)
    : {
        rules: [],
        semanticRules: new Map<string, SemanticTokenRule>(),
        colors: {},
      };

  return {
    rules: theme.rules,
    semanticRules: theme.semanticRules,
    bracketColors: buildBracketColors(theme.colors),
    colors: theme.colors,
  };
}

function buildBracketColors(themeColors: Record<string, string>): string[] {
  return [0, 1, 2, 3, 4, 5]
    .map((index) => {
      const configured = normalizeHex(themeColors[`editorBracketHighlight.foreground${index + 1}`]);
      if (configured) {
        return configured;
      }
      return defaultBracketColor(index);
    })
    .filter((color): color is string => color !== undefined);
}

function resolveDefaultForegroundAnsi(
  rules: readonly TokenRule[],
  colors: Record<string, string>
): string {
  let foreground = normalizeHex(colors["editor.foreground"]);

  for (const rule of rules) {
    if (rule.scope !== undefined) {
      continue;
    }

    const normalized = normalizeHex(rule.settings.foreground);
    if (normalized) {
      foreground = normalized;
    }
  }

  return foreground ? ansiFromHex(foreground) : "";
}

function defaultBracketColor(index: number): string | undefined {
  const defaults = getDefaultBracketPalette();
  return defaults[index];
}

function getDefaultBracketPalette(): readonly string[] {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return DEFAULT_BRACKET_COLORS.light;
    case vscode.ColorThemeKind.HighContrast:
      return DEFAULT_BRACKET_COLORS.highContrastDark;
    case vscode.ColorThemeKind.HighContrastLight:
      return DEFAULT_BRACKET_COLORS.highContrastLight;
    case vscode.ColorThemeKind.Dark:
    default:
      return DEFAULT_BRACKET_COLORS.dark;
  }
}

function loadSemanticScopeRules(languageId: string): Map<string, readonly (readonly string[])[]> {
  const rules = new Map(BUILTIN_SEMANTIC_SCOPE_RULES);

  for (const extension of vscode.extensions.all) {
    const contributions = extension.packageJSON?.contributes?.semanticTokenScopes;
    if (!Array.isArray(contributions)) {
      continue;
    }

    for (const contribution of contributions as Array<{
      language?: string;
      scopes?: Record<string, string | string[]>;
    }>) {
      if (contribution.language !== languageId || !contribution.scopes) {
        continue;
      }

      for (const [selector, scopes] of Object.entries(contribution.scopes)) {
        const normalizedScopes = normalizeSemanticScopes(scopes);
        if (normalizedScopes.length > 0) {
          rules.set(selector, normalizedScopes);
        }
      }
    }
  }

  return rules;
}

function normalizeSemanticScopes(scopes: string | string[]): readonly (readonly string[])[] {
  const values = Array.isArray(scopes) ? scopes : [scopes];
  return values
    .map((value) =>
      value
        .split(/\s+/)
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0)
    )
    .filter((scopeChain) => scopeChain.length > 0);
}

function resolveSemanticScopeAnsi(
  semanticScopeRules: Map<string, readonly (readonly string[])[]>,
  tokenType: string,
  modifiers: readonly string[],
  resolveScopes: (scopes: readonly string[]) => string
): string {
  for (const selector of buildSemanticSelectorOrder(tokenType, [...modifiers].sort())) {
    const scopeChains = semanticScopeRules.get(selector);
    if (!scopeChains) {
      continue;
    }

    for (const scopes of scopeChains) {
      const ansi = resolveScopes(scopes);
      if (ansi) {
        return ansi;
      }
    }
  }

  return "";
}

function resolveThemePath(themeName: string): string | undefined {
  if (!themeName) {
    return undefined;
  }

  for (const extension of vscode.extensions.all) {
    const themes = extension.packageJSON?.contributes?.themes;
    if (!Array.isArray(themes)) {
      continue;
    }

    for (const theme of themes as ThemeContribution[]) {
      if (typeof theme.path !== "string") {
        continue;
      }

      const label = resolveThemeLabel(theme, extension.extensionPath);
      if (theme.id !== themeName && label !== themeName) {
        continue;
      }

      return path.join(extension.extensionPath, theme.path);
    }
  }

  for (const root of getExtensionRoots()) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const extensionPath = path.join(root, entry);
      const themePath = findThemePath(themeName, extensionPath);
      if (themePath) {
        return themePath;
      }
    }
  }

  return undefined;
}

function resolveThemeLabel(theme: ThemeContribution, extensionPath: string): string | undefined {
  if (!theme.label) {
    return theme.id;
  }

  if (!theme.label.startsWith("%") || !theme.label.endsWith("%")) {
    return theme.label;
  }

  const key = theme.label.slice(1, -1);
  const bundle = loadNlsBundle(extensionPath);
  return bundle[key] ?? theme.id;
}

function loadNlsBundle(extensionPath: string): Record<string, string> {
  const cached = extensionNlsCache.get(extensionPath);
  if (cached) {
    return cached;
  }

  const language = vscode.env.language.toLowerCase();
  const candidates = [
    path.join(extensionPath, `package.nls.${language}.json`),
    path.join(extensionPath, `package.nls.${language.split("-")[0]}.json`),
    path.join(extensionPath, "package.nls.json"),
  ];

  for (const candidate of candidates) {
    try {
      const bundle = JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, string>;
      extensionNlsCache.set(extensionPath, bundle);
      return bundle;
    } catch {
    }
  }

  extensionNlsCache.set(extensionPath, {});
  return {};
}

function findThemePath(themeName: string, extensionPath: string): string | undefined {
  const packageJsonPath = path.join(extensionPath, "package.json");
  let packageJson: { contributes?: { themes?: ThemeContribution[] } } | undefined;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return undefined;
  }

  const themes = packageJson?.contributes?.themes;
  if (!Array.isArray(themes)) {
    return undefined;
  }

  for (const theme of themes) {
    if (typeof theme.path !== "string") {
      continue;
    }

    const label = resolveThemeLabel(theme, extensionPath);
    if (theme.id !== themeName && label !== themeName) {
      continue;
    }

    return path.join(extensionPath, theme.path);
  }

  return undefined;
}

function getExtensionRoots(): string[] {
  return [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".positron", "extensions"),
    path.resolve(path.dirname(process.execPath), "..", "Resources", "app", "extensions"),
    path.resolve(path.dirname(process.execPath), "..", "..", "Resources", "app", "extensions"),
  ];
}

function readTheme(
  themePath: string,
  seen: Set<string> = new Set()
): {
  rules: TokenRule[];
  semanticRules: Map<string, SemanticTokenRule>;
  colors: Record<string, string>;
} {
  const normalizedPath = path.normalize(themePath);
  if (seen.has(normalizedPath)) {
    return { rules: [], semanticRules: new Map<string, SemanticTokenRule>(), colors: {} };
  }
  seen.add(normalizedPath);

  const document = readThemeDocument(normalizedPath);
  if (!document) {
    return { rules: [], semanticRules: new Map<string, SemanticTokenRule>(), colors: {} };
  }

  const rules: TokenRule[] = [];
  const semanticRules = new Map<string, SemanticTokenRule>();
  let colors: Record<string, string> = {};

  if (typeof document.include === "string" && document.include.trim().length > 0) {
    const included = readTheme(path.resolve(path.dirname(normalizedPath), document.include), seen);
    rules.push(...included.rules);
    for (const [key, value] of included.semanticRules) {
      semanticRules.set(key, value);
    }
    colors = { ...included.colors };
  }

  if (Array.isArray(document.settings)) {
    rules.push(...document.settings);
  }

  if (Array.isArray(document.tokenColors)) {
    rules.push(...document.tokenColors);
  } else if (typeof document.tokenColors === "string") {
    const includedColors = readTheme(
      path.resolve(path.dirname(normalizedPath), document.tokenColors),
      seen
    );
    rules.push(...includedColors.rules);
    for (const [key, value] of includedColors.semanticRules) {
      semanticRules.set(key, value);
    }
  }

  if (document.semanticTokenColors) {
    for (const [selector, value] of Object.entries(document.semanticTokenColors)) {
      semanticRules.set(selector, normalizeSemanticRule(value));
    }
  }

  if (document.colors) {
    colors = { ...colors, ...document.colors };
  }

  return {
    rules,
    semanticRules,
    colors,
  };
}

function normalizeSemanticRule(value: string | SemanticTokenRule): SemanticTokenRule {
  if (typeof value === "string") {
    return { foreground: value };
  }
  return value;
}

function selectSemanticRule(
  semanticRules: Map<string, SemanticTokenRule>,
  tokenType: string,
  modifiers: readonly string[]
): SemanticTokenRule | undefined {
  const orderedModifiers = [...modifiers].sort();
  const exactKeys = buildSemanticSelectorOrder(tokenType, orderedModifiers);
  for (const key of exactKeys) {
    const rule = semanticRules.get(key);
    if (rule) {
      return rule;
    }
  }

  for (const modifier of orderedModifiers) {
    const wildcardRule = semanticRules.get(`*.${modifier}`);
    if (wildcardRule) {
      return wildcardRule;
    }
  }

  return undefined;
}

function buildSemanticSelectorOrder(tokenType: string, modifiers: string[]): string[] {
  const selectors = new Set<string>();
  for (let size = modifiers.length; size >= 1; size -= 1) {
    appendModifierCombinations(selectors, tokenType, modifiers, size, 0, []);
  }
  selectors.add(tokenType);

  return [...selectors];
}

function appendModifierCombinations(
  selectors: Set<string>,
  tokenType: string,
  modifiers: string[],
  size: number,
  start: number,
  current: string[]
): void {
  if (current.length === size) {
    selectors.add(`${tokenType}.${current.join(".")}`);
    return;
  }

  for (let index = start; index <= modifiers.length - (size - current.length); index += 1) {
    current.push(modifiers[index]);
    appendModifierCombinations(selectors, tokenType, modifiers, size, index + 1, current);
    current.pop();
  }
}

function readThemeDocument(themePath: string): ThemeDocument | undefined {
  if (!themePath.endsWith(".json")) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(themePath, "utf8");
    return JSON.parse(stripTrailingCommas(stripJsonComments(raw))) as ThemeDocument;
  } catch {
    return undefined;
  }
}

function normalizeScopes(scope?: string | string[]): string[] {
  const values = Array.isArray(scope) ? scope : typeof scope === "string" ? [scope] : [];
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function scoreRule(scope: string | string[] | undefined, scopes: readonly string[]): number | undefined {
  const selectors = normalizeScopes(scope);
  if (selectors.length === 0) {
    return 0;
  }

  let bestScore: number | undefined;
  for (const selector of selectors) {
    const score = scoreSelector(selector, scopes);
    if (score === undefined || (bestScore !== undefined && score <= bestScore)) {
      continue;
    }
    bestScore = score;
  }

  return bestScore;
}

function scoreSelector(selector: string, scopes: readonly string[]): number | undefined {
  const segments = selector.split(/\s+/).filter((value) => value.length > 0);
  if (segments.length === 0) {
    return undefined;
  }

  let scopeIndex = scopes.length - 1;
  let score = 0;

  for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
    const segment = segments[segmentIndex];
    const matchedIndex = findMatchingScopeIndex(scopes, scopeIndex, segment);
    if (matchedIndex < 0) {
      return undefined;
    }

    score += selectorSpecificity(segment) * 100 + (scopes.length - matchedIndex);
    scopeIndex = matchedIndex - 1;
  }

  return score * 10 + segments.length;
}

function findMatchingScopeIndex(
  scopes: readonly string[],
  startIndex: number,
  selector: string
): number {
  for (let index = startIndex; index >= 0; index -= 1) {
    if (scopeMatchesSelector(scopes[index], selector)) {
      return index;
    }
  }

  return -1;
}

function scopeMatchesSelector(scope: string, selector: string): boolean {
  return scope === selector || scope.startsWith(`${selector}.`);
}

function selectorSpecificity(selector: string): number {
  return selector.split(".").length;
}

function parseFontStyle(fontStyle: string): { bold: boolean; italic: boolean; underline: boolean } {
  const tokens = fontStyle.split(/\s+/).filter((token) => token.length > 0);
  return {
    bold: tokens.includes("bold"),
    italic: tokens.includes("italic"),
    underline: tokens.includes("underline"),
  };
}

function normalizeHex(color: string | undefined): string | undefined {
  if (!color) {
    return undefined;
  }

  const match = color.trim().match(/^#([0-9a-f]{6}|[0-9a-f]{8}|[0-9a-f]{3}|[0-9a-f]{4})$/i);
  if (!match) {
    return undefined;
  }

  const digits = match[1];
  if (digits.length === 3 || digits.length === 4) {
    if (digits.length === 4 && digits[3] === "0") {
      return undefined;
    }
    return `#${digits
      .slice(0, 3)
      .split("")
      .map((digit) => digit + digit)
      .join("")}`;
  }

  if (digits.length === 8 && digits.slice(6, 8) === "00") {
    return undefined;
  }

  return `#${digits.slice(0, 6)}`;
}

function ansiFromHex(color: string): string {
  const digits = color.slice(1);
  const red = Number.parseInt(digits.slice(0, 2), 16);
  const green = Number.parseInt(digits.slice(2, 4), 16);
  const blue = Number.parseInt(digits.slice(4, 6), 16);
  return `\x1b[38;2;${red};${green};${blue}m`;
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      if (index < text.length) {
        result += "\n";
      }
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") {
          result += "\n";
        }
        index += 1;
      }
      index += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function stripTrailingCommas(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      result += char;
      continue;
    }

    if (char === ",") {
      let cursor = index + 1;
      while (cursor < text.length && /\s/.test(text[cursor])) {
        cursor += 1;
      }
      if (text[cursor] === "}" || text[cursor] === "]") {
        continue;
      }
    }

    result += char;
  }

  return result;
}
