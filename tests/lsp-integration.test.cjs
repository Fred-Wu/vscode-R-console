const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const loadSource = require("./helpers/load-source.cjs");
const { runRJson } = require("./helpers/run-r-json.cjs");
const { authenticateLspSocket } = loadSource("src/Language/lspSocketAuth.ts");
const { BACKEND_AUTH_TIMEOUT_MS } = loadSource("src/Runtime/backendAuthentication.ts");
const completion = loadSource("src/Language/completion.ts", { vscode: {
  CompletionItemKind: { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Snippet: 14 },
  SnippetString: class {},
  Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
} });

test("typing and accepting functions opens real argument suggestions without another keystroke", { timeout: 90000 }, async t => {
  const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
  const { createTerminal } = require("./helpers/inline-terminal.cjs");
  const { client } = createConsoleLsp(t);
  // The helper's host adapter returns protocol kinds; emulate VS Code's enum
  // conversion while retaining the production client and real R server.
  const provide = client.provideCompletionItems.bind(client);
  client.provideCompletionItems = async (...args) => {
    const result = await provide(...args);
    const items = (Array.isArray(result) ? result : result?.items ?? []).map(item => ({
      ...item, kind: item.kind === undefined ? undefined : item.kind - 1,
    }));
    return { items, isIncomplete: result?.isIncomplete === true };
  };
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      Uri: { parse: value => ({ toString: () => value }) },
      CompletionItemKind: { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Snippet: 14 },
      QuickPickItemKind: { Separator: -1 }, SnippetString: class {},
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class { constructor() { return client; } } },
  });
  let memberProbeError;
  const requestMemberCompletions = async (expression, operator) => {
    try {
      return runRJson(`
      df <- data.frame(zebra = 0, alpha = 1, beta = 2, check.names = FALSE)
      df[["a b"]] <- 2
      obj <- list(lm = function(member_arg) stop("must not execute"), data = df,
        choose = function(method = c("zebra", "alpha", "beta"), other = c("wrong_value")) stop("must not execute"))
      nested <- list(df)
      dt <- data.table::as.data.table(df)
      methods::setClass("InlineCompletionTest", slots = c(lm = "function"))
      slot_obj <- methods::new("InlineCompletionTest", lm = function(slot_arg) stop("must not execute"))
      value <- eval(parse(text = inputs$expression), .GlobalEnv)
      slots <- identical(inputs$operator, "@")
      nms <- if (slots) methods::slotNames(value) else names(value)
      cat(jsonlite::toJSON(lapply(nms, function(n) list(name = n,
        type = typeof(if (slots) methods::slot(value, n) else value[[n]]))), auto_unbox = TRUE))
    `, { expression, operator });
    } catch (error) {
      memberProbeError = error;
      throw error;
    }
  };
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      assert.ifError(memberProbeError);
      assert.ok(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  for (const [typed, insertText, argument] of [
    ["lib", "library()", "package"],
    ["stats::", "lm()", "formula"], ["stats:::", "lm()", "formula"],
    ["obj$", "lm()", "member_arg"], ["slot_obj@", "lm()", "slot_arg"],
  ]) {
    client.updateInput("");
    const { terminal, screen } = createTerminal(t);
    delete terminal.applyCompletion;
    terminal.lang = new RTermLang({ extensionPath: "", rPath: "", env: {}, requestMemberCompletions });
    const choices = () => terminal.inlineCompletion.items.filter(item => "insertText" in item);
    for (const text of typed) terminal.applyKeyAction({ type: "text", text });
    await waitFor(() => terminal.inlineCompletion.visible, `automatic popup after ${typed}`);
    if (typed !== "lib") {
      for (const text of "lm") terminal.applyKeyAction({ type: "text", text });
    }
    await waitFor(() => choices().some(item => item.insertText === insertText), `function popup after ${typed}`);
    terminal.inlineCompletion.move(choices().findIndex(item => item.insertText === insertText) - terminal.inlineCompletion.selected);
    terminal.applyKeyAction({ type: "tab" });
    const expected = typed === "lib" ? "library()" : typed + insertText;
    assert.equal(terminal.inputState.text, expected);
    assert.equal(terminal.inputState.textBeforeCursor, expected.slice(0, -1));
    assert.equal(terminal.submitted, undefined);
    await waitFor(() => choices().some(item => item.insertText === `${argument} = `), `argument popup after ${expected}`);
    if (typed === "stats::" || typed === "stats:::") {
      assert.deepEqual(choices().filter(item => item.detail === "parameter").slice(0, 4).map(item => item.insertText),
        ["formula = ", "data = ", "subset = ", "weights = "], "lm arguments must retain signature order in the popup");
    }
    assert.equal(terminal.inputState.text, expected, "argument popup must not insert or execute anything");
    const buffer = screen.buffer.active;
    const visible = Array.from({ length: 24 }, (_, row) => buffer.getLine(buffer.baseY + row).translateToString(true)).join("\n");
    assert.ok(visible.includes("Arguments"), expected);
    if (typed === "lib") {
      terminal.applyKeyAction({ type: "tab" });
      assert.equal(terminal.inputState.textBeforeCursor, "library(package = ");
      terminal.applyKeyAction({ type: "text", text: ", " });
      await waitFor(() => choices().some(item => item.insertText === "help = " &&
        item.snapshotInput === terminal.inputState.currentLine), "next argument after accepting package");
      assert.ok(!choices().some(item => item.insertText === "package = "), "accepted names must not be offered again");
      assert.equal(terminal.inlineCompletion.current().insertText, "help = ");
      terminal.applyKeyAction({ type: "tab" });
      terminal.applyKeyAction({ type: "text", text: ", " });
      await waitFor(() => choices().some(item => item.insertText === "pos = " &&
        item.snapshotInput === terminal.inputState.currentLine), "next argument after accepting help");
      assert.equal(terminal.inlineCompletion.current().insertText, "pos = ");
    }
    terminal.dismissInlineCompletion(false);
    terminal.lang.cancelCompletion();
  }

  // Use the real provider, context collection, keyboard handling and renderer
  // for each trigger. No completion candidate is injected into the panel.
  for (const [marked, inserted, expected] of [
    ["df[│]", '"alpha"', 'df["alpha"]'],
    ["df[, │]", '"alpha"', 'df[, "alpha"]'],
    ["df[[│]]", '"alpha"', 'df[["alpha"]]'],
    ['df[["│"]]', "a b", 'df[["a b"]]'],
    ['df[["a│old"]]', "a b", 'df[["a b"]]'],
    ["df[['│']]", "a b", "df[['a b']]"],
    ['df[, "│"]', "a b", 'df[, "a b"]'],
    ["df$│", "alpha", "df$alpha"],
    ["obj$data[[│]]", '"alpha"', 'obj$data[["alpha"]]'],
    ["nested[[1]][[│]]", '"alpha"', 'nested[[1]][["alpha"]]'],
    ["dt[, │]", "alpha", "dt[, alpha]"],
    ["dt[, │]", "`a b`", "dt[, `a b`]"],
    ["dt[[│]]", '"alpha"', 'dt[["alpha"]]'],
    ["outer(df[[\n  │]])", '"alpha"', 'outer(df[[\n  "alpha"]])'],
    ["library(│)", "package = ", "library(package = )"],
    ["stats::cor(x, │)", "method = ", "stats::cor(x, method = )"],
    ["stats::cor(\n  x, │)", "method = ", "stats::cor(\n  x, method = )"],
    ["stats::cor(method = │)", '"spearman"', 'stats::cor(method = "spearman")'],
    ['stats::cor(method = "│")', "spearman", 'stats::cor(method = "spearman")'],
    ['stats::cor(method = "sp│ear")', "spearman", 'stats::cor(method = "spearman")'],
    ["stats::cor(method = '│')", "spearman", "stats::cor(method = 'spearman')"],
    ["stats::cor(method = sp│)", '"spearman"', 'stats::cor(method = "spearman")'],
    ['stats::cor(`method` = "│")', "spearman", 'stats::cor(`method` = "spearman")'],
    ["obj$choose(method = │)", '"alpha"', 'obj$choose(method = "alpha")'],
    ['obj$choose(method = "a│old")', "alpha", 'obj$choose(method = "alpha")'],
    ["subset(df, │)", "alpha", "subset(df, alpha)"],
    ["df |> subset(│)", "alpha", "df |> subset(alpha)"],
    ["df |> │", undefined, undefined], ["df %>% │", undefined, undefined],
  ]) {
    client.updateInput("");
    const { terminal } = createTerminal(t);
    delete terminal.applyCompletion;
    terminal.lang = new RTermLang({ extensionPath: "", rPath: "", env: {}, requestMemberCompletions });
    const cursor = marked.indexOf("│");
    terminal.inputState.insertText(marked.replace("│", ""));
    terminal.inputState.cursorPosition = cursor;
    // Typing a separator exercises the ordinary edit-to-popup path.
    const quoted = /["']$/.test(marked.slice(0, cursor));
    const prefix = /[A-Za-z]$/.test(marked.slice(0, cursor));
    if (quoted || prefix) {
      terminal.inputState.deleteBeforeCursor();
      terminal.applyKeyAction({ type: "text", text: marked[cursor - 1] });
    } else {
      terminal.applyKeyAction({ type: "text", text: " " });
    }
    const choices = () => terminal.inlineCompletion.items.filter(item => "insertText" in item);
    await waitFor(() => inserted ? choices().some(item => item.insertText === inserted) : choices().length > 0,
      `automatic real-provider suggestions for ${marked}`);
    if (/^(df(?:\[|\$)|dt\[|obj\$data\[|nested\[|outer\(df\[|subset\(df,|df \|> subset\()/.test(marked)) {
      assert.deepEqual(choices().filter(item => / (zebra|alpha|beta|a b)$/.test(item.label)).map(item => item.label.replace(/^\$\([^)]+\) /, "")),
        ["zebra", "alpha", "beta", "a b"], `column order: ${marked}`);
    }
    if (marked === "obj$choose(method = │)") {
      assert.deepEqual(choices().filter(item => item.detail === "value for method").map(item => item.insertText),
        ['"zebra"', '"alpha"', '"beta"'], "declared value order");
    }
    if (marked.includes("method =")) {
      assert.ok(choices().every(item => !item.insertText.endsWith(" = ")), marked);
      assert.ok(choices().every(item => !item.insertText.includes("wrong_value")), marked);
    }
    if (inserted) {
      terminal.inlineCompletion.move(choices().findIndex(item => item.insertText === inserted) - terminal.inlineCompletion.selected);
      terminal.applyKeyAction({ type: "tab" });
      // Keep the separator typed above; quote prefixes need no extra space.
      const accepted = quoted || prefix ? expected : expected.slice(0, cursor) + " " + expected.slice(cursor);
      assert.equal(terminal.inputState.text, accepted, marked);
      if (marked === "stats::cor(x, │)") {
        await waitFor(() => choices().some(item => item.insertText === '"pearson"'),
          "accepting method = must automatically open known values");
      }
    } else {
      assert.ok(choices().every(item => item.insertText.endsWith("()")), marked);
    }
    terminal.dismissInlineCompletion(false);
    terminal.lang.cancelCompletion();
  }

  client.updateInput("");
  const { terminal: piped } = createTerminal(t);
  delete piped.applyCompletion;
  piped.lang = new RTermLang({ extensionPath: "", rPath: "", env: {}, requestMemberCompletions });
  piped.applyKeyAction({ type: "text", text: '"file.csv" |> rdcsv' });
  const pipeChoices = () => piped.inlineCompletion.items.filter(item => "insertText" in item);
  await waitFor(() => pipeChoices().some(item => item.insertText === "read.csv()"), "fuzzy pipe function completion");
  piped.inlineCompletion.move(pipeChoices().findIndex(item => item.insertText === "read.csv()") - piped.inlineCompletion.selected);
  piped.applyKeyAction({ type: "tab" });
  assert.equal(piped.inputState.textBeforeCursor, '"file.csv" |> read.csv(');
  await waitFor(() => pipeChoices().some(item => item.detail === "parameter"), "arguments after accepting a piped function");
  piped.dismissInlineCompletion(false);
});

test("real LSP excludes supplied argument names while retaining signature order", { timeout: 90000 }, async t => {
  const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
  const { client } = createConsoleLsp(t);
  for (const [marked, first, excluded] of [
    ["library(package = , │)", "help", ["package"]],
    ["library(package = 'stats', │)", "help", ["package"]],
    ["base::library(package = , │)", "help", ["package"]],
    ["library(`package` = , │)", "help", ["package"]],
    ['library("package" = , │)', "help", ["package"]],
    ['library("\\u0070ackage" = , │)', "help", ["package"]],
    ["library(package = ,\n  │)", "help", ["package"]],
    ["library(package = , help = , │)", "pos", ["package", "help"]],
    ["library(│, package = )", "help", ["package"]],
    ["library(package = inner(help = 1), │)", "help", ["package"]],
    ["library(help = inner(package = 1), │)", "package", ["help"]],
    ["library(pack│)", "package", []],
    ["library(packages = , │)", undefined, ["package"]],
    ["stats::lm(data = , │)", "formula", ["data"]],
  ]) {
    const cursor = marked.indexOf("│");
    const text = marked.replace("│", "");
    const before = text.slice(0, cursor).split("\n");
    const result = await client.provideCompletionItems({ getText: () => text },
      { line: before.length - 1, character: before.at(-1).length });
    const parameters = (Array.isArray(result) ? result : result?.items ?? [])
      .filter(item => item.detail === "parameter").map(item => item.label);
    assert.equal(parameters[0], first, marked);
    for (const name of excluded) assert.ok(!parameters.includes(name), `${marked}: exclude ${name}`);
  }
});

test("real LSP validates positional, partial, quoted and piped argument candidates", { timeout: 90000 }, async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t);
  for (const [marked, expected] of [
    ["base::atan2(1, 2, │)", []],
    ["atan2(1, 2, │)", []],
    ["base::atan2(1, │)", ["y", "x"]],
    ["base::atan2(│, x = 2)", ["y"]],
    ["base::atan2(`x` = stop('must not run'), │)", ["y"]],
    ['base::atan2("x" = , │)', ["y"]],
    ['stats::cor(x = 1, y = 2, u = "everything", m = "pearson", │)', []],
    ['stats::cor(x = 1, y = 2, u = "everything", │)', ["method"]],
    ["1 |> base::atan2(2, │)", []],
    ["1 |> base::atan2(x = _, │)", ["y"]],
    ["1 |> base::atan2(│)", ["y", "x"]],
    ["base::sum(1, 2, │)", ["na.rm"]],
    ["base::sum(na = 1, │)", ["na.rm"]],
    ["base::sum(na.rm = TRUE, │)", []],
  ]) {
    const cursor = marked.indexOf("│");
    const text = marked.replace("│", "");
    const result = await client.provideCompletionItems({ getText: () => text }, { line: 0, character: cursor });
    const parameters = (Array.isArray(result) ? result : result?.items ?? [])
      .filter(item => item.detail === "parameter").map(item => item.label);
    assert.deepEqual(parameters, expected, marked);
  }
});

test("argument validation uses the local signature without evaluating defaults or bodies", { timeout: 90000 }, async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t);
  const definition = 'atan2 <- function(first, second = stop("default evaluated")) stop("body evaluated")\n';
  const parameters = async marked => {
    const text = definition + marked.replace("│", "");
    const result = await client.provideCompletionItems({ getText: () => text },
      { line: 1, character: marked.indexOf("│") });
    return (Array.isArray(result) ? result : result?.items ?? [])
      .filter(item => item.detail === "parameter").map(item => item.label);
  };
  // Local definitions become available after the server's document parse job.
  let initial;
  for (let attempt = 0; attempt < 100; attempt++) {
    initial = await parameters("atan2(│)");
    if (initial.includes("first")) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(initial, ["first", "second"]);
  for (const [marked, expected] of [
    ["atan2(1, 2, │)", []],
    ["atan2(fir = 1, │)", ["second"]],
    ["atan2(│, second = stop('argument evaluated'))", ["first"]],
    ["atan2(1, │)", ["first", "second"]],
  ]) assert.deepEqual(await parameters(marked), expected, marked);
});

test("local quoted formals retain unused arguments and reject supplied names", { timeout: 90000 }, async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t);
  const definition = 'f <- function(`a b`, `a\\`b`, normal = stop("default evaluated")) stop("body evaluated")\n';
  const parameters = async marked => {
    const text = definition + marked.replace("│", "");
    const result = await client.provideCompletionItems({ getText: () => text },
      { line: 1, character: marked.indexOf("│") });
    return (result.items ?? result).filter(item => item.detail === "parameter").map(item => item.insertText);
  };
  let initial;
  for (let attempt = 0; attempt < 100; attempt++) {
    initial = await parameters("f(│)");
    if (initial.includes("normal = ")) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(initial, ["`a b` = ", "`a\\`b` = ", "normal = "]);
  for (const marked of ['f(`a b` = 1, `a\\`b` = 2, │)',
    'f("a b" = 1, "a`b" = 2, │)', 'f(r"(a b)" = 1, `a\\`b` = 2, │)']) {
    assert.deepEqual(await parameters(marked), ["normal = "], marked);
  }
  assert.deepEqual(await parameters("f(1, 2, 3, │)"), []);
  assert.deepEqual(await parameters("f(│, normal = 1)"), ["`a b` = ", "`a\\`b` = "]);
});

test("unfinished multiline definitions complete immediately without executing or changing input", { timeout: 90000 }, async t => {
  const { client, instances } = require("./helpers/console-lsp.cjs").createConsoleLsp(t);
  const cases = [
    ['{\n  g <- function(`a b`, normal) NULL\n  g(`a b` = 1, │', ["normal"]],
    ['{\n  g <- function(`a b`, renamed) NULL\n  g(`a b` = 1, │', ["renamed"]],
    ['{\n  g <- function(`a b`, renamed) NULL\n  g(`a b` = 1, │)\n}', ["renamed"]],
    ['{\n  g <- function(`a b`, normal) stop("body evaluated")\n  g(`a b` = 1, │ # misleading ) }', ["normal"]],
    ['g <- function(`a b`, normal = stop("default evaluated")) NULL\ng(`a b` = 1, │', ["normal"]],
    ['{\n  g <- function(`a b`, normal) NULL\n  g(│', ["`a b`", "normal"]],
    ['{\n  g <- function(`a b`, normal) NULL\n  g(`a b` = 1, normal = 2, │', []],
    ['{\n  g(`a b` = 1, │', []],
  ];
  for (const [marked, expected] of cases) {
    const text = marked.replace("│", "");
    const before = marked.slice(0, marked.indexOf("│"));
    const position = { line: before.split("\n").length - 1, character: before.split("\n").at(-1).length };
    // One request per edit: polling would conceal a stale asynchronous parse.
    const result = await client.provideCompletionItems({ getText: () => text }, position);
    assert.deepEqual((result.items ?? result).filter(item => item.detail === "parameter").map(item => item.label), expected, marked);
    const request = instances.at(-1).requests.at(-1);
    assert.deepEqual({ ...request.params.position }, position);
    assert.equal([...client.syncedDocuments.values()].at(-1).document.getText(), text);
  }

  const provide = client.provideCompletionItems.bind(client);
  client.provideCompletionItems = async (...args) => {
    const result = await provide(...args);
    return { items: (result.items ?? result).map(item => ({ ...item,
      kind: item.kind === undefined ? undefined : item.kind - 1 })), isIncomplete: result.isIncomplete };
  };
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      Uri: { parse: value => ({ toString: () => value }) },
      CompletionItemKind: { Text: 0, Function: 2, Variable: 5, Snippet: 14 },
      QuickPickItemKind: { Separator: -1 }, SnippetString: class {},
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class { constructor() { return client; } } },
  });
  const { terminal } = require("./helpers/inline-terminal.cjs").createTerminal(t);
  delete terminal.applyCompletion;
  terminal.lang = new RTermLang({ extensionPath: "", rPath: "", env: {},
    requestMemberCompletions: async () => { assert.fail("unsubmitted definitions must not query the runtime"); } });
  const input = cases[0][0].replace("│", "");
  terminal.applyKeyAction({ type: "text", text: input });
  const choices = () => terminal.inlineCompletion.items.filter(item => "insertText" in item);
  const deadline = Date.now() + 10000;
  while (!choices().some(item => item.insertText === "normal = ")) {
    assert.ok(Date.now() < deadline, "unfinished block must automatically show normal = ");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(terminal.inputState.text, input, "parse-only delimiters must not enter the console");
  assert.deepEqual(choices().filter(item => item.detail === "parameter").map(item => item.insertText), ["normal = "]);
  terminal.applyKeyAction({ type: "tab" });
  assert.equal(terminal.inputState.text, input + "normal = ");
  assert.equal(terminal.inputState.textBeforeCursor, input + "normal = ");
  assert.equal(terminal.submitted, undefined);
});

test("current source signatures supersede older session definitions, including empty results", { timeout: 90000 }, async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t);
  const provider = {
    getCallContext: client.getCallContext.bind(client),
    provideCompletionItems: async (...args) => {
      const result = await client.provideCompletionItems(...args);
      return { ...result, items: (result.items ?? result).map(item => ({ ...item,
        kind: item.kind === undefined ? undefined : item.kind - 1 })) };
    },
  };
  const session = { globalenv: { f: { type: "closure" } } };
  const request = async expression => runRJson(`
    f <- function(old_arg = "old_value") stop("body evaluated")
    value <- eval(parse(text = inputs), .GlobalEnv)
    cat(jsonlite::toJSON(lapply(names(value), function(n) list(name = n)), auto_unbox = TRUE))
  `, expression);
  for (const [marked, expected] of [
    ["{\n f <- function(new_arg) NULL\n f(│", ["new_arg"]],
    ["f <- function(new_arg) NULL\nf(│)", ["new_arg"]],
    ["{\n f <- function(new_argument) NULL\n f(nwrg│", ["new_argument"]],
    ["{\n f <- function(new_arg) NULL\n f(zzzz│", []],
    ["{\n f <- function(new_arg) NULL\n f(new_arg = 1, │", []],
    ["{\n f <- function() NULL\n f(│", []],
    ["{\n f <- function(...) NULL\n f(│", []],
    ['{\n f <- function(new_arg = stop("default evaluated")) stop("body evaluated")\n f(│', ["new_arg"]],
    ["{\n f <- function(`new arg`) NULL\n f(│", ["`new arg`"]],
    ['{\n f <- function(new_arg) NULL\n f(old_arg = "│")', []],
    ["f(│", ["old_arg"]],
    ["{\n g <- function(new_arg) NULL\n f(│", ["old_arg"]],
  ]) {
    const text = marked.replace("│", "");
    const before = marked.slice(0, marked.indexOf("│"));
    const lines = text.split("\n");
    const position = { line: before.split("\n").length - 1, character: before.split("\n").at(-1).length };
    const context = completion.getCompletionContext(lines[position.line], position.character, before,
      text.slice(before.length));
    const entries = await completion.collectCompletionEntries(context, { getText: () => text }, position,
      session, lines.slice(0, position.line), [], provider, request);
    assert.deepEqual(entries.filter(item => item.detail === "parameter").map(item => item.label), expected, marked);
    assert.ok(!entries.some(item => item.label === "old_value"), marked);
  }
});

