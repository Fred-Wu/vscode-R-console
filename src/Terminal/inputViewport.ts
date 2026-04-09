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

function getRenderedRowCountForLine(
  line: string,
  lineIndex: number,
  columns: number,
  promptLen: number,
  continuationPromptLen: number
): number {
  const safeColumns = Math.max(1, columns || 80);
  const visiblePromptLen = getPromptLengthForLine(
    lineIndex,
    promptLen,
    continuationPromptLen
  );
  const visibleLen = visiblePromptLen + line.length;
  return Math.max(1, Math.ceil(visibleLen / safeColumns));
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
  continuationPromptLen: number
): number {
  return lines.reduce((sum, line, idx) => {
    return (
      sum +
      getRenderedRowCountForLine(
        line,
        idx,
        columns,
        promptLen,
        continuationPromptLen
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
  focusCol?: number
): { text: string; cursorCol: number } {
  const safeColumns = Math.max(20, columns || 80);
  const maxLen = Math.max(1, safeColumns - Math.max(0, promptLen));
  const clampedFocusCol =
    focusCol === undefined
      ? undefined
      : Math.max(0, Math.min(focusCol, line.length));

  if (line.length <= maxLen) {
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

  if (clampedFocusCol === undefined) {
    return {
      text: `${line.slice(0, maxLen - 3)}...`,
      cursorCol: maxLen,
    };
  }

  const ellipsis = "...";
  const singleSidedBudget = maxLen - ellipsis.length;

  if (clampedFocusCol <= singleSidedBudget) {
    return {
      text: `${line.slice(0, singleSidedBudget)}${ellipsis}`,
      cursorCol: clampedFocusCol,
    };
  }

  const tailStart = Math.max(0, line.length - singleSidedBudget);
  if (clampedFocusCol >= tailStart) {
    return {
      text: `${ellipsis}${line.slice(tailStart)}`,
      cursorCol: ellipsis.length + (clampedFocusCol - tailStart),
    };
  }

  const middleBudget = Math.max(1, maxLen - ellipsis.length * 2);
  const desiredStart = clampedFocusCol - Math.floor(middleBudget / 2);
  const start = Math.max(0, Math.min(desiredStart, line.length - middleBudget));
  const end = start + middleBudget;
  return {
    text: `${ellipsis}${line.slice(start, end)}${ellipsis}`,
    cursorCol: ellipsis.length + (clampedFocusCol - start),
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
  focusCol?: number
): { text: string; cursorCol: number } {
  return clipViewportLine(
    line,
    columns,
    getPromptLengthForDisplayLine(promptKind, promptLen, continuationPromptLen),
    focusCol
  );
}

export function buildWindowedRenderPlan(
  allLines: string[],
  cursorRow: number,
  cursorCol: number,
  visibleRowBudget: number,
  columns: number,
  promptLen: number,
  continuationPromptLen: number
): WindowedRenderPlan {
  if (visibleRowBudget === 1) {
    const promptKinds: Array<"main" | "cont"> = [cursorRow === 0 ? "main" : "cont"];
    const onlyLine = clipDisplayLine(
      allLines[cursorRow] ?? "",
      columns,
      promptKinds[0],
      promptLen,
      continuationPromptLen,
      cursorCol
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
      idx === adjustedCursorRow ? cursorCol : undefined
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
  continuationPromptLen: number
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
      (allLines[sourceLineIndex] ?? "").length
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
      idx === visibleLines.length - 1 ? line.length : undefined
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
