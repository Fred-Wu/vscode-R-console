const assert = require("node:assert/strict");
const path = require("node:path");
const loadSource = require("../helpers/load-source.cjs");

suite("Completion in the VS Code extension host", () => {
  test("real language-client results preserve argument order and alphabetize namespaces", async () => {
    // Use the actual VS Code API and language-client converters, not the Node
    // integration suite's host adapter or injected completion candidates.
    const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
      "vscode-languageclient/node": require("vscode-languageclient/node"),
    });
    const lang = new RTermLang({
      extensionPath: path.resolve(__dirname, "../.."),
      rPath: process.env.R_TEST_EXECUTABLE || "R", env: { ...process.env },
      requestMemberCompletions: async () => [],
    });
    const snapshot = text => {
      const lines = text.split("\n");
      return { text, currentLine: lines.at(-1), lines, cursorRow: lines.length - 1,
        cursorCol: lines.at(-1).length, textBeforeCursor: text };
    };
    const complete = async text => {
      const input = snapshot(text);
      let items;
      await lang.handleAutocomplete({ input, getCurrentInput: () => input,
        getWorkspaceData: () => undefined, applyCompletion() {},
        onInlineEntries: result => { items = result; } });
      assert.ok(items?.length, `completion results for ${text}`);
      return items.filter(item => "insertText" in item);
    };
    try {
      for (const head of ["stats::lm", "stats:::lm"]) {
        const items = await complete(`${head}(`);
        assert.deepEqual(items.filter(item => item.detail === "parameter").slice(0, 4).map(item => item.insertText),
          ["formula = ", "data = ", "subset = ", "weights = "]);
      }
      const values = await complete('stats::cor(method = "');
      assert.ok(values.some(item => item.insertText === "spearman"));
      assert.ok(values.every(item => item.detail !== "parameter"));
      const filtered = lang.refineInlineCompletion(snapshot('stats::cor(method = "sp'));
      assert.deepEqual(filtered.filter(item => "insertText" in item).map(item => item.insertText), ["spearman"]);
      const unfinished = '{\n  g <- function(`a b`, normal) NULL\n  g(`a b` = 1, ';
      const remaining = await complete(unfinished);
      assert.deepEqual(remaining.filter(item => item.detail === "parameter").map(item => item.insertText), ["normal = "]);
      assert.equal(remaining.find(item => item.detail === "parameter").replaceStart, snapshot(unfinished).cursorCol);
      const collator = new Intl.Collator("en", { sensitivity: "base" });
      for (const operator of ["::", ":::"]) {
        const items = await complete(`data.table${operator}`);
        const labels = items.map(item => item.label.replace(/^\$\([^)]+\) /, ""));
        assert.ok(labels.length > 2, `namespace candidates for ${operator}`);
        if (operator === "::") {
          assert.ok(labels.includes("setorderv"));
          assert.ok(labels.includes("frank"));
        } else {
          assert.ok(labels.some(label => label.startsWith(".")), "internal namespace candidates");
        }
        assert.deepEqual(labels, [...labels].sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)));
        const refined = await complete(`data.table${operator}set`);
        assert.ok(refined.some(item => item.insertText === "setorderv()"), "prefix request reaches candidates beyond the initial limit");
      }
    } finally {
      await lang.dispose();
    }
  });
});
