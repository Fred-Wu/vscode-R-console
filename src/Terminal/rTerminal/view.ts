import { ANSI } from "../ansi";
import { ConsoleSyntax } from "../consoleSyntax";
import { InputState } from "../inputState";
import {
  buildCollapsedRenderPlan,
  buildWindowedRenderPlan,
  getContinuationPromptLength,
  getRenderedRowCount,
  shouldRenderCollapsed,
} from "../inputViewport";
import { Renderer } from "../renderer";

type Dimensions = {
  columns: number;
  rows: number;
};

type RenderInputOptions = {
  syntax: ConsoleSyntax;
  renderer: Renderer;
  inputState: InputState;
  dimensions: Dimensions;
  historyBrowsing: boolean;
  historyCollapsed: boolean;
};

export function configureMainPrompt(renderer: Renderer): void {
  const promptText = "R> ";
  renderer.setPrompt(promptText, ANSI.brightGreen);
  renderer.setContinuationPrompt(" ".repeat(promptText.length), ANSI.reset);
}

export function clearInputRender(
  write: (text: string) => void,
  renderer: Renderer
): void {
  const lines = renderer.renderedLineCount;
  if (lines <= 0) {
    return;
  }

  write("\r");
  if (renderer.cursorRowFromTop > 0) {
    write(`\x1b[${renderer.cursorRowFromTop}A`);
  }
  for (let index = 0; index < lines; index += 1) {
    write("\x1b[2K");
    if (index < lines - 1) {
      write("\x1b[1B\r");
    }
  }
  if (lines > 1) {
    write(`\x1b[${lines - 1}A\r`);
  } else {
    write("\r");
  }

  renderer.renderedLineCount = 1;
  renderer.cursorRowFromTop = 0;
}

export function renderInput({
  syntax,
  renderer,
  inputState,
  dimensions,
  historyBrowsing,
  historyCollapsed,
}: RenderInputOptions): void {
  syntax.setSource(inputState.lines);

  const lines = inputState.lines;
  const totalLines = lines.length;
  const maxRows = Math.max(1, dimensions.rows - 1);
  const continuationPromptLen = getContinuationPromptLength(
    renderer.continuationPromptText
  );
  const totalRows = getRenderedRowCount(
    lines,
    dimensions.columns,
    renderer.promptLen,
    continuationPromptLen
  );

  if (
    totalRows > maxRows &&
    shouldRenderCollapsed(
      historyBrowsing,
      historyCollapsed,
      inputState.isAtEnd,
      totalLines,
      maxRows
    )
  ) {
    renderCollapsed({ renderer, inputState, dimensions });
  } else if (totalRows > maxRows) {
    renderWindowed({ renderer, inputState, dimensions });
  } else {
    renderer.renderWithCursor(
      lines,
      inputState.cursorRow,
      inputState.cursorCol,
      dimensions.columns,
      lines.map((_, index) => index),
      lines.map((_, index) => index === 0 ? "main" : "cont")
    );
  }
}

export function formatTerminalOutput(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
}

export function getPromptRenderDelay(
  pendingInitialPromptGap: boolean,
  lastOutputAt: number
): number {
  const baseDelay =
    process.platform !== "win32" ? 0 : pendingInitialPromptGap ? 48 : 16;
  return getOutputQuietDelay(baseDelay, lastOutputAt);
}

export function getReplyPromptRenderDelay(lastOutputAt: number): number {
  const baseDelay = process.platform !== "win32" ? 0 : 80;
  return getOutputQuietDelay(baseDelay, lastOutputAt);
}

function renderWindowed({
  renderer,
  inputState,
  dimensions,
}: Omit<RenderInputOptions, "syntax" | "historyBrowsing" | "historyCollapsed">): void {
  const continuationPromptLen = getContinuationPromptLength(
    renderer.continuationPromptText
  );
  const plan = buildWindowedRenderPlan(
    inputState.lines,
    inputState.cursorRow,
    inputState.cursorCol,
    Math.max(1, dimensions.rows - 1),
    dimensions.columns,
    renderer.promptLen,
    continuationPromptLen
  );

  renderer.renderWithCursor(
    plan.lines,
    plan.cursorRow,
    plan.cursorCol,
    dimensions.columns,
    plan.sourceLineMap,
    plan.promptKinds
  );
}

function renderCollapsed({
  renderer,
  inputState,
  dimensions,
}: Omit<RenderInputOptions, "syntax" | "historyBrowsing" | "historyCollapsed">): void {
  const continuationPromptLen = getContinuationPromptLength(
    renderer.continuationPromptText
  );
  const plan = buildCollapsedRenderPlan(
    inputState.lines,
    Math.max(1, dimensions.rows - 1),
    dimensions.columns,
    renderer.promptLen,
    continuationPromptLen
  );

  if (!plan) {
    renderWindowed({ renderer, inputState, dimensions });
    return;
  }

  const lines = [...plan.multiline, plan.inputLine];
  renderer.renderWithCursor(
    lines,
    lines.length - 1,
    plan.inputLineCursorCol,
    dimensions.columns,
    plan.sourceLineMap,
    plan.promptKinds
  );
}

function getOutputQuietDelay(baseDelay: number, lastOutputAt: number): number {
  if (process.platform !== "win32") {
    return baseDelay;
  }

  const quietWindowMs = 24;
  const elapsed = Date.now() - lastOutputAt;
  return elapsed >= quietWindowMs ? baseDelay : Math.max(baseDelay, quietWindowMs - elapsed);
}