test("accepting a console-defined function opens its live arguments and values", { timeout: 90000 }, async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t);
  const provide = client.provideCompletionItems.bind(client);
  client.provideCompletionItems = async (...args) => {
    const result = await provide(...args);
    return { items: (result.items ?? result).map(item => ({ ...item,
      kind: item.kind === undefined ? undefined : item.kind - 1 })), isIncomplete: result.isIncomplete };
  };
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      CompletionItemKind: { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Value: 11, Snippet: 14 },
      QuickPickItemKind: { Separator: -1 }, SnippetString: class {},
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class { constructor() { return client; } } },
  });
  // The definition lives only in the active-session probe, never in the LSP
  // document. Its snapshot is the same metadata the session watcher supplies.
  const setup = 'f <- function(`a b`, normal = c("first", "second"), lazy = stop("default evaluated")) stop("body evaluated")\n';
  const session = runRJson(setup + 'cat(jsonlite::toJSON(list(globalenv = list(f = list(type = typeof(f)))), auto_unbox = TRUE))');
  let probes = 0;
  const lang = new RTermLang({ extensionPath: "", rPath: "", env: {},
    requestMemberCompletions: async expression => {
      probes++;
      return runRJson(setup + `
        value <- eval(parse(text = inputs), .GlobalEnv)
        cat(jsonlite::toJSON(lapply(names(value), function(n) list(name = n)), auto_unbox = TRUE))
      `, expression);
    },
  });
  t.after(() => lang.dispose());
  const handleAutocomplete = lang.handleAutocomplete.bind(lang);
  lang.handleAutocomplete = request => handleAutocomplete({ ...request, getWorkspaceData: () => session });
  const { terminal } = require("./helpers/inline-terminal.cjs").createTerminal(t);
  delete terminal.applyCompletion;
  terminal.lang = lang;
  const choices = () => terminal.inlineCompletion.items.filter(item => "insertText" in item);
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, message);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  terminal.applyKeyAction({ type: "text", text: "f" });
  terminal.applyKeyAction({ type: "tab" });
  await waitFor(() => choices().some(item => item.insertText === "f()"), "session function completion");
  terminal.inlineCompletion.move(choices().findIndex(item => item.insertText === "f()") - terminal.inlineCompletion.selected);
  terminal.applyKeyAction({ type: "tab" });
  assert.equal(terminal.inputState.textBeforeCursor, "f(");
  await waitFor(() => choices().some(item => item.insertText === "normal = "), "live function arguments");
  assert.deepEqual(choices().filter(item => item.detail === "parameter").map(item => item.insertText),
    ["`a b` = ", "normal = ", "lazy = "]);
  terminal.applyKeyAction({ type: "tab" });
  assert.equal(terminal.inputState.textBeforeCursor, "f(`a b` = ");
  terminal.applyKeyAction({ type: "text", text: "1, " });
  await waitFor(() => choices().some(item => item.insertText === "normal = "), "remaining arguments");
  assert.deepEqual(choices().filter(item => item.detail === "parameter").map(item => item.insertText),
    ["normal = ", "lazy = "]);
  terminal.applyKeyAction({ type: "tab" });
  await waitFor(() => choices().some(item => item.insertText === '"second"'), "live default values");
  assert.ok(probes >= 3);
  assert.equal(terminal.submitted, undefined, "completion must never execute the function");
});

