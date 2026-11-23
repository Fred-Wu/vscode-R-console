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
    let staticMode = true;
    const lang = new RTermLang({
      extensionPath: path.resolve(__dirname, "../.."),
      rPath: process.env.R_TEST_EXECUTABLE || "R", env: { ...process.env },
      // These legacy cases deliberately exercise the opt-in source analyzer.
      getStaticAnalysisEnabled: () => staticMode,
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
      const shadowPrint = { search: [], globalenv: { print: {
        type: 'closure', str: 'function(x, old_arg)',
      } } };
      lang.updateSessionData(shadowPrint);
      staticMode = false;
      const shadowed = await complete('print(data.frame(a=1), ', shadowPrint);
      assert.ok(shadowed.some(item => item.insertText === 'old_arg = '),
        'native S3 metadata must not suppress the session function signature');
      const qualifiedPrint = await complete('base::print(data.frame(a=1), ', shadowPrint);
      assert.ok(qualifiedPrint.some(item => item.insertText === 'digits = '));
      assert.ok(qualifiedPrint.every(item => item.insertText !== 'old_arg = '));
      staticMode = true;
      for (const [marked, expected] of [
        ['{ print <- function(x, source_arg) NULL; print(data.frame(a=1), │) }', ['source_arg = ']],
        ['{ print <- function(x, source_arg) NULL; print(x=data.frame(a=1), │) }', ['source_arg = ']],
        ['{ print <- function(x, source_arg) NULL; print(data.frame(a=1), source_arg=1, │) }', []],
        ['g <- function(print) { print(data.frame(a=1), │) }', []],
      ]) {
        const text = marked.replace('│', '');
        const items = await complete(text, shadowPrint, marked.indexOf('│'));
        assert.deepEqual(items.map(item => item.insertText), expected, marked);
      }
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

suite("Subscript completion in the VS Code extension host", () => {
  test("live bracket arguments reach inline, Tab and F7 through the real language client", async () => {
    const vscode = require('vscode');
    let picker;
    const { RTermLang } = loadSource('src/Terminal/rTerminal/lang.ts', {
      'vscode-languageclient/node': require('vscode-languageclient/node'),
      // Copy descriptors without reading unrelated proposed-API getters.
      vscode: Object.create(null, {
        ...Object.getOwnPropertyDescriptors(vscode),
        window: { value: Object.create(vscode.window, {
          createQuickPick: { value: (...args) => (picker = vscode.window.createQuickPick(...args)) },
        }) },
      }),
    });
    const lang = new RTermLang({
      extensionPath: path.resolve(__dirname, '../..'),
      rPath: process.env.R_TEST_EXECUTABLE || 'R', env: { ...process.env },
      getStaticAnalysisEnabled: () => false,
      requestRuntimeMemberCompletions: async receiver => ({
        status: 'available', names: ['alpha'],
        bracketKind: receiver === 'DT' ? 'data.table' : 'data.frame',
      }),
    });
    try {
      for (const mode of ['inline', 'Tab', 'F7']) {
        for (const [marked, expected] of [
          ['DT[, key│', 'keyby = '], ['DT[, on│]', 'on = '], ['df[, dr│]', 'drop = '],
          ['DT[, │]', 'keyby = '], ['df[, │', 'drop = '], ['DT[, .S│]', '.SD'],
        ]) {
          const cursorCol = marked.indexOf('│'), text = marked.replace('│', '');
          const input = { text, currentLine: text, lines: [text], cursorRow: 0,
            cursorCol, textBeforeCursor: text.slice(0, cursorCol) };
          picker = undefined;
          let items = [];
          const showing = lang.handleAutocomplete({ input, force: mode === 'F7', getCurrentInput: () => input,
            getWorkspaceData: () => undefined, applyCompletion() {},
            onInlineEntries: mode === 'inline' ? result => { items = result; } : undefined });
          try {
            const deadline = Date.now() + 10000;
            const results = () => mode === 'inline' ? items : picker?.items ?? [];
            while (!results().some(item => item.insertText === expected) && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.ok(results().some(item => item.insertText === expected),
              `${mode} ${marked}: missing ${expected}; received ${JSON.stringify(results().map(item => item.insertText ?? item.label))}`);
          } finally {
            picker?.hide();
            await showing;
          }
        }
      }
    } finally {
      await lang.dispose();
    }
  });

  test("workspace columns and source-inferred arguments retain separate groups", async () => {
    const { RTermLang } = loadSource('src/Terminal/rTerminal/lang.ts', {
      'vscode-languageclient/node': require('vscode-languageclient/node'),
    });
    let expressionProbes = 0;
    const lang = new RTermLang({
      extensionPath: path.resolve(__dirname, '../..'),
      rPath: process.env.R_TEST_EXECUTABLE || 'R', env: { ...process.env },
      // These legacy cases deliberately exercise the opt-in source analyzer.
      getStaticAnalysisEnabled: () => true,
      requestMemberCompletions: async () => { expressionProbes++; return undefined; },
    });
    const session = { search: [], loaded_namespaces: [], globalenv: {
      DT: { type: 'list', class: ['data.table', 'data.frame'], names: ['zebra', 'alpha'] },
      df: { type: 'list', class: ['data.frame'], names: ['zebra', 'alpha'] },
    } };
    const complete = async text => {
      const lines = text.split('\n'), currentLine = lines.at(-1);
      const input = { text, currentLine, lines, cursorRow: lines.length - 1,
        cursorCol: currentLine.length, textBeforeCursor: text };
      let items;
      await lang.handleAutocomplete({ input, getCurrentInput: () => input,
        getWorkspaceData: () => session, applyCompletion() {}, onInlineEntries: result => { items = result; } });
      assert.ok(Array.isArray(items));
      return items;
    };
    try {
      const dataTable = await complete('DT[, ');
      assert.ok(dataTable.some(item => !('insertText' in item) && item.label === 'Fields'));
      assert.deepEqual(dataTable.filter(item => item.detail === 'DT').map(item => item.insertText),
        ['zebra', 'alpha']);

      const dataFrame = await complete('df[, ');
      assert.deepEqual(dataFrame.filter(item => item.detail === 'df').map(item => item.insertText),
        ['"zebra"', '"alpha"']);

      // Unlike runtime-only receivers, a source-defined receiver gives the
      // language server enough information to infer S3 method arguments.
      const sourced = await complete('df <- data.frame(zebra = 1, alpha = 2)\nsubset(df, ');
      const groups = sourced.filter(item => !('insertText' in item)).map(item => item.label);
      assert.ok(groups.includes('Fields'), 'cached columns remain available in the data mask');
      assert.ok(groups.includes('Arguments'), 'native S3 arguments remain available');
      assert.ok(groups.indexOf('Fields') < groups.indexOf('Arguments'));
      assert.ok(sourced.some(item => item.insertText === 'drop = '));

      const value = await complete('DT[, keyby = al');
      assert.ok(value.every(item => item.detail !== 'parameter'));
      assert.equal(expressionProbes, 0, 'subscript completion must not evaluate R expressions');
    } finally {
      await lang.dispose();
    }
  });
});

suite("Static fallback routing in the VS Code extension host", () => {
  test("guarded live inspection falls back to source inference without calling an executable receiver", async () => {
    const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
      "vscode-languageclient/node": require("vscode-languageclient/node"),
    });
    let staticEnabled = true;
    const native = [], sourceRequests = [];
    let storedDefinition = "function() list(stored_alpha = 1)";
    const lang = new RTermLang({
      extensionPath: path.resolve(__dirname, "../.."),
      rPath: process.env.R_TEST_EXECUTABLE || "R", env: { ...process.env },
      getStaticAnalysisEnabled: () => staticEnabled,
      requestRuntimeFunctionSource: async name => {
        sourceRequests.push(name);
        return name === "make_data" ? storedDefinition : undefined;
      },
      requestRuntimeMemberCompletions: async (receiver, target) => {
        native.push([receiver, target]);
        if (receiver === "new_obj") return { status: "missing" };
        if (receiver === "empty_obj") return { status: "available", names: [] };
        return { status: "suppressed", reason: "unsafe-dispatch" };
      },
    });
    const completeItems = async (text, cursor = text.length) => {
      const lines = text.split("\n");
      const before = text.slice(0, cursor).split("\n");
      const cursorRow = before.length - 1;
      const input = { text, lines, cursorRow, currentLine: lines[cursorRow],
        cursorCol: before.at(-1).length, textBeforeCursor: text.slice(0, cursor) };
      let entries = [];
      await lang.handleAutocomplete({ input, getCurrentInput: () => input,
        getWorkspaceData: () => ({ search: [], globalenv: {} }),
        applyCompletion() {}, onInlineEntries: items => { entries = items; } });
      return entries.filter(item => "insertText" in item);
    };
    const complete = async text => (await completeItems(text)).map(item => item.insertText);
    try {
      const suppressed = await complete("obj <- list(alpha = 1)\nobj$");
      assert.ok(suppressed.includes("alpha"), "suppressed live inspection uses the existing R source analyzer");
      assert.deepEqual(native, [["obj", "$"]]);

      const callable = await complete("make_data <- function() list(data = 1, metadata = 2)\nmake_data()$");
      assert.ok(callable.includes("data") && callable.includes("metadata"),
        "source-defined factory members are inferred without evaluating the call");
      assert.equal(native.length, 1, "executable receivers must never reach the native inspector");
      // Previously submitted definitions are absent from the editable buffer,
      // but their current stored closure must still be available to the LSP.
      const stored = await complete("make_data()$");
      assert.ok(stored.includes("stored_alpha"),
        "source inference must inspect a function defined before this input");
      assert.ok(!stored.includes("data"), "earlier projection is not retained");
      storedDefinition = "function() list(redefined_beta = 2)";
      const redefined = await complete("make_data()$");
      assert.ok(redefined.includes("redefined_beta") && !redefined.includes("stored_alpha"),
        "a redefined stored function is re-inferred, not served from a source journal");
      assert.deepEqual(sourceRequests, ["make_data", "make_data", "make_data"]);
      assert.deepEqual(native, [["obj", "$"]], "function source lookup never executes an accessor");

      storedDefinition = "function() list(alpha = 1, `odd field` = 2)";
      for (const [marked, expected] of [
        ["(make_data())$al│old", "(make_data())$alpha"],
        ["((make_data()))$al│", "((make_data()))$alpha"],
        ["( # group\n  make_data()\n)$al│old", ")$alpha"],
        ["make_data()$\n  al│old", "  alpha"],
        ["make_data()$ # continuation\n# comment\n  al│", "  alpha"],
        ["make_data()$`odd│", "make_data()$`odd field`"],
        ["make_data()$`odd│old`", "make_data()$`odd field`"],
        ["make_data()$\n  `odd│old`", "  `odd field`"],
      ]) {
        const cursor = marked.indexOf("│"), source = marked.replace("│", "");
        const items = await completeItems(source, cursor);
        assert.equal(items.length, 1, `only the receiver's matching member belongs in ${marked}`);
        const line = source.split("\n").at(-1), col = source.slice(0, cursor).split("\n").at(-1).length;
        assert.equal(line.slice(0, items[0].replaceStart) + items[0].insertText +
          line.slice(items[0].replaceEnd ?? col), expected, marked);
        assert.equal(sourceRequests.at(-1), "make_data");
      }
      assert.deepEqual(native, [["obj", "$"]], "continued and quoted receivers remain source-only");
      storedDefinition = 'function() list("odd\\nfield" = 1)';
      assert.deepEqual(await complete("make_data()$`odd\nfi"), [],
        "literal names begun on another line must not expose invalid replacement columns");


      // Older released languageserver versions do not infer quoted [[ keys.
      // Route without executing receivers, and validate any member edit when
      // a newer server provides source-only quoted-key inference.
      // Unquoted [[ and single [ must remain safe without invented source fields.
      for (const [definition, marked, expected, memberSuffix] of [
        ["make_data <- function() list(alpha = 1)",
          String.raw`make_data()[["al│old"]]`, 'make_data()[["alpha"]]', "alpha"],
        ["make_data <- function() list(alpha = 1)",
          String.raw`make_data()[['al│old']]`, "make_data()[['alpha']]", "alpha"],
        [String.raw`make_data <- function() list("line\nitem" = 1)`,
          String.raw`make_data()[["line\n│old"]]`, String.raw`make_data()[["line\nitem"]]`, "item"],
      ]) {
        const caret = marked.indexOf("│");
        const line = marked.replace("│", "");
        const source = definition + "\n" + line;
        const items = await completeItems(source, definition.length + 1 + caret);
        assert.ok(items.every(item => item.insertText.includes(memberSuffix)),
          `quoted source-only routing must not borrow unrelated candidates: ${marked}`);
        for (const member of items) {
          assert.equal(line.slice(0, member.replaceStart) + member.insertText +
            line.slice(member.replaceEnd ?? caret), expected,
            `real-provider replacement must preserve the whole quoted key: ${marked}`);
        }
        assert.equal(native.length, 1, "static quoted keys never inspect executable receivers");
      }
      for (const input of ["make_data()[[al", "make_data()[al"]) {
        assert.deepEqual(await complete("make_data <- function() list(alpha = 1)\n" + input), [],
          `${input} cannot borrow symbols or claim unsupported source member inference`);
        assert.equal(native.length, 1, "unquoted executable indices must remain source-only");
      }

      const missing = await complete("new_obj <- list(alpha = 1)\nnew_obj$");
      assert.ok(missing.includes("alpha"), "only native-confirmed absence permits unsubmitted source members");
      assert.deepEqual(native.at(-1), ["new_obj", "$"]);

      const empty = await complete("empty_obj <- list(alpha = 1)\nempty_obj$");
      assert.deepEqual(empty, [], "empty stored members override conflicting unsubmitted source without metadata");
      assert.deepEqual(native.at(-1), ["empty_obj", "$"]);

      const suppressedBracket = await complete('obj <- list(alpha = 1)\nobj[["al');
      assert.ok(suppressedBracket.every(item => item.includes("alpha")),
        "a suppressed stored bracket receiver cannot borrow unrelated symbols");
      // A released server may return no quoted [[ members. Either way it
      // must never bypass native suppression or suggest lexical scope fields.
      assert.deepEqual(native.at(-1), ["obj", "[["]);

      staticEnabled = false;
      assert.deepEqual(await complete("make_data()$"), [],
        "the default runtime-only policy still rejects executable receivers");
      assert.equal(native.length, 4);
    } finally {
      await lang.dispose();
    }
  });
});
