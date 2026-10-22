type WindowedRenderPlan = {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  sourceLineMap: Array<number | undefined>;
  promptKinds: Array<"main" | "cont">;
};

type CollapsedRenderPlan = {
  multiline: string[];
  inputLine: string;
  inputLineCursorCol: number;
  sourceLineMap: Array<number | undefined>;
  promptKinds: Array<"main" | "cont">;
};

export type DisplayRenderPlan = {
  lines: string[];
  sourceLineMap: Array<number | undefined>;
  promptKinds: Array<"main" | "cont">;
};

export type InputRenderMetrics = {
  columns: number;
  promptLen: number;
  continuationPromptLen: number;
};

type WrappedCursorMove = {
  row: number;
  col: number;
  moved: boolean;
  preferredColumn: number;
};

function getPromptLengthForLine(
  lineIndex: number,
  promptLen: number,
  continuationPromptLen: number
): number {
  return lineIndex === 0 ? promptLen : continuationPromptLen;
}

export function getWrappedLineLayout(
  line: string,
  columns: number,
  promptLen: number,
  widthOf: (text: string) => number,
  cursorCol = line.length
): { rows: number; endColumn: number; cursorRow: number; cursorColumn: number; splitIndex: number } {
  const width = Math.max(1, columns);
  let row = Math.max(0, Math.ceil(promptLen / width) - 1);
  let col = promptLen - row * width;
  let index = 0;
  let cursorRow = -1;
  let cursorColumn = 1;
  let splitIndex = line.length;
  for (const char of line) {
    const size = widthOf(char);
    // A wide character leaves the final cell empty if it cannot fit there.
    if (size > 0 && col + size > width) {
      row++;
      col = 0;
    }
    if (cursorRow < 0 && index >= cursorCol) {
      cursorRow = row;
      cursorColumn = Math.min(width, col + 1);
    }
    if (cursorRow >= 0 && row > cursorRow && splitIndex === line.length) {
      splitIndex = index;
    }
    col += size;
    index += char.length;
  }
  return {
    rows: row + 1,
    endColumn: col,
    cursorRow: cursorRow < 0 ? row : cursorRow,
    cursorColumn: cursorRow < 0 ? Math.min(width, col + 1) : cursorColumn,
    splitIndex,
  };
}

function getRenderedRowCountForLine(
  line: string,
  lineIndex: number,
  columns: number,
  promptLen: number,
  continuationPromptLen: number,
  widthOf: (text: string) => number = text => text.length
): number {
  const safeColumns = Math.max(1, columns || 80);
  const visiblePromptLen = getPromptLengthForLine(
    lineIndex,
    promptLen,
    continuationPromptLen
  );
  return getWrappedLineLayout(line, safeColumns, visiblePromptLen, widthOf).rows;
}

export function getContinuationPromptLength(
  continuationPromptText: string | null
): number {
  const continuationPad = 2;
  return continuationPromptText
    ? continuationPromptText.length
    : continuationPad;
}

export function getRenderedRowCount(
  lines: string[],
  columns: number,
  promptLen: number,
  continuationPromptLen: number,
  widthOf: (text: string) => number = text => text.length
): number {
  return lines.reduce((sum, line, idx) => {
    return (
      sum +
      getRenderedRowCountForLine(
        line,
        idx,
        columns,
        promptLen,
        continuationPromptLen,
        widthOf
      )
    );
  }, 0);
}