test("qualified namespace arguments use the real LSP despite a same-name local function", { timeout: 90000 }, async t => {
  const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
  const { complete } = createConsoleLsp(t);
  for (const operator of ["::", ":::"]) {
    const input = `lm <- function(wrong_argument) {}; stats${operator}lm(`;
    const context = completion.getCompletionContext(input, input.length);
    let runtimeRequests = 0;
    const entries = await completion.collectCompletionEntries(context, { getText: () => input },
      { line: 0, character: input.length }, undefined, [], [], {
        provideCompletionItems: async doc => (await complete(doc.getText())).map(item => ({
          ...item, kind: item.kind === undefined ? undefined : item.kind - 1,
        })),
      }, async () => { runtimeRequests++; return []; });
    assert.equal(runtimeRequests, 0, "namespace calls must not request session formals");
    const parameters = entries.filter(entry => entry.detail === "parameter").map(entry => entry.label);
    assert.ok(parameters.includes("formula"));
    assert.ok(parameters.includes("data"));
    assert.ok(!parameters.includes("wrong_argument"));
  }
});

test("an explicitly selected package function retains its signature over a session namesake", { timeout: 90000 }, async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t);
  const input = "lm()";
  client.updateInput(input);
  client.recordCompletion(input, 0, { insertText: "lm()", source: "lsp", packageName: "stats" });
  const entries = await completion.collectCompletionEntries(completion.getCompletionContext(input, 3),
    { getText: () => input }, { line: 0, character: 3 },
    { globalenv: { lm: { type: "closure" } } }, [], [], {
      getCallContext: client.getCallContext.bind(client),
      provideCompletionItems: async (...args) => {
        const result = await client.provideCompletionItems(...args);
        return (result.items ?? result).map(item => ({ ...item, kind: item.kind - 1 }));
      },
    }, async () => { assert.fail("selected package must not query the session namesake"); });
  assert.deepEqual(entries.filter(item => item.detail === "parameter").slice(0, 4).map(item => item.label),
    ["formula", "data", "subset", "weights"]);
});

