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
    let runtimeProbes = 0;
    const lang = new RTermLang({
      extensionPath: path.resolve(__dirname, "../.."),
      rPath: process.env.R_TEST_EXECUTABLE || "R", env: { ...process.env },
      requestMemberCompletions: async expression => {
        runtimeProbes++;
        // This fixture has no live receiver. Preserve the cached-name fallback
        // while retaining the stale argument fixture used by signature tests.
        return expression.includes(".tagged <-") ? undefined : [{ name: "old_arg" }];
      },
    });
    const snapshot = (text, cursor = text.length) => {
      const lines = text.split("\n"), before = text.slice(0, cursor);
      const cursorRow = before.split("\n").length - 1;
      return { text, currentLine: lines[cursorRow], lines, cursorRow,
        cursorCol: before.split("\n").at(-1).length, textBeforeCursor: before };
    };
    let lastGroupedItems;
    const complete = async (text, session, cursor = text.length, force = false) => {
      const input = snapshot(text, cursor);
      let items;
      await lang.handleAutocomplete({ input, force, getCurrentInput: () => input,
        getWorkspaceData: () => session, applyCompletion() {},
        onInlineEntries: result => { items = result; } });
      assert.ok(Array.isArray(items), `completion results for ${text}`);
      lastGroupedItems = items;
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
      const runtime = { globalenv: { runtime_function: { type: 'closure' } } };
      for (const text of ['data.frame(', 'data.frame(..., row.names = NULL, ',
        'f <- function(...) NULL\nf(1,2, ']) {
        const dots = (await complete(text)).find(item => item.insertText === '...');
        assert.ok(dots, `variadic indicator for ${text}`);
        assert.equal(dots.isCallable, false);
      }
      const exhaustedText = 'base::atan2(1,2, )';
      assert.deepEqual(await complete(exhaustedText, runtime, exhaustedText.length - 1), []);
      for (const text of ['g <- function(f) { f(run',
        'g <- function(atan2) { atan2(1,2, run']) {
        const items = await complete(text, runtime);
        assert.ok(items.some(item => item.insertText === 'runtime_function()'), text);
        assert.ok(items.every(item => item.detail !== 'parameter'), text);
      }
      const arithmetic = await complete('stats::cor(method = x + pea');
      assert.ok(arithmetic.every(item => !item.detail?.startsWith('value for ')));
      for (const text of ['with(data = df, ', 'subset(x = df, ', 'transform(`_data` = df, ']) {
        const items = await complete(text, { globalenv: { df: { names: ['alpha'] } } });
        assert.ok(items.some(item => item.insertText === 'alpha'), text);
      }
      const indexText = 'lst <- list(alpha = 10, beta = 20)\nindex <- "beta"\nlst[[ind]]';
      const indexItems = await complete(indexText, { globalenv: {
        lst: { names: ['alpha', 'beta'] }, index: { type: 'character' },
      } }, indexText.length - 2);
      assert.deepEqual(indexItems.map(item => item.insertText), ['index']);
      const indexSession = { globalenv: {
        lst: { names: ['alpha', 'beta'] }, index: { type: 'character' },
        unrelated_function: { type: 'closure' },
      } };
      const emptyIndex = await complete('lst[[', indexSession);
      assert.deepEqual(emptyIndex.map(item => item.insertText), ['"alpha"', '"beta"']);
      assert.equal(lang.refineInlineCompletion(snapshot('lst[[ind')), undefined,
        'typing in an empty index must request newly eligible symbols');
      assert.deepEqual((await complete('lst[[ind', indexSession)).map(item => item.insertText), ['index']);
      for (const text of ['base::atan2(y = ', '# unrelated', '"unrelated', '# ', '"', 'r"--(']) {
        assert.deepEqual(await complete(text, indexSession, text.length, true), [], text);
      }

      const unfinished = '{\n  g <- function(`a b`, normal) NULL\n  g(`a b` = 1, ';
      const remaining = await complete(unfinished);
      assert.deepEqual(remaining.filter(item => item.detail === "parameter").map(item => item.insertText), ["normal = "]);
      assert.equal(remaining.find(item => item.detail === "parameter").replaceStart, snapshot(unfinished).cursorCol);
      // The actual language-client converter must retain source precedence,
      // including a zero-argument signature with no parameter items to inspect.
      const session = { globalenv: { f: { type: "closure" } } };
      for (const [definition, expected] of [["function(new_arg)", ["new_arg = "]], ["function()", []]]) {
        const items = await complete(`{\n f <- ${definition} NULL\n f(`, session);
        assert.deepEqual(items.filter(item => item.detail === "parameter").map(item => item.insertText), expected);
      }
      const wrapped = await complete('f <- (function(new_arg) NULL)\nf(', session);
      assert.deepEqual(wrapped.filter(item => item.detail === "parameter").map(item => item.insertText), ['new_arg = ']);
      for (const [formal, expected] of [['f = function(inner_arg) NULL', ['inner_arg = ']], ['f', []]]) {
        const items = await complete(`f <- function(outer_arg) NULL\ng <- function(${formal}) { f(`, session);
        assert.deepEqual(items.filter(item => item.detail === 'parameter').map(item => item.insertText), expected);
      }
      const exhausted = await complete('f <- function(method = c("one", "two")) NULL\nf(method = "one", ');
      assert.ok(exhausted.every(item => !item.detail?.startsWith('value for ')));
      const literalValues = await complete('f <- function(`$1` = c("$2", "${3:text}")) NULL\nf(`$1` = "');
      assert.deepEqual(literalValues.map(item => item.insertText), ['$2', '${3:text}']);
      assert.ok(literalValues.every(item => item.detail === 'value for $1'));
      const partial = await complete('stats::cor(met = "sp');
      assert.ok(partial.some(item => item.insertText === 'spearman' && item.isCallable === false));
      for (const name of ['foo$1', 'foo${2:text}', 'foo bar']) {
        const items = await complete('`' + name + '` <- function(x) NULL\nfoo');
        assert.ok(items.some(item => item.insertText === '`' + name + '`()'), name);
      }
      for (const operator of ['|>', '%>%']) {
        const items = await complete(`my_frob <- function(x) x\n1 ${operator} my_fr`);
        assert.ok(items.some(item => item.insertText === 'my_frob()' && item.isCallable === true), operator);
      }
      const shadowPrint = { globalenv: { print: { type: 'closure' } } };
      const probesBeforeShadow = runtimeProbes;
      const shadowed = await complete('print(data.frame(a=1), ', shadowPrint);
      assert.ok(shadowed.some(item => item.insertText === 'old_arg = '),
        'native S3 metadata must not suppress the session function signature');
      assert.equal(runtimeProbes, probesBeforeShadow + 1);
      const qualifiedPrint = await complete('base::print(data.frame(a=1), ', shadowPrint);
      assert.ok(qualifiedPrint.some(item => item.insertText === 'digits = '));
      assert.ok(qualifiedPrint.every(item => item.insertText !== 'old_arg = '));
      assert.equal(runtimeProbes, probesBeforeShadow + 1, 'qualified calls must not probe a session namesake');
      for (const [marked, expected] of [
        ['{ print <- function(x, source_arg) NULL; print(data.frame(a=1), │) }', ['x = ', 'source_arg = ']],
        ['{ print <- function(x, source_arg) NULL; print(x=data.frame(a=1), │) }', ['source_arg = ']],
        ['{ print <- function(x, source_arg) NULL; print(data.frame(a=1), source_arg=1, │) }', []],
        ['g <- function(print) { print(data.frame(a=1), │) }', []],
      ]) {
        const text = marked.replace('│', '');
        const items = await complete(text, shadowPrint, marked.indexOf('│'));
        assert.deepEqual(items.map(item => item.insertText), expected, marked);
        assert.equal(runtimeProbes, probesBeforeShadow + 1,
          'lexical bindings must supersede native S3 metadata without probing the session');
      }
      const probesBeforeNative = runtimeProbes;
      const memberText = 'obj <- list(alpha = 1)\nobj$alpha';
      const memberCursor = memberText.length - 4;
      const memberItems = await complete(memberText, undefined, memberCursor);
      const member = memberItems.find(item => item.insertText === 'alpha');
      assert.ok(member);
      assert.equal(member.replaceStart, 4);
      assert.equal(member.replaceEnd, 9);
      const refinedMemberText = memberText.replace('obj$alpha', 'obj$allpha');
      const refinedMember = lang.refineInlineCompletion(snapshot(refinedMemberText, memberCursor + 1))
        .find(item => item.insertText === 'alpha');
      assert.equal(refinedMember.replaceEnd, 10);
      const callable = await complete('obj <- list(`fun$1` = function(arg) NULL)\nobj$fu');
      assert.ok(callable.some(item => item.insertText === '`fun$1`()'));
      const emptyMembers = await complete('obj <- list()\nobj$');
      assert.equal(emptyMembers.length, 0);
      const constructor = await complete('Thing <- R6::R6Class("Thing", public = list(initialize = function(value, other) NULL))\nThing$new(value=1, ');
      assert.ok(constructor.some(item => item.insertText === 'other = '));
      assert.ok(constructor.every(item => item.insertText !== 'value = '));
      assert.equal(runtimeProbes, probesBeforeNative, 'native results must survive the real converter without runtime probes');
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
        const groups = new Map();
        let group;
        for (const item of lastGroupedItems) {
          if (!("insertText" in item)) { group = item.label; groups.set(group, []); }
          else groups.get(group).push(item.label.replace(/^\$\([^)]+\) /, ""));
        }
        assert.ok(groups.has('Functions'), `function group for ${operator}`);
        assert.ok(groups.has('Fields'), `native nonfunction group for ${operator}`);
        if (operator === '::') assert.ok(groups.get('Functions').includes('setorderv'));
        // The internal namespace is truncated by the server; the typed
        // request below must still reach setorderv beyond that initial limit.
        assert.ok(groups.get('Fields').includes('.N'));
        for (const [group, names] of groups) {
          assert.deepEqual(names, [...names].sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)), group);
        }
        const refined = await complete(`data.table${operator}set`);
        assert.ok(refined.some(item => item.insertText === "setorderv()"), "prefix request reaches candidates beyond the initial limit");
        const prefixed = refined.map(item => item.label.replace(/^\$\([^)]+\) /, "")).filter(label => label.startsWith('set'));
        assert.deepEqual(prefixed, [...prefixed].sort((a, b) => collator.compare(a, b)));
        const cached = lang.refineInlineCompletion(snapshot(`data.table${operator}seta`));
        assert.ok(cached.some(item => item.label === 'Functions' && !("insertText" in item)));
        assert.ok(cached.some(item => item.insertText === 'setattr()'));
      }
      const { Terminal } = require('@xterm/headless');
      const { InlineCompletion } = loadSource('src/Terminal/inlineCompletion.ts');
      const screen = new Terminal({ cols: 80, rows: 24 });
      try {
        const panel = new InlineCompletion(screen._core.unicodeService);
        const session = { search: ['package:data.table', 'package:stats', 'package:base'], globalenv: {
          test: { class: ['data.table', 'data.frame'], names: ['col.name'] },
        } };
        lang.updateSessionData(session);
        const broad = await complete('test[, .', session);
        panel.set(lastGroupedItems, panel.token, '.');
        const functionIndex = broad.findIndex(item => item.isCallable);
        assert.ok(functionIndex >= 0);
        panel.move(functionIndex);
        const narrowed = await complete('test[, .N', session);
        assert.ok(narrowed.some(item => item.insertText === '.N'));
        panel.set(lastGroupedItems, panel.invalidate(), '.N');
        assert.equal(panel.current(), narrowed[0], 'new query starts at the first displayed suggestion');
        assert.equal(panel.selected, 0);
        panel.lines(80, 12);
        assert.equal(panel.scrollStart, 0, 'the viewport returns to the beginning');
      } finally {
        screen.dispose();
      }
    } finally {
      await lang.dispose();
    }
  });
});