export function moveCursorByRenderedRows(
  lines: string[],
  cursorRow: number,
  cursorCol: number,
  deltaRows: number,
  {
    columns,
    promptLen,
    continuationPromptLen,
  }: InputRenderMetrics,
  preferredColumn?: number
): WrappedCursorMove {
  const safeColumns = Math.max(1, columns || 80);
  const rowCounts = lines.map((line, lineIndex) =>
    getRenderedRowCountForLine(
      line,
      lineIndex,
      safeColumns,
      promptLen,
      continuationPromptLen
    )
  );
  const currentLine = lines[cursorRow] ?? "";
  const clampedCursorCol = Math.max(0, Math.min(cursorCol, currentLine.length));
  const currentPromptLen = getPromptLengthForLine(
    cursorRow,
    promptLen,
    continuationPromptLen
  );
  const currentOffset = currentPromptLen + clampedCursorCol;
  const currentRowWithinLine =
    currentOffset > 0 ? Math.floor(currentOffset / safeColumns) : 0;
  const currentVisualColumn = preferredColumn ?? (currentOffset % safeColumns);
  let currentVisualRow = currentRowWithinLine;
  for (let lineIndex = 0; lineIndex < cursorRow; lineIndex += 1) {
    currentVisualRow += rowCounts[lineIndex] ?? 0;
  }

  const totalRows = rowCounts.reduce((sum, count) => sum + count, 0);
  const targetVisualRow = currentVisualRow + deltaRows;
  if (targetVisualRow < 0 || targetVisualRow >= totalRows) {
    return {
      row: cursorRow,
      col: clampedCursorCol,
      moved: false,
      preferredColumn: currentVisualColumn,
    };
  }

  let targetRow = 0;
  let rowStart = 0;
  while (targetRow < rowCounts.length) {
    const rowCount = rowCounts[targetRow] ?? 0;
    if (targetVisualRow < rowStart + rowCount) {
      break;
    }
    rowStart += rowCount;
    targetRow += 1;
  }

  const targetLine = lines[targetRow] ?? "";
  const targetRowWithinLine = targetVisualRow - rowStart;
  const targetPromptLen = getPromptLengthForLine(
    targetRow,
    promptLen,
    continuationPromptLen
  );
  const targetOffset = targetRowWithinLine * safeColumns + currentVisualColumn;
  const targetCol = Math.max(
    0,
    Math.min(targetLine.length, targetOffset - targetPromptLen)
  );

  return {
    row: targetRow,
    col: targetCol,
    moved: true,
    preferredColumn: currentVisualColumn,
  };
}

export function shouldRenderCollapsed(
  historyBrowsing: boolean,
  historyCollapsed: boolean,
  isAtEnd: boolean,
  totalLines: number,
  maxRows: number
): boolean {
  if (historyBrowsing && historyCollapsed) {
    return true;
  }

  return isAtEnd && totalLines > maxRows;
}

function getPromptKindForDisplayLine(
  sourceLineIndex: number | undefined
): "main" | "cont" {
  return sourceLineIndex === 0 ? "main" : "cont";
}

function clipViewportLine(
  line: string,
  columns: number,
  promptLen: number,
  focusCol?: number,
  widthOf: (text: string) => number = text => text.length
): { text: string; cursorCol: number } {
  const safeColumns = Math.max(20, columns || 80);
  const maxLen = Math.max(1, safeColumns - Math.max(0, promptLen));
  const clampedFocusCol =
    focusCol === undefined
      ? undefined
      : Math.max(0, Math.min(focusCol, line.length));

  if (widthOf(line) <= maxLen) {
    return {
      text: line,
      cursorCol: clampedFocusCol ?? line.length,
    };
  }
  if (maxLen <= 3) {
    return {
      text: ".".repeat(maxLen),
      cursorCol: clampedFocusCol === undefined ? maxLen : Math.min(maxLen, clampedFocusCol),
    };
  }

  const total = widthOf(line);
  const focus = widthOf(line.slice(0, clampedFocusCol ?? line.length));
  const usable = maxLen - 3;
  const desired = clampedFocusCol === undefined || focus <= usable ? 0 :
    total - focus <= usable ? Math.max(0, total - usable) :
    Math.max(0, focus - Math.floor((maxLen - 6) / 2));
  let start = 0;
  let cells = 0;
  for (const char of line) {
    const size = widthOf(char);
    // Round forward to a character boundary so the reserved tail still fits.
    if (cells >= desired && size > 0) break;
    cells += size;
    start += char.length;
  }
  const prefix = start ? "..." : "";
  const take = (budget: number): { text: string; end: number } => {
    let text = "";
    let used = 0;
    let end = start;
    for (const char of line.slice(start)) {
      const size = widthOf(char);
      if (used + size > budget) break;
      text += char;
      used += size;
      end += char.length;
    }
    return { text, end };
  };
  const preview = take(maxLen - prefix.length);
  const slice = preview.end === line.length ? preview : take(maxLen - prefix.length - 3);
  return {
    text: prefix + slice.text + (slice.end < line.length ? "..." : ""),
    cursorCol: prefix.length + Math.max(0, Math.min((clampedFocusCol ?? slice.end) - start, slice.text.length)),
  };
}