test("multiline arguments use parsed call identities and selected packages in the real LSP", { timeout: 90000 }, async t => {
  const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
  const { client } = createConsoleLsp(t);
  for (const [input, parameter, selectedPackage] of [
    ["filter <- function(wrong_argument) {}; outer(filter # keep selected package\n())", "sides", "stats"],
    ["lm <- function(wrong_argument) {}; outer(stats::lm # comment\n())", "formula"],
    ["lm <- function(wrong_argument) {}; outer(stats:::lm\n())", "formula"],
    ["lm <- function(wrong_argument) {}; outer(stats::\nlm # continuation\n())", "formula"],
    ["lm <- function(wrong_argument) {}; outer(stats\n::lm # continuation\n())", "formula"],
    ["lm <- function(wrong_argument) {}; outer(`stats` # package\n::: # accessor\n`lm`\n())", "formula"],
    ["local_fn <- function(local_arg) {}; outer(local_fn # comment\n())", "local_arg"],
  ]) {
    client.updateInput("");
    client.updateInput(input);
    if (selectedPackage) {
      client.recordCompletion(input, input.lastIndexOf("filter"), { insertText: "filter", packageName: selectedPackage });
    }
    const cursor = input.lastIndexOf("(") + 1;
    const before = input.slice(0, cursor);
    const linesBefore = before.split("\n");
    const row = linesBefore.length - 1;
    const column = linesBefore.at(-1).length;
    const context = completion.getCompletionContext(input.split("\n")[row], column, before, input.slice(cursor));
    let parameters = [];
    const deadline = Date.now() + 10000;
    do {
      const entries = await completion.collectCompletionEntries(context, { getText: () => input },
        { line: row, character: column }, undefined, linesBefore.slice(0, -1), [], {
          provideCompletionItems: async (doc, position, trigger) => {
            const result = await client.provideCompletionItems(doc, position, trigger);
            return (Array.isArray(result) ? result : result?.items ?? []).map(item => ({
              ...item, kind: item.kind === undefined ? undefined : item.kind - 1,
            }));
          },
        });
      parameters = entries.filter(entry => entry.detail === "parameter").map(entry => entry.label);
      if (parameters.includes(parameter)) break;
      // Local definitions become available when languageserver's asynchronous
      // parser finishes. This also applies to ordinary single-line calls.
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.ok(parameters.includes(parameter), input);
    assert.ok(!parameters.includes("wrong_argument"), input);
  }
});

test("multiline fuzzy arguments retain call identity and the original replacement span", { timeout: 90000 }, async t => {
  const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
  const { client, instances } = createConsoleLsp(t);
  for (const [head, prefix, parameter, selectedPackage] of [
    ["stats::lm", "sgk", "singular.ok"],
    ["stats:::lm", "sgk", "singular.ok"],
    ["lm", "sgk", "singular.ok", "stats"],
    ["local_fn", "zzlprzz", "zzlocal_parameterzz"],
  ]) {
    const input = `local_fn <- function(zzlocal_parameterzz) {}; outer(${head} # continuation\n(${prefix}))`;
    client.updateInput("");
    client.updateInput(input);
    if (selectedPackage) {
      client.recordCompletion(input, input.lastIndexOf(head), { insertText: head, packageName: selectedPackage });
    }
    const column = 1 + prefix.length;
    const before = input.slice(0, input.lastIndexOf("\n") + 1 + column);
    const context = completion.getCompletionContext(input.split("\n")[1], column, before, "))");
    let entry;
    const deadline = Date.now() + 10000;
    do {
      const entries = await completion.collectCompletionEntries(context, { getText: () => input },
        { line: 1, character: column }, undefined, [input.split("\n")[0]], [], {
          provideCompletionItems: async (...args) => {
            const result = await client.provideCompletionItems(...args);
            return (Array.isArray(result) ? result : result?.items ?? []).map(item => ({
              ...item, kind: item.kind === undefined ? undefined : item.kind - 1,
            }));
          },
        });
      entry = entries.find(item => item.label === parameter && item.detail === "parameter");
      if (entry) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.ok(entry, input);
    const pick = completion.toCompletionPick(entry, context);
    assert.equal(pick.replaceStart, 1, input);
    assert.equal(pick.snapshotCursor, column, input);
    assert.equal(pick.insertText, `${parameter} = `, input);
    const requests = instances.at(-1).requests.filter(request => request.params?.position).slice(-2);
    assert.equal(requests[0].params.position.character, column);
    assert.equal(requests[1].params.position.character, 2);
    assert.equal(requests[1].params.rConsoleCall, requests[0].params.rConsoleCall);
    assert.ok(requests[1].params.rConsoleCall);
  }
});

test("Unicode call identity never substitutes a same-suffix global function", { timeout: 90000 }, async t => {
  const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
  const { client, instances } = createConsoleLsp(t);
  const names = ["élm", "𐐀lm", "`𐐀lm`"];
  // R's acceptance of unquoted Unicode names depends on its native parser.
  // Quoted names must work everywhere; rejected names must never become lm.
  const validNames = runRJson(`
    cat(jsonlite::toJSON(lapply(inputs, function(name)
      tryCatch(is.symbol(parse(text = name)[[1L]]), error = function(e) FALSE)), auto_unbox = TRUE))
  `, names);
  assert.equal(validNames[0], true, "R must accept the accented name");
  assert.equal(validNames[2], true, "R must accept the quoted supplementary name");
  for (const [index, name] of names.entries()) {
    const input = `${name} <- function(correct_argument) {}; outer(${name}\n())`;
    const position = { line: 1, character: 1 };
    let parameters;
    const deadline = Date.now() + 10000;
    do {
      const result = await client.provideCompletionItems({ getText: () => input }, position);
      parameters = (Array.isArray(result) ? result : result?.items ?? [])
        .filter(item => item.detail === "parameter").map(item => item.label);
      if (validNames[index] ? parameters.includes("correct_argument") : parameters.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.deepEqual(parameters, validNames[index] ? ["correct_argument"] : [], input);
    assert.equal(instances.at(-1).requests.at(-1).params.rConsoleCall, name);
  }
  // Exercise parse rejection on every platform, even where unquoted
  // supplementary characters are accepted by R.
  const instance = instances.at(-1);
  const result = await instance.sendRequest("textDocument/completion", {
    ...instance.requests.at(-1).params, rConsoleCall: "not a valid name",
  });
  assert.ok(result.items.every(item => item.detail !== "parameter" && !item.detail?.startsWith("value for ")));
});

test("fuzzy fallback does not turn values, comments or member calls into LSP argument positions", { timeout: 90000 }, async t => {
  const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
  const { client, instances } = createConsoleLsp(t);
  for (const [head, tail] of [
    ["stats::lm", "method = sgk"],
    ["stats::lm", '"sgk"'],
    ["stats::lm", "# sgk\n"],
    ["obj$lm", "sgk"],
  ]) {
    const input = `outer(${head} # continuation\n(${tail}))`;
    const cursor = input.indexOf("sgk") + 3;
    const before = input.slice(0, cursor);
    const column = before.split("\n").at(-1).length;
    const context = completion.getCompletionContext(input.split("\n")[1], column, before, input.slice(cursor));
    const entries = await completion.collectCompletionEntries(context, { getText: () => input },
      { line: 1, character: column }, undefined, [input.split("\n")[0]], [], {
        provideCompletionItems: async (...args) => {
          const result = await client.provideCompletionItems(...args);
          return (Array.isArray(result) ? result : result?.items ?? []).map(item => ({
            ...item, kind: item.kind === undefined ? undefined : item.kind - 1,
          }));
        },
      });
    const requests = instances.at(-1).requests.filter(request => request.params?.position).slice(-2);
    assert.equal(requests[0].params.position.character, column, input);
    assert.equal(requests[1].params.position.character, column - 2, input);
    if (tail.startsWith("method =")) {
      assert.ok(requests.every(request => request.params.rConsoleCall === head && request.params.rConsoleArgument === "method"), input);
    } else {
      assert.ok(requests.every(request => request.params.rConsoleCall === undefined), input);
    }
    assert.ok(entries.every(entry => entry.detail !== "parameter"), input);
  }
});

test("member argument probe inspects the actual R callable without executing bodies or defaults", async () => {
  const setup = `
    lm <- function(wrong_argument) NULL
    obj <- list(lm = function(list_argument, missing, lazy = stop("default evaluated"), ...) stop("body called"),
                primitive = sum, empty = function() NULL, field = 1,
                quoted = function(\`a b\`, remaining) stop("body called"),
                dots = function(first, ..., after) stop("body called"),
                positional = function(first, second, third) stop("body called"))
    methods::setClass("CompletionTest", slots = c(lm = "function"))
    slot_obj <- methods::new("CompletionTest", lm = function(slot_argument) stop("body called"))
    éobj <- list(lm = function(correct_argument) stop("body called"))
    obj$élm <- function(correct_argument) stop("body called")
    \`𐐀obj\` <- list(lm = function(correct_argument) stop("body called"))
    obj$unicode <- function(éarg, \`𐐀arg\`, remaining) stop("body called")
    obj$pair <- function(first, second) stop("body called")
    .args <- .fn <- "unchanged"
  `;
  for (const [expression, expected, argumentsBefore = "", argumentsAfter = ""] of [
    ["obj$lm", ["list_argument", "missing", "lazy"]],
    ["éobj$lm", ["correct_argument"]],
    ["obj$élm", ["correct_argument"]],
    ["`𐐀obj`$lm", ["correct_argument"]],
    ["obj$unicode", ["remaining"], 'éarg = stop("value evaluated"), `𐐀arg` = stop("value evaluated"), '],
    ["obj$pair", ["second"], "se", ', stop("value evaluated"))'],
    ["obj$pair", ["first", "second"], "", ', stop("value evaluated"))'],
    ["obj$pair", ["first", "second"], 'stop("value evaluated"), '],
    ["slot_obj@lm", ["slot_argument"]],
    ["obj$primitive", ["na.rm"]],
    ["obj$empty", []], ["obj$field", []], ["unavailable$lm", []],
    ["obj$lm", ["missing", "lazy"], 'list_argument = stop("value evaluated"), '],
    ["obj$lm", ["list_argument", "missing", "lazy"], 'li = stop("value evaluated"), '],
    ["obj$lm", ["list_argument", "missing", "lazy"], 'stop("value evaluated"), '],
    ["obj$lm", ["list_argument", "missing", "lazy"], ', '],
    ["obj$lm", ["list_argument", "missing"], 'lazy = stop("value evaluated"), stop("value evaluated"), '],
    ["obj$lm", ["list_argument", "lazy"], '', ', missing = stop("value evaluated"))'],
    ["obj$lm", [], 'list_argument = 1, li'],
    ["obj$quoted", ["remaining"], '`a b` = stop("value evaluated"), '],
    ["obj$quoted", ["remaining"], '"a b" = stop("value evaluated"), '],
    ["obj$quoted", ["remaining"], 'r"---(a b)---" = stop("value evaluated"), '],
    ["obj$positional", ["first", "second"], 'r"(third)" = stop("value evaluated"), '],
    ["obj$dots", ["first", "after"], '1, 2, '],
    ["obj$dots", ["first", "after"], 'af = 1, '],
    ["obj$dots", ["first"], 'after = 1, '],
    ["obj$primitive", [], 'na.rm = TRUE, '],
    ["obj$positional", ["first"], 'fi', ', stop("value evaluated"))'],
    ["obj$positional", ["first", "second", "third"], '', ', stop("value evaluated"))'],
    ["obj$positional", ["second"], 'stop("value evaluated"), se', ', stop("value evaluated"))'],
    ["obj$positional", ["second", "third"], 'first = stop("value evaluated"), ', ', stop("value evaluated"))'],
    ["obj$positional", ["first", "second"], '', ', , third = stop("value evaluated"))'],
    ["obj$positional", ["second", "third"], '', ', fir = stop("value evaluated"), stop("value evaluated"))'],
    ["obj$positional", [], '1, 2, 3, '],
    ["obj$dots", ["first", "after"], '', ', 1, 2)'],
    ["obj$dots", ["first", "after"], '1, ', ', 2)'],
    ["(obj\n$positional", ["first"], 'fi', ', 2))'],
    ["obj$ # continuation\npositional", ["first"], 'fi', ', 2)'],
    ["stop('pipe evaluated') |> obj$positional", ["first", "second", "third"]],
    ["1 |> obj$positional", ["first", "second", "third"], '2, '],
    ["1 |> obj$positional", [], 'fi', ', second = 2, third = 3)'],
    ["1 |> obj$positional", ["first", "second"], '', ', third = 3)'],
    ["1 |> obj$positional", ["first", "third"], 'second = _, '],
    ["1 |> obj$positional", ["first", "second"], '', ', third = _)'],
    ["1 |> obj$positional", ["first", "second"], 'r"(third)" = _, '],
    ["1 |> obj$positional", ["first", "second", "third"], '2 |> identity(x = _), '],
    ["stop('pipe evaluated') %>% obj$positional", ["first", "second", "third"]],
    ["1 %>% obj$positional", ["first", "third"], 'second = ., '],
    ["1 %>% obj$positional", ["first", "second", "third"], 'identity(.), '],
    ["1 %>% obj$positional", ["first", "second", "third"], '., '],
  ]) {
    const input = expression + "(" + argumentsBefore + argumentsAfter;
    const context = completion.getCompletionContext(input, input.length - argumentsAfter.length);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [],
      undefined, async (probe, operator) => {
        assert.equal(operator, "$");
        // This is the existing session completion contract: evaluate the
        // expression in R, then return its named list members.
        return runRJson(setup + `
          options(warn = 2, warnPartialMatchArgs = TRUE)
          value <- tryCatch(eval(parse(text = inputs), .GlobalEnv), error = function(e) NULL)
          stopifnot(identical(.args, "unchanged"), identical(.fn, "unchanged"))
          cat(jsonlite::toJSON(lapply(names(value), function(n) list(name = n)), auto_unbox = TRUE))
        `, probe);
      });
    assert.deepEqual(entries.map(entry => entry.label), expected, input);
  }
});

test("completion call boundaries agree with the R parser across newlines", async () => {
  const cases = [
    ["obj$fun\n(fi)", false],
    ["obj$fun # end of statement\n(fi)", false],
    ["{ obj$fun\n(fi) }", false],
    ["outer({ obj$fun\n(fi) })", false],
    ["(obj$fun\n(fi))", true],
    ["outer(obj$fun # continuation\n(fi))", true],
    ["x[obj$fun\n(fi)]", true],
    ["obj$ # member continuation\nfun(fi)", true],
    ["(obj\n$fun(fi))", true],
  ];
  const nativeCalls = runRJson(`
    has_call <- function(x) {
      if (!(is.call(x) || is.expression(x))) return(FALSE)
      if (is.call(x) && identical(x[[1]], quote(obj$fun))) return(TRUE)
      any(vapply(as.list(x), has_call, logical(1)))
    }
    cat(jsonlite::toJSON(vapply(inputs, function(input) has_call(parse(text = input)), logical(1))))
  `, cases.map(([input]) => input));
  for (const [index, [input, expected]] of cases.entries()) {
    assert.equal(nativeCalls[index], expected, input);
    const cursor = input.indexOf("fi") + 2;
    const before = input.slice(0, cursor);
    const row = before.split("\n").length - 1;
    const context = completion.getCompletionContext(input.split("\n")[row],
      before.split("\n").at(-1).length, before, input.slice(cursor));
    assert.equal(context.kind === "argument", expected, input);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [], undefined,
      async () => [{ name: "first" }]);
    assert.equal(entries.some(entry => entry.detail === "parameter"), expected, input);
  }
});

test("argument probes agree with native R calls across pipe and argument combinations", async () => {
  const cases = [];
  const probes = [];
  for (const pipe of ["", "1 |> ", "1 %>% "]) {
    for (const fn of ["positional", "dots", "return", "toString", "constructor"]) {
      const argumentsList = [
        "§", "1, §", "first = 1, §", "fi = 1, §", "§, third = 3",
        "third = 3, §", 'r"(third)" = 3, §', "§, 2", "1, §, 3",
        "§, , third = 3", "first = 1, second = 2, third = 3, §",
        "1, 2, §", "after = 1, §", "af = 1, §",
      ];
      if (pipe === "1 |> ") argumentsList.push("third = _, §", "§, second = _", "2 |> identity(x = _), §");
      if (pipe === "1 %>% ") argumentsList.push("third = ., §", "§, second = .", "identity(.), §", "., §");
      for (const args of argumentsList) {
        const marked = `${pipe}obj$${fn}(${args})`;
        const cursor = marked.indexOf("§");
        const input = marked.replace("§", "");
        let probe;
        await completion.collectCompletionEntries(completion.getCompletionContext(input, cursor),
          undefined, undefined, undefined, [], [], undefined, async expression => {
            probe = expression;
            return [];
          });
        assert.ok(probe, marked);
        cases.push({ call: marked, fn });
        probes.push(probe);
      }
    }
  }
  // Evaluate harmless test functions whose bodies only return match.call().
  // Insert each candidate by name into the original source and let R and
  // magrittr match it. A positional cursor marker would hide the very argument
  // rematching this test must exercise.
  const results = runRJson(`
    library(magrittr)
    capture <- function(call, definition) {
      values <- as.list(call)
      # Explicit empty slots still occupy positions in the editable source.
      for (i in seq_along(values)[-1L]) {
        if (identical(values[[i]], quote(expr = ))) values[i] <- list(NULL)
      }
      match.call(definition, as.call(values), expand.dots = FALSE)
    }
    obj <- list(
      positional = function(first, second, third) capture(sys.call(), sys.function()),
      dots = function(first, ..., after) capture(sys.call(), sys.function()),
      return = function(first, second, third) capture(sys.call(), sys.function()),
      toString = function(first, second, third) capture(sys.call(), sys.function()),
      constructor = function(first, second, third) capture(sys.call(), sys.function()))
    result <- lapply(seq_along(inputs$cases), function(i) {
      case <- inputs$cases[[i]]
      candidates <- setdiff(names(formals(obj[[case$fn]])), "...")
      expected <- candidates[vapply(candidates, function(name) {
        call <- sub("§", paste0(name, " = .cursor_marker"), case$call, fixed = TRUE)
        tryCatch({ eval(parse(text = call)); TRUE }, error = function(e) FALSE)
      }, logical(1))]
      actual <- tryCatch(setdiff(names(eval(parse(text = inputs$probes[[i]]))), "..."), error = function(e) character())
      list(expected = as.list(expected), actual = as.list(actual))
    })
    cat(jsonlite::toJSON(result, auto_unbox = TRUE))
  `, { cases, probes });
  assert.equal(results.length, cases.length);
  for (const [index, result] of results.entries()) {
    assert.deepEqual(result.actual, result.expected, cases[index].call);
  }
});

function lspConnection(socket) {
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  const pending = new Map();
  const fail = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) break;
      const headers = buffer.subarray(0, end).toString("ascii");
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(headers);
      if (!match) {
        fail(new Error("Invalid LSP headers: " + headers));
        socket.destroy();
        return;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length > 8 * 1024 * 1024) {
        fail(new Error("Invalid LSP message length"));
        socket.destroy();
        return;
      }
      if (buffer.length < end + 4 + length) break;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
      buffer = buffer.subarray(end + 4 + length);
      if (message.id === undefined) continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Language-server socket closed before LSP response")));

  function send(message) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    socket.write(Buffer.concat([
      Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"), body,
    ]));
  }

  return {
    notify(method, params) { send({ method, params }); },
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Timed out waiting for LSP response: " + method));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    },
  };
}