suite("Subscript method completion in the VS Code extension host", () => {
  test("live method arguments and fields retain separate groups", async () => {
    const { runRJson } = require('../helpers/run-r-json.cjs');
    const { RTermLang } = loadSource('src/Terminal/rTerminal/lang.ts', {
      'vscode-languageclient/node': require('vscode-languageclient/node'),
    });
    const lang = new RTermLang({
      extensionPath: path.resolve(__dirname, '../..'),
      rPath: process.env.R_TEST_EXECUTABLE || 'R', env: { ...process.env },
      requestMemberCompletions: async expression => runRJson(`
        DT <- data.table::data.table(zebra = 1, alpha = 2)
        df <- as.data.frame(DT)
        value <- eval(parse(text = inputs))
        cat(jsonlite::toJSON(lapply(names(value), function(n) list(name = n, type = typeof(value[[n]]))), auto_unbox = TRUE))
      `, expression),
    });
    const complete = async text => {
      const input = { text, currentLine: text, lines: [text], cursorRow: 0,
        cursorCol: text.length, textBeforeCursor: text };
      let items;
      await lang.handleAutocomplete({ input, getCurrentInput: () => input,
        getWorkspaceData: () => undefined, applyCompletion() {}, onInlineEntries: result => { items = result; } });
      assert.ok(Array.isArray(items));
      return items;
    };
    try {
      const items = await complete('DT[, ');
      assert.deepEqual(items.filter(item => !('insertText' in item)).map(item => item.label),
        ['Fields', 'Arguments']);
      assert.deepEqual(items.filter(item => item.detail === 'DT').map(item => item.insertText), ['zebra', 'alpha']);
      assert.ok(items.some(item => item.insertText === 'keyby = '));
      const dataFrame = await complete('df[, ');
      assert.ok(dataFrame.some(item => item.insertText === 'drop = '));
      const value = await complete('DT[, keyby = al');
      assert.ok(value.every(item => item.detail !== 'parameter'));
    } finally {
      await lang.dispose();
    }
  });
});
