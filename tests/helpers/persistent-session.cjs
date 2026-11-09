const { randomUUID } = require("node:crypto");

function session({ legacy = false, pid = process.pid, cwd = "/original/project", ...runtime } = {}) {
  return {
    terminalName: "Saved console",
    location: { kind: "panel" },
    terminal: {
      options: { rPath: "/R/bin/R", rArgs: ["--quiet"], bracketedPaste: true, cwd },
      runtime: { sessionId: randomUUID(), port: 12345, pid, ...(!legacy && { authToken: "a".repeat(64), protocolVersion: 2 }), ...runtime },
      ui: {
        replay: { lines: ["R> x <- 42"], finalRow: 0, cursorRow: 0, cursorCol: 0 },
        replayColumns: 80, replayRows: 24, mode: "ready", promptKind: "main",
        promptReady: true, promptVisible: true, replyPromptText: "", pendingPromptToken: false,
        pendingInitialPromptGap: false, lastWriteEndedWithNewline: true, hasReceivedOutput: true,
        inputText: "", inputCursorPosition: 0, backendChildPid: pid,
      },
    },
  };
}
module.exports = { session };