test("real console languageserver authenticates, initializes and completes code", { timeout: 90000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-lsp-integration-"));
  // Cleanup happens after the R process and sockets are closed (Windows holds cwd open).
  const file = path.join(directory, "completion.R");
  fs.writeFileSync(file, "stats::l\n");
  const workspaceUri = pathToFileURL(directory + path.sep).href;
  const uri = pathToFileURL(file).href;

  const token = randomBytes(32).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  const server = net.createServer();
  const sockets = new Set();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // Socket/server cleanup is coordinated with child shutdown below.

  let accept;
  let rejectConnection;
  const connected = new Promise((resolve, reject) => {
    accept = resolve;
    rejectConnection = reject;
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    void authenticateLspSocket(socket, token, BACKEND_AUTH_TIMEOUT_MS, nonce)
      .then((ok) => {
        if (!ok) throw new Error("Production R language-server authentication failed");
        const lsp = lspConnection(socket);
        socket.resume();
        accept(lsp);
      }).catch(rejectConnection);
  });

  const script = path.resolve(__dirname, "../resources/r/console-language-server.R");
  const child = spawn("Rscript", ["--vanilla", script], {
    cwd: directory,
    env: {
      ...process.env,
      VSCR_LSP_HOST: "127.0.0.1",
      VSCR_LSP_PORT: String(server.address().port),
      VSCR_LSP_AUTH_TOKEN: token,
      VSCR_LSP_CLIENT_NONCE: nonce,
      VSCR_LSP_AUTH_TIMEOUT_SECONDS: String(BACKEND_AUTH_TIMEOUT_MS / 1000),
      VSCR_USE_RENV_LIB_PATH: "FALSE",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const childClosed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await childClosed;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-12000); });
  const childFailed = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error("R languageserver exited before completing LSP test (" +
        (signal || code) + "):\n" + stderr));
    });
  });

  const lsp = await Promise.race([connected, childFailed]);
  const initialized = await lsp.request("initialize", {
    processId: process.pid,
    clientInfo: { name: "r-console-lsp-integration-test" },
    rootUri: workspaceUri,
    rootPath: directory,
    workspaceFolders: [{ uri: workspaceUri, name: "test-workspace" }],
    capabilities: {
      workspace: { workspaceFolders: true },
      textDocument: { completion: { completionItem: { snippetSupport: true } } },
    },
    trace: "off",
  });
  assert.ok(initialized && initialized.capabilities, "the real LSP initialize request must succeed");
  lsp.notify("initialized", {});
  const synced = await lsp.request("rConsole/syncSessionState", {
    attachedPackages: ["stats"],
    libraryPaths: [],
  });
  assert.equal(synced, true, "console-specific session synchronization must work");

  lsp.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "r", version: 1, text: "stats::l\n" },
  });
  const completions = await lsp.request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 0, character: 8 },
    context: { triggerKind: 1 },
  });
  const items = Array.isArray(completions) ? completions : completions?.items;
  assert.ok(Array.isArray(items) && items.some((item) => /(?:^|::)lm$/.test(item.label)),
    "the real language server must return stats::lm completion; got: " +
    JSON.stringify(items?.slice(0, 12)));

  await lsp.request("shutdown", null); // R languageserver may serialize a void response as [].
  lsp.notify("exit", null);
});

