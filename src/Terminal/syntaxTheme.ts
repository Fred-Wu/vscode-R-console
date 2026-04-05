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
  defaultTextAnsi: string;
};

const FALLBACK_TEXT_ANSI = "\x1b[37m";

const extensionNlsCache = new Map<string, Record<string, string>>();

export class SyntaxTheme {
  private current: LoadedTheme | undefined;
  private scopeCache = new Map<string, string>();
  private semanticCache = new Map<string, string>();

  invalidate(): void {
    this.current = undefined;
    this.scopeCache.clear();
    this.semanticCache.clear();
  }

  getDefaultAnsi(): string {
    return this.ensureLoaded().defaultTextAnsi;
  }

  resolveScopesToAnsi(scopes: readonly string[]): string {
    const key = scopes.join("|");
    const cached = this.scopeCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const { rules } = this.ensureLoaded();
    let foreground: string | undefined;
    let bold = false;
    let italic = false;
    let underline = false;

    for (const rule of rules) {
      const selectors = normalizeScopes(rule.scope);
      if (
        selectors.length > 0 &&
        !selectors.some((selector) => scopes.some((scope) => scopeMatches(selector, scope)))
      ) {
        continue;
      }

      if (typeof rule.settings.foreground === "string") {
        foreground = normalizeHex(rule.settings.foreground) ?? foreground;
      }

      if (rule.settings.fontStyle !== undefined) {
        const fontStyle = parseFontStyle(rule.settings.fontStyle);
        bold = fontStyle.bold;
        italic = fontStyle.italic;
        underline = fontStyle.underline;
      }
    }

    const ansi = [
      foreground ? ansiFromHex(foreground) : "",
      bold ? ANSI.bold : "",
      italic ? ANSI.italic : "",
      underline ? ANSI.underline : "",
    ].join("");

    this.scopeCache.set(key, ansi);
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
    if (!semanticRule) {
      this.semanticCache.set(key, "");
      return "";
    }

    const foreground = normalizeHex(semanticRule.foreground);
    const fontStyle = parseFontStyle(semanticRule.fontStyle ?? "");
    const ansi = [
      foreground ? ansiFromHex(foreground) : "",
      fontStyle.bold ? ANSI.bold : "",
      fontStyle.italic ? ANSI.italic : "",
      fontStyle.underline ? ANSI.underline : "",
    ].join("");

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
    this.scopeCache.clear();
    this.semanticCache.clear();
    this.current = {
      key: themeKey,
      rules: loaded.rules,
      semanticRules: loaded.semanticRules,
      defaultTextAnsi: loaded.defaultForeground
        ? ansiFromHex(loaded.defaultForeground)
        : FALLBACK_TEXT_ANSI,
    };
    return this.current;
  }
}

function loadTheme(themeName: string): {
  rules: TokenRule[];
  semanticRules: Map<string, SemanticTokenRule>;
  defaultForeground?: string;
} {
  const themePath = resolveThemePath(themeName);
  const theme = themePath
    ? readTheme(themePath)
    : { rules: [], semanticRules: new Map<string, SemanticTokenRule>(), defaultForeground: undefined };
  const normalizedDefault = normalizeHex(theme.defaultForeground);
  const hasDefaultRule = theme.rules.some(
    (rule) =>
      rule.scope === undefined &&
      typeof rule.settings.foreground === "string" &&
      normalizeHex(rule.settings.foreground) !== undefined
  );

  return {
    rules:
      normalizedDefault && !hasDefaultRule
        ? [{ settings: { foreground: normalizedDefault } }, ...theme.rules]
        : theme.rules,
    semanticRules: theme.semanticRules,
    defaultForeground: normalizedDefault,
  };
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
  defaultForeground?: string;
} {
  const normalizedPath = path.normalize(themePath);
  if (seen.has(normalizedPath)) {
    return { rules: [], semanticRules: new Map<string, SemanticTokenRule>() };
  }
  seen.add(normalizedPath);

  const document = readThemeDocument(normalizedPath);
  if (!document) {
    return { rules: [], semanticRules: new Map<string, SemanticTokenRule>() };
  }

  const rules: TokenRule[] = [];
  const semanticRules = new Map<string, SemanticTokenRule>();
  let defaultForeground: string | undefined;

  if (typeof document.include === "string" && document.include.trim().length > 0) {
    const included = readTheme(path.resolve(path.dirname(normalizedPath), document.include), seen);
    rules.push(...included.rules);
    for (const [key, value] of included.semanticRules) {
      semanticRules.set(key, value);
    }
    defaultForeground = included.defaultForeground;
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
    defaultForeground = includedColors.defaultForeground ?? defaultForeground;
  }

  if (document.semanticTokenColors) {
    for (const [selector, value] of Object.entries(document.semanticTokenColors)) {
      semanticRules.set(selector, normalizeSemanticRule(value));
    }
  }

  const scopedDefault = rules.reduce<string | undefined>((current, rule) => {
    if (rule.scope !== undefined) {
      return current;
    }
    return normalizeHex(rule.settings.foreground) ?? current;
  }, defaultForeground);

  const colorDefault =
    normalizeHex(document.colors?.["editor.foreground"]) ??
    normalizeHex(document.colors?.["terminal.foreground"]);

  return {
    rules,
    semanticRules,
    defaultForeground: colorDefault ?? scopedDefault,
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
  selectors.add(tokenType);

  for (let size = modifiers.length; size >= 1; size -= 1) {
    appendModifierCombinations(selectors, tokenType, modifiers, size, 0, []);
  }

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

function scopeMatches(selector: string, scope: string): boolean {
  return scope === selector || scope.startsWith(`${selector}.`) || selector.startsWith(`${scope}.`);
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
    return `#${digits
      .slice(0, 3)
      .split("")
      .map((digit) => digit + digit)
      .join("")}`;
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
