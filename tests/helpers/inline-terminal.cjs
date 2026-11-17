const { Terminal } = require("@xterm/headless");
const loadSource = require("./load-source.cjs");

// Exercise production keyboard handling, completion state and rendering with
// a headless terminal in place of the VS Code UI.
function createTerminal(t, columns = 80, rows = 24, trigger = "typing", settings = {}) {
  const scrollCommands = [];
  const { InputState } = loadSource("src/Terminal/inputState.ts");
  const { Renderer } = loadSource("src/Terminal/renderer.ts");
  const { KeyProcessor } = loadSource("src/Terminal/keyProcessor.ts");
  const { InlineCompletion } = loadSource("src/Terminal/inlineCompletion.ts");
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    "./rTerminal/lang": {},
    vscode: {
      EventEmitter: class {}, window: {},
      commands: { executeCommand(command) { scrollCommands.push(command); return Promise.resolve(); } },
      workspace: { getConfiguration: () => ({ get: (key, fallback) =>
        key in settings ? settings[key] : key === "completionUI" ? "inline" : key === "inlineCompletion.trigger" ? trigger : fallback }) },
    },
  });
  const screen = new Terminal({ cols: columns, rows, allowProposedApi: true });
  const unicode = screen._core.unicodeService;
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    inputState: new InputState(), inlineCompletion: new InlineCompletion(unicode),
    mode: "ready", promptReady: true, dimensions: { columns, rows },
    runtimeHostAdapter: { options: { vscodeR: { kind: "disabled" } } },
    inlineSuggestionRowCount: 0,
    lang: { cancelCompletion() {}, updateInput() {}, refineInlineCompletion() {} },
    syntax: { setSource() {} },
    writeEmitter: { fire(text) { screen._core._writeBuffer.writeSync(text); } },
    ensureReadyPromptVisibleForInput() {},
    withTerminalStateCaptureSuppressed(callback) { callback(); },
    applyCompletion(selection) { this.accepted = selection; },
    handleEnterKey() { this.submitted = this.inputState.text; },
  });
  terminal.renderer = new Renderer(text => terminal.writeEmitter.fire(text), undefined,
    text => [...text].reduce((sum, char) => sum + unicode.wcwidth(char.codePointAt(0)), 0));
  terminal.renderer.setContinuationPrompt("   ");
  const keys = new KeyProcessor();
  screen.onData(data => {
    for (const action of keys.parseInputChunk(data)) terminal.applyKeyAction(action);
  });
  t.after(() => {
    terminal.dismissInlineCompletion(false);
    screen.dispose();
  });
  return { terminal, screen, scrollCommands };
}

module.exports = { createTerminal };
