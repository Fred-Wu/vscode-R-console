const assert = require("node:assert/strict");
const vscode = require("vscode");

suite("Extension Host Smoke Test", () => {
  test("activates R Console and registers core commands", async () => {
    const dependency = vscode.extensions.getExtension("REditorSupport.r");
    assert.ok(dependency, "vscode-R extension dependency was not installed");

    const extension = vscode.extensions.getExtension("RConsole.vsc-r-console");
    assert.ok(extension, "R Console extension was not loaded");

    await extension.activate();
    assert.equal(extension.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "r-console.createTerminal",
      "r-console.createTerminalSide",
      "r-console.managePersistentSessions",
      "r-console.insertPipeOperator",
      "r-console.triggerCompletion",
      "r-console.restoreDefaultName",
    ]) {
      assert.ok(commands.includes(command), `${command} was not registered`);
    }
  });
});