test("subscript options and adjacent nested closers preserve native R indexing", async () => {
  const setup = 'df <- data.frame(alpha = 1:2, beta = 3:4, row.names = c("row_one", "row_two")); cols <- 1:2;\n';
  for (const [marked, expected] of [
    ['df[[│, exact = TRUE]]', ['alpha', 'beta']],
    ['df[│, drop = FALSE]', ['alpha', 'beta']],
    ['df[drop = FALSE, │]', ['alpha', 'beta']],
    ['df[│, cols[1]]', ['row_one', 'row_two']],
    ['df[│, cols[[1]]]', ['row_one', 'row_two']],
    ['df[, │, drop = FALSE]', ['alpha', 'beta']],
  ]) {
    const text = marked.replace('│', ''), cursor = marked.indexOf('│');
    const context = completion.getCompletionContext(text, cursor);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [], undefined,
      async expression => runRJson(setup + 'x <- eval(parse(text = inputs)); cat(jsonlite::toJSON(lapply(names(x), function(n) list(name=n)), auto_unbox=TRUE))', expression));
    assert.deepEqual(entries.filter(item => item.kind === 4).map(item => item.label), expected, marked);
    const selected = entries.find(item => item.label === expected[0]);
    const code = text.slice(0, context.replaceStart) + selected.insertText + text.slice(cursor);
    assert.equal(runRJson(setup + 'invisible(suppressWarnings(eval(parse(text=inputs)))); cat("true")', code), true, code);
  }
});

