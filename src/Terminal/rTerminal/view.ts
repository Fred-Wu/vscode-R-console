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

export type InputRenderPlan = {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  sourceLineMap: Array<number | undefined>;
  promptKinds: Array<"main" | "cont">;
  renderedRowCount: number;
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

  const plan = buildInputRenderPlan({
    renderer,
    inputState,
    dimensions,
    historyBrowsing,
    historyCollapsed,
  });

  renderer.renderWithCursor(
    plan.lines,
    plan.cursorRow,
    plan.cursorCol,
    dimensions.columns,
    plan.sourceLineMap,
    plan.promptKinds
  );
}

export function buildInputRenderPlan({
  renderer,
  inputState,
  dimensions,
  historyBrowsing,
  historyCollapsed,
}: Omit<RenderInputOptions, "syntax">): InputRenderPlan {
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

  let plan:
    | Pick<InputRenderPlan, "lines" | "cursorRow" | "cursorCol" | "sourceLineMap" | "promptKinds">;

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
    plan = buildCollapsedInputRenderPlan({ renderer, inputState, dimensions });
  } else if (totalRows > maxRows) {
    plan = buildWindowedInputRenderPlan({ renderer, inputState, dimensions });
  } else {
    plan = {
      lines,
      cursorRow: inputState.cursorRow,
      cursorCol: inputState.cursorCol,
      sourceLineMap: lines.map((_, index) => index),
      promptKinds: lines.map((_, index) => index === 0 ? "main" : "cont"),
    };
  }

  const renderedRowCount = getRenderedRowCount(
    plan.lines,
    dimensions.columns,
    renderer.promptLen,
    continuationPromptLen
  );

  return {
    ...plan,
    renderedRowCount,
  };
}

export function formatTerminalOutput(text: string): string {
  let formatted = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\r") {
      if (text[index + 1] === "\n") {
        formatted += "\r\n";
        index += 1;
      } else {
        formatted += "\r";
      }
      continue;
    }

    if (char === "\n") {
      formatted += "\r\n";
      continue;
    }

    formatted += char;
  }
  return formatted;
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

function buildWindowedInputRenderPlan({
  renderer,
  inputState,
  dimensions,
}: Omit<RenderInputOptions, "syntax" | "historyBrowsing" | "historyCollapsed">):
  Pick<InputRenderPlan, "lines" | "cursorRow" | "cursorCol" | "sourceLineMap" | "promptKinds"> {
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

  return plan;
}

function buildCollapsedInputRenderPlan({
  renderer,
  inputState,
  dimensions,
}: Omit<RenderInputOptions, "syntax" | "historyBrowsing" | "historyCollapsed">):
  Pick<InputRenderPlan, "lines" | "cursorRow" | "cursorCol" | "sourceLineMap" | "promptKinds"> {
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
    return buildWindowedInputRenderPlan({ renderer, inputState, dimensions });
  }

  const lines = [...plan.multiline, plan.inputLine];
  return {
    lines,
    cursorRow: lines.length - 1,
    cursorCol: plan.inputLineCursorCol,
    sourceLineMap: plan.sourceLineMap,
    promptKinds: plan.promptKinds,
  };
}

function getOutputQuietDelay(baseDelay: number, lastOutputAt: number): number {
  if (process.platform !== "win32") {
    return baseDelay;
  }

  const quietWindowMs = 24;
  const elapsed = Date.now() - lastOutputAt;
  return elapsed >= quietWindowMs ? baseDelay : Math.max(baseDelay, quietWindowMs - elapsed);
}
