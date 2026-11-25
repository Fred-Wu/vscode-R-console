const R_SYNTACTIC_NAME_PATTERN = /^(?:[a-zA-Z]|\.(?![0-9]))[a-zA-Z0-9._]*$/;
export const R_RESERVED_WORDS = new Set([
  "if",
  "else",
  "repeat",
  "while",
  "function",
  "for",
  "in",
  "next",
  "break",
  "TRUE",
  "FALSE",
  "NULL",
  "Inf",
  "NaN",
  "NA",
  "NA_integer_",
  "NA_real_",
  "NA_complex_",
  "NA_character_",
]);

// R backticked names accept byte escapes but reject Unicode escapes.
export function escapeRControls(text: string): string {
  return text.replace(/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu, char => {
    if (char === "\r") return "\\r";
    if (char === "\n") return "\\n";
    if (char === "\t") return "\\t";
    return Array.from(Buffer.from(char, "utf8"), byte =>
      "\\x" + byte.toString(16).padStart(2, "0")).join("");
  });
}

function escapeRLiteral(value: string, quote: string): string {
  return escapeRControls(value.replaceAll("\\", "\\\\").replaceAll(quote, "\\" + quote));
}

export function backtickRName(name: string): string {
  return "`" + escapeRLiteral(name, "`") + "`";
}

export function quoteRNameIfNeeded(name: string): string {
  if (R_SYNTACTIC_NAME_PATTERN.test(name) && !R_RESERVED_WORDS.has(name)) {
    return name;
  }
  return backtickRName(name);
}

export function quoteCompletionValue(value: string, existingQuote?: "\"" | "'"): string {
  const quote = existingQuote ?? '"';
  const escaped = escapeRLiteral(value, quote);
  return existingQuote ? escaped : quote + escaped + quote;
}