test("partial argument values follow R matching in LSP and active-session probes", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  const provide = async (...args) => {
    const result = await client.provideCompletionItems(...args);
    return { ...result, items: (result.items ?? result).map(item => ({ ...item, kind: item.kind - 1 })) };
  };
  const definitions = 'f <- function(method = c("spearman", "pearson"), metric = "other") stop("body evaluated")\n';
  for (const runtime of [false, true]) {
    for (const [call, expected] of [
      ['f(meth = sp│)', ['spearman']], ['f(meth = "sp│")', ['spearman']],
      ['f(met = sp│)', []], ['f(metric = stop("argument evaluated"), met = sp│)', ['spearman']],
      ['f(method = "pearson", meth = sp│)', []],
    ]) {
      const marked = (runtime ? '' : definitions) + call;
      const text = marked.replace('│', ''), before = marked.split('│')[0], lines = text.split('\n');
      const position = { line: before.split('\n').length - 1, character: before.split('\n').at(-1).length };
      const context = completion.getCompletionContext(lines[position.line], position.character, before, text.slice(before.length));
      const entries = await completion.collectCompletionEntries(context, { getText: () => text }, position,
        runtime ? { globalenv: { f: { type: 'closure' } } } : undefined, lines.slice(0, position.line), [],
        { provideCompletionItems: provide }, async expression => runRJson(definitions +
          'x <- eval(parse(text=inputs)); cat(jsonlite::toJSON(lapply(names(x), function(n) list(name=n)), auto_unbox=TRUE))', expression));
      assert.deepEqual(entries.filter(item => item.detail?.startsWith('value for ')).map(item => item.label), expected,
        `${runtime ? 'runtime' : 'source'}: ${marked}`);
    }
  }
  const result = await client.provideCompletionItems({ getText: () => 'stats::cor(met = sp)' }, { line: 0, character: 'stats::cor(met = sp'.length });
  assert.ok(result.items.some(item => item.label === 'spearman'));
  for (const tag of ['met', 'method']) {
    const text = `f <- function(..., method = "spearman") NULL\nf(${tag} = "sp")`;
    const result = await client.provideCompletionItems({ getText: () => text }, { line: 1, character: `f(${tag} = "sp`.length });
    assert.equal(result.items.some(item => item.label === 'spearman'), tag === 'method', 'partial matching stops at dots');
  }
});