function getPromptLengthForDisplayLine(
  promptKind: "main" | "cont",
  promptLen: number,
  continuationPromptLen: number
): number {
  return promptKind === "main" ? promptLen : continuationPromptLen;
}

function clipDisplayLine(
  line: string,
  columns: number,
  promptKind: "main" | "cont",
  promptLen: number,
  continuationPromptLen: number,
  focusCol?: number,
  widthOf: (text: string) => number = text => text.length
): { text: string; cursorCol: number } {
  return clipViewportLine(
    line,
    columns,
    getPromptLengthForDisplayLine(promptKind, promptLen, continuationPromptLen),
    focusCol,
    widthOf
  );
}

export function buildWindowedRenderPlan(
  allLines: string[],
  cursorRow: number,
  cursorCol: number,
  visibleRowBudget: number,
  columns: number,
  promptLen: number,
  continuationPromptLen: number,
  widthOf: (text: string) => number = text => text.length
): WindowedRenderPlan {
  if (visibleRowBudget === 1) {
    const promptKinds: Array<"main" | "cont"> = [cursorRow === 0 ? "main" : "cont"];
    const onlyLine = clipDisplayLine(
      allLines[cursorRow] ?? "",
      columns,
      promptKinds[0],
      promptLen,
      continuationPromptLen,
      cursorCol,
      widthOf
    );
    return {
      lines: [onlyLine.text],
      cursorRow: 0,
      cursorCol: onlyLine.cursorCol,
      sourceLineMap: [cursorRow],
      promptKinds,
    };
  }

  const totalLines = allLines.length;
  let startLine = Math.max(0, cursorRow - Math.floor(visibleRowBudget / 2));
  let endLine = startLine + visibleRowBudget;

  if (endLine > totalLines) {
    endLine = totalLines;
    startLine = Math.max(0, endLine - visibleRowBudget);
  }

  const rawLines = allLines.slice(startLine, endLine);
  const windowedLines = [...rawLines];
  const sourceLineMap: Array<number | undefined> = rawLines.map((_, index) => startLine + index);
  const adjustedCursorRow = cursorRow - startLine;

  if (startLine > 0) {
    windowedLines[0] = `  ▲▲▲ (${startLine} lines above) ▲▲▲`;
    sourceLineMap[0] = undefined;
  }
  if (endLine < totalLines) {
    windowedLines[windowedLines.length - 1] = `  ▼▼▼ (${totalLines - endLine} lines below) ▼▼▼`;
    sourceLineMap[sourceLineMap.length - 1] = undefined;
  }

  if (startLine > 0 && adjustedCursorRow === 0) {
    windowedLines[0] = rawLines[0] ?? "";
    sourceLineMap[0] = startLine;
  }
  if (endLine < totalLines && adjustedCursorRow === windowedLines.length - 1) {
    windowedLines[windowedLines.length - 1] = rawLines[rawLines.length - 1] ?? "";
    sourceLineMap[sourceLineMap.length - 1] = endLine - 1;
  }

  const promptKinds = sourceLineMap.map((sourceLineIndex) =>
    getPromptKindForDisplayLine(sourceLineIndex)
  );
  const clippedLines = windowedLines.map((line, idx) =>
    clipDisplayLine(
      line,
      columns,
      promptKinds[idx]!,
      promptLen,
      continuationPromptLen,
      idx === adjustedCursorRow ? cursorCol : undefined,
      widthOf
    )
  );
  const cursorLine = clippedLines[adjustedCursorRow];

  return {
    lines: clippedLines.map((line) => line.text),
    cursorRow: adjustedCursorRow,
    cursorCol: cursorLine?.cursorCol ?? 0,
    sourceLineMap,
    promptKinds,
  };
}

