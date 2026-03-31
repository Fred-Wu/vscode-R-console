export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  brightGreen: "\x1b[92m",
  brightBlue: "\x1b[94m",
};

export function stripBracketedPasteMarkers(text: string): string {
  return text.replace(/\x1b\[200~|\x1b\[201~/g, "");
}