test("source redefinitions remain authoritative through wrappers, chains and lexical scopes", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  const provider = { provideCompletionItems: async (...args) => {
    const result = await client.provideCompletionItems(...args);
    return { ...result, items: result.items.map(item => ({ ...item, kind: item.kind - 1 })) };
  } };
  for (const [marked, expected] of [
    ['f <- (function(new_arg) NULL)\nf(│)', ['new_arg']],
    ['f <- g <- function(new_arg) NULL\nf(│)', ['new_arg']],
    ['(function(new_arg) NULL) -> f\nf(│)', ['new_arg']],
    ['f <- (function(new_arg = stop("default evaluated")) {\n stop("body evaluated")\n NULL\n})\nf(│)', ['new_arg']],
    ['f <- (function() NULL)\nf(│)', []],
    ['f <- (function() stop("must not execute"))()\nf(│)', []],
    ['f <- function(outer_arg) NULL\ng <- function() { f <- (function(inner_arg) NULL); f(│) }', ['inner_arg']],
    ['f <- function(outer_arg) NULL\ng <- function() { f <- (function(inner_arg) NULL) }; f(│)', ['outer_arg']],
    ['f <- function(earlier) NULL; f(│); f <- function(later) NULL', ['earlier']],
    ['f <- (function(method = c("new_value", "other")) NULL)\nf(meth = "new│")', ['new_value']],
  ]) {
    const text = marked.replace('│', ''), before = marked.split('│')[0], lines = text.split('\n');
    const position = { line: before.split('\n').length - 1, character: before.split('\n').at(-1).length };
    const context = completion.getCompletionContext(lines[position.line], position.character, before, text.slice(before.length));
    const entries = await completion.collectCompletionEntries(context, { getText: () => text }, position,
      { globalenv: { f: { type: 'closure' } } }, lines.slice(0, position.line), [], provider,
      async () => [{ name: 'old_arg' }]);
    assert.deepEqual(entries.filter(item => item.detail === 'parameter' || item.detail?.startsWith('value for '))
      .map(item => item.label), expected, marked);
  }
});

test("source-only pipe functions survive filtering and native-pipe parse recovery", { timeout: 90000 }, async t => {
  const { client, instances } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  for (const marked of [
    'my_frob <- function(x) x\n1 %>% my_fr│',
    'my_frob <- function(x) x\n1 |> my_fr│',
    '{\n my_frob <- function(x) x\n 1 |> my_fr│',
    '{\n my_frob <- function(x) x\n 1 |> my_fr│ }',
    '{\n my_frob <- function(x) x\n 1 |> my_f│rob }',
    'my_frob <- function(x) x\n1 |> my_fr│()',
    'my_frob <- function(x) x\n"😀" |> my_fr│',
    'my_frob <- function(x) x\n\t1 |> my_fr│',
    'my_frob <- function(x) x\n1 |> │',
  ]) {
    const text = marked.replace('│', ''), before = marked.split('│')[0], lines = text.split('\n');
    const position = { line: before.split('\n').length - 1, character: before.split('\n').at(-1).length };
    const doc = { getText: () => text, uri: client.inputDocument.uri };
    const context = completion.getCompletionContext(lines[position.line], position.character, before, text.slice(before.length));
    const entries = await completion.collectCompletionEntries(context, doc, position, undefined,
      lines.slice(0, position.line), [], { provideCompletionItems: async (...args) => {
        const result = await client.provideCompletionItems(...args);
        return { ...result, items: result.items.map(item => ({ ...item, kind: item.kind - 1 })) };
      } });
    assert.ok(entries.some(item => item.insertText === 'my_frob()'), marked);
    assert.equal([...client.syncedDocuments.values()].at(-1).document.getText(), text, 'repair stays out of the visible/LSP document');
    assert.ok(instances.at(-1).requests.at(-1).params.position.character <= lines[position.line].length);
  }
});

test("empty runtime values survive both session completion transports", async () => {
  const { SessProxy } = loadSource('src/Runtime/VSCR/sess/sessProxy.ts');
  const { SessionWatcher } = loadSource('src/Runtime/VSCR/legacy/sessionWatcher.ts');
  const setup = 'choose <- function(mode = c("", "auto", "value:literal")) stop("body evaluated")\n';
  const response = expression => runRJson(setup +
    'x <- eval(parse(text=inputs)); cat(jsonlite::toJSON(lapply(names(x), function(n) list(name=n)), auto_unbox=TRUE))', expression);
  const sess = Object.create(SessProxy.prototype);
  sess.request = async (_method, params) => response(params.expr);
  const legacy = Object.create(SessionWatcher.prototype);
  legacy.postToSessionServer = async params => response(params.expr);
  for (const transport of [sess, legacy]) {
    const text = 'choose(mode = )';
    const context = completion.getCompletionContext(text, text.length - 1);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      { globalenv: { choose: { type: 'closure' } } }, [], [], undefined,
      transport.requestMemberCompletions.bind(transport));
    const values = entries.filter(item => item.detail === 'value for mode');
    assert.deepEqual(values.map(item => item.insertText), ['""', '"auto"', '"value:literal"']);
    assert.ok(completion.toCompletionPick(values[0], context).label.endsWith('""'), 'empty choice has a visible label');
  }
});