export function buildCollapsedRenderPlan(
  allLines: string[],
  visibleRowBudget: number,
  columns: number,
  promptLen: number,
  continuationPromptLen: number,
  widthOf: (text: string) => number = text => text.length
): CollapsedRenderPlan | undefined {
  const totalLines = allLines.length;

  if (visibleRowBudget === 1) {
    const sourceLineIndex = allLines.length - 1;
    const promptKinds: Array<"main" | "cont"> = [
      sourceLineIndex === 0 ? "main" : "cont"
    ];
    const onlyLine = clipDisplayLine(
      allLines[sourceLineIndex] ?? "",
      columns,
      promptKinds[0],
      promptLen,
      continuationPromptLen,
      (allLines[sourceLineIndex] ?? "").length,
      widthOf
    );
    return {
      multiline: [],
      inputLine: onlyLine.text,
      inputLineCursorCol: onlyLine.cursorCol,
      sourceLineMap: [sourceLineIndex],
      promptKinds,
    };
  }

  const budgetExcludingEllipsis = visibleRowBudget - 1;
  let topCount = Math.max(1, Math.ceil(budgetExcludingEllipsis / 2));
  let bottomCount = Math.max(1, budgetExcludingEllipsis - topCount);
  let hiddenCount = totalLines - topCount - bottomCount;

  if (hiddenCount < 1) {
    let deficit = 1 - hiddenCount;
    while (deficit > 0 && topCount > 1) {
      topCount -= 1;
      deficit -= 1;
    }
    while (deficit > 0 && bottomCount > 1) {
      bottomCount -= 1;
      deficit -= 1;
    }
    hiddenCount = totalLines - topCount - bottomCount;
  }

  if (hiddenCount < 1) {
    return undefined;
  }

  const topLines = allLines.slice(0, topCount);
  const bottomLines = bottomCount > 0 ? allLines.slice(-bottomCount) : [];
  const ellipsis = `  ...... (${hiddenCount} more lines collapsed) ......`;
  const sourceLineMap = [
    ...topLines.map((_, index) => index),
    undefined,
    ...bottomLines.map((_, index) => totalLines - bottomCount + index),
  ];
  const promptKinds = sourceLineMap.map((sourceLineIndex) =>
    getPromptKindForDisplayLine(sourceLineIndex)
  );

  const visibleLines = [...topLines, ellipsis, ...bottomLines];
  const clippedVisibleLines = visibleLines.map((line, idx) =>
    clipDisplayLine(
      line,
      columns,
      promptKinds[idx]!,
      promptLen,
      continuationPromptLen,
      idx === visibleLines.length - 1 ? line.length : undefined,
      widthOf
    )
  );

  return {
    multiline: clippedVisibleLines.slice(0, -1).map((line) => line.text),
    inputLine: clippedVisibleLines[clippedVisibleLines.length - 1]?.text ?? "",
    inputLineCursorCol: clippedVisibleLines[clippedVisibleLines.length - 1]?.cursorCol ?? 0,
    sourceLineMap,
    promptKinds,
  };
}

export function buildSubmissionRenderPlan(
  allLines: string[],
  visibleRowBudget: number,
  columns: number,
  promptLen: number,
  continuationPromptLen: number
): DisplayRenderPlan {
  const safeLines = allLines.length > 0 ? allLines : [""];
  const safeBudget = Math.max(1, visibleRowBudget);
  const totalRows = getRenderedRowCount(
    safeLines,
    columns,
    promptLen,
    continuationPromptLen
  );

  if (totalRows <= safeBudget) {
    return {
      lines: [...safeLines],
      sourceLineMap: safeLines.map((_, index) => index),
      promptKinds: safeLines.map((_, index) => (index === 0 ? "main" : "cont")),
    };
  }

  const collapsed = buildCollapsedRenderPlan(
    safeLines,
    safeBudget,
    columns,
    promptLen,
    continuationPromptLen
  );
  if (collapsed) {
    return {
      lines: [...collapsed.multiline, collapsed.inputLine],
      sourceLineMap: collapsed.sourceLineMap,
      promptKinds: collapsed.promptKinds,
    };
  }

  const windowed = buildWindowedRenderPlan(
    safeLines,
    0,
    (safeLines[0] ?? "").length,
    safeBudget,
    columns,
    promptLen,
    continuationPromptLen
  );
  return {
    lines: windowed.lines,
    sourceLineMap: windowed.sourceLineMap,
    promptKinds: windowed.promptKinds,
  };
}
