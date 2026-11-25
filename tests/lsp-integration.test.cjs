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
const { createGuardedBindingResolver } = loadSource("src/Language/completion/bindings.ts");
const { runRJson } = require("./helpers/run-r-json.cjs");
const { nativeStaticEvidence } = require("./helpers/native-static-evidence.cjs");
const { retryStaticCompletion, staticFixtureAccess, staticFixtureProvider, completeStatic } = require("./helpers/static-completion.cjs");
const { authenticateLspSocket } = loadSource("src/Language/lspSocketAuth.ts");
const { BACKEND_AUTH_TIMEOUT_MS } = loadSource("src/Runtime/backendAuthentication.ts");
const completion = loadSource("src/Language/completion.ts", { vscode: {
  CompletionItemKind: { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Value: 11, Snippet: 14 },
  SnippetString: class {},
  Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
} });

function collectStaticEntries(client, context, doc, position, session, lines, recent = [], requestRuntime) {
  return retryStaticCompletion(() => completion.collectCompletionEntries(context,
    { version: 1, uri: client.inputDocument.uri, ...doc }, position,
    session, lines, recent, staticFixtureProvider(client), requestRuntime, undefined, undefined, 'static', staticFixtureAccess()));
}

test("closing a virtual completion document cancels native tasks and answers pending requests", () => {
  assert.deepEqual(runRJson(String.raw`
    code <- parse("resources/r/console-language-server.R")
    definition <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) &&
        identical(node[[2L]], quote(console_text_document_did_close)), as.list(code))[[1L]]
    eval(definition)
    cancelled <- delivered <- integer()
    removed <- closed <- FALSE
    manager <- function(index) list(cancel = function(uri) { cancelled <<- c(cancelled, index) })
    ids <- c(101L, 102L)
    queue <- list(size = function() length(ids), pop = function() {
        id <- ids[[1L]]; ids <<- ids[-1L]; list(id = id)
    })
    document <- list(did_close = function() { closed <<- TRUE })
    workspace <- list(documents = list(has = function(uri) TRUE, get = function(uri) document,
        remove = function(uri) { removed <<- TRUE }), update_loaded_packages = function() NULL)
    self <- list(parse_task_manager = manager(1L), resolve_task_manager = manager(2L), member_task_manager = manager(3L),
        get_workspace = function(uri) workspace, deliver = function(reply) { delivered <<- c(delivered, reply$id) },
        pending_replies = list(get = function(...) list(queue), remove = function(uri) NULL))
    console_text_document_did_close(self, list(textDocument = list(uri = "r-console://cancel/console.R")))
    stopifnot(closed, removed, !length(ids))
    cat(jsonlite::toJSON(list(cancelled = cancelled, delivered = delivered)))
  `), { cancelled: [1, 2, 3], delivered: [101, 102] });
});

test("console supplements reuse native members, constructor signatures and package argument lookups", () => {
  const result = runRJson(String.raw`
    server <- list(request_handlers = list("textDocument/completion" = function(...) NULL))
    for (file in c("completion-runtime.R", "completion-arguments.R", "completion-static.R", "completion-provider.R"))
        source(file.path("resources/r", file))
    uri <- "r-console://reuse/console.R"
    point <- list(row = 0L, col = 0L)
    # A successful native member reply needs no second receiver analysis.
    document <- list(from_lsp_position = function(position) point)
    workspace <- list(documents = list(get = function(uri) document))
    self <- list(get_workspace = function(uri) workspace)
    member <- list(label = "secret", data = list(type = "member"))
    reply <- console_supplement_completion(list(result = list(items = list(member))), self,
        list(textDocument = list(uri = uri), position = list(line = 0L, character = 0L), rConsoleStaticAnalysis = TRUE))
    stopifnot(isTRUE(reply$result$rConsoleMemberResolved), identical(reply$result$items, list(member)))

    text <- "pkg::Factory$new("
    document <- languageserver:::Document$new(uri, language = "r", version = 1L, content = text)
    document$update_parse_data(languageserver:::parse_document(uri, text))
    console_member_function <- function(...) stop("duplicate receiver inspection")
    console_completion_parse <- function(...) stop("duplicate parse of complete input")
    signature <- 'new(cols, \x60a b\x60 = stop("defaults stay inert"), ...)'
    constructor <- list(label = "cols", kind = languageserver:::CompletionItemKind$Variable,
        data = list(type = "member", parameter = "cols", signature = signature))
    reply <- console_supplement_completion(list(result = list(items = list(constructor))), self,
        list(textDocument = list(uri = uri), position = list(line = 0L, character = nchar(text)),
            rConsoleStaticAnalysis = TRUE, rConsoleCall = "pkg::Factory$new", rConsoleArgumentTags = list(NULL),
            rConsoleParseSuffix = ""))
    stopifnot(isTRUE(reply$result$rConsoleArgumentsResolved), isTRUE(reply$result$rConsoleNativeArguments))
    names <- vapply(console_native_signature(list(constructor), uri), console_argument_name, character(1))
    stopifnot(identical(names, c("cols", "a b", "...")))

    # S3 arguments alone do not establish the identity of a member receiver.
    # They must never replace an explicit refusal from the runtime inspector.
    text <- "task$levels("
    document <- languageserver:::Document$new(uri, language = "r", version = 1L, content = text)
    document$update_parse_data(languageserver:::parse_document(uri, text))
    console_member_function <- function(...) NULL
    unrelated <- list(label = "wrong", kind = languageserver:::CompletionItemKind$Variable,
        data = list(type = "s3_parameter", parameter = "wrong", s3 = list(method = list(formals = list(wrong = NULL)))))
    refused <- console_supplement_completion(list(result = list(items = list(unrelated))), self,
        list(textDocument = list(uri = uri), position = list(line = 0L, character = nchar(text)),
            rConsoleStaticAnalysis = TRUE, rConsoleCall = "task$levels", rConsoleArgumentTags = list(NULL),
            rConsoleRuntimeArgumentsRefused = TRUE))
    stopifnot(identical(refused$result$rConsoleArgumentsResolved, FALSE), !length(refused$result$items),
        !isTRUE(refused$result$rConsoleRuntimeArgumentsIgnored))

    # Recovery of a lexer-selected call must share the full package signature
    # between prefix filtering and validation. Value lookup is a separate native API.
    calls <- 0L
    workspace$get_formals <- function(...) { calls <<- calls + 1L; list(cols = NULL, mode = quote(c("auto", "stream"))) }
    workspace$get_signature <- function(...) "target(cols, mode)"
    document <- list(from_lsp_position = function(position) point,
        detect_call = function(point) list(token = "other", accessor = "", package = NULL),
        detect_token = function(...) list(token = ""))
    reply <- console_supplement_completion(list(result = list(items = list())), self,
        list(textDocument = list(uri = uri), position = list(line = 0L, character = 0L),
            rConsoleCall = "pkg::target", rConsoleArgumentTags = list(NULL)))
    stopifnot(calls == 2L)
    labels <- vapply(reply$result$items, function(item) item$label, character(1))
    stopifnot(identical(labels, c("cols", "mode")))
    cat(jsonlite::toJSON(list(lookups = calls, parameters = names), auto_unbox = TRUE))
  `);
  assert.equal(result.lookups, 2);
  assert.deepEqual(result.parameters, ['cols', 'a b', '...']);
});

test("completion supplement failures never deliver unvalidated native candidates", () => {
  const result = runRJson(String.raw`
    native_result <- list(items = list(
        list(label = "wrong_member", data = list(type = "member")),
        list(label = "wrong_parameter", data = list(type = "s3_parameter", parameter = "wrong_parameter"))),
        isIncomplete = FALSE, rConsoleMemberResolved = TRUE, rConsoleArgumentsResolved = TRUE,
        rConsoleNativeArguments = TRUE)
    server <- list(request_handlers = list("textDocument/completion" = function(self, id, params) {
        self$deliver(structure(list(id = id, result = native_result), class = "Response"))
    }))
    source("resources/r/completion-provider.R")
    delivered <- NULL
    self <- list(get_workspace = function(uri) list(documents = list(get = function(uri) NULL)),
        deliver = function(reply) { delivered <<- reply })
    handler <- server$request_handlers[["textDocument/completion"]]
    params <- list(textDocument = list(uri = "r-console://failure/console.R"),
        position = list(line = 0L, character = 0L))
    verify <- function(extra, reason) {
        request <- c(params, extra)
        handler(self, 1L, request)
        result <- delivered$result
        stopifnot(identical(delivered$id, 1L), !length(result$items),
            isTRUE(result$isIncomplete), identical(result$rConsoleMemberResolved, FALSE),
            identical(result$rConsoleArgumentsResolved, FALSE),
            identical(result$rConsoleRuntimeOnly, !isTRUE(request$rConsoleStaticAnalysis)),
            identical(result$rConsoleStaticUnavailableReason, reason),
            is.null(result$rConsoleNativeArguments))
    }
    # Losing the document is also a failure to establish provenance.
    verify(list(rConsoleStaticAnalysis = TRUE, rConsoleOpaqueFunction = "api"), "document-unavailable")
    # Exercise the actual delivery proxy, not just the supplement helper.
    console_supplement_completion <- function(...) stop("injected validation failure")
    cases <- list(
        list(rConsoleStaticAnalysis = TRUE, rConsoleOpaqueFunction = "api"),
        list(rConsoleStaticAnalysis = TRUE, rConsoleCall = "api$scan", rConsoleRuntimeArgumentsRefused = TRUE),
        list(rConsoleCall = "api$scan", rConsoleRuntimeArgumentsRefused = TRUE),
        list(rConsoleCall = "api$scan", rConsoleRuntimeArgumentNames = list("live")),
        list(rConsoleCall = "f", rConsoleRuntimeSignature = "function(live) NULL"),
        list(rConsoleSubscriptClass = "data.frame"), list())
    for (extra in cases) verify(extra, "request-failed")
    # Successful validation still delivers its result unchanged.
    console_supplement_completion <- function(reply, self, params) reply
    handler(self, 2L, params)
    stopifnot(identical(delivered$result, native_result), identical(delivered$id, 2L))
    cat(jsonlite::toJSON(list(failures = length(cases) + 1L), auto_unbox = TRUE))
  `);
  assert.equal(result.failures, 8);
});

test("accepting a column completion inserts R source that selects the original field", async () => {
  const names = ["total\rUSD", "total\\rUSD", "total\nUSD", "total\tUSD", "total\u0085USD", "total'\"\x7f`USD"];
  const workspace = { globalenv: { sales: { names, type: "list" } } };
  const cases = [];
  for (const marked of ['sales[["tot│"]]', "sales[['tot│']]", 'sales[[tot│]]', 'sales$tot│']) {
    const cursor = marked.indexOf('│');
    const text = marked.replace('│', '');
    const context = completion.getCompletionContext(text, cursor);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, workspace, [], []);
    for (const [index, name] of names.entries()) {
      const entry = entries.find(entry => entry.label === name);
      assert.ok(entry, marked);
      assert.doesNotMatch(entry.insertText, /[\x00-\x1f\x7f-\x9f]/);
      const source = text.slice(0, context.replaceStart) + entry.insertText + text.slice(context.replaceEnd ?? cursor);
      if (marked === 'sales[["tot│"]]' && index === 0) assert.equal(source, 'sales[["total\\rUSD"]]');
      cases.push({ source, index: index + 1 });
    }
  }
  assert.equal(runRJson(`
    sales <- setNames(as.data.frame(as.list(seq_along(inputs$names))), unlist(inputs$names))
    ok <- vapply(inputs$cases, function(case) identical(eval(parse(text = case$source)), case$index), logical(1))
    cat(jsonlite::toJSON(all(ok), auto_unbox = TRUE))
  `, { names, cases }), true);
});

test("real language-server field and method edits preserve control characters in R names", async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t);
  const definition = 'sales <- list("total\\u0085USD" = 42L, "total\\u0085EUR" = function() 43L)';
  const input = "sales$tot";
  const source = definition + "\n" + input;
  const context = completion.getCompletionContext(input, input.length, source);
  const entries = await collectStaticEntries(client, context, { getText: () => source },
    { line: 1, character: input.length }, undefined, [definition], []);
  const expressions = ["total\u0085USD", "total\u0085EUR"].map(label => {
    const entry = entries.find(item => item.label === label && item.source === "lsp");
    assert.ok(entry, label);
    return input.slice(0, entry.replaceStart) + entry.insertText + input.slice(entry.replaceEnd ?? input.length);
  });
  assert.deepEqual(runRJson(definition + '\ncat(jsonlite::toJSON(vapply(inputs, function(x) eval(str2lang(x)), integer(1))))',
    expressions), [42, 43]);
});

test("typing and accepting package functions opens real argument suggestions without another keystroke", { timeout: 90000 }, async t => {
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
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  for (const [typed, insertText, argument] of [
    ["lib", "library()", "package"],
    ["stats::", "lm()", "formula"], ["stats:::", "lm()", "formula"],
  ]) {
    client.updateInput("");
    const { terminal, screen } = createTerminal(t);
    delete terminal.applyCompletion;
    terminal.lang = new RTermLang({ extensionPath: "", rPath: "", env: {} });
    const handle = terminal.lang.handleAutocomplete.bind(terminal.lang);
    terminal.lang.handleAutocomplete = request => handle({ ...request, getWorkspaceData: () => ({ search: [], loaded_namespaces: [], globalenv: {
      df: { names: ['zebra', 'alpha', 'beta', 'a b'], class: ['data.frame'], type: 'list' },
      dt: { names: ['zebra', 'alpha', 'beta', 'a b'], class: ['data.table', 'data.frame'], type: 'list' },
    } }) });
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
    if (!argument) { terminal.dismissInlineCompletion(false); terminal.lang.cancelCompletion(); continue; }
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
    ["stats::cor(method = sp│earman)", '"spearman"', 'stats::cor(method = "spearman")'],
    ["df[[al│pha]]", '"alpha"', 'df[["alpha"]]'],
    ['stats::cor(`method` = "│")', "spearman", 'stats::cor(`method` = "spearman")'],
    ["subset(df, │)", "alpha", "subset(df, alpha)"],
    ["df |> subset(│)", "alpha", "df |> subset(alpha)"],
    ["df |> │", undefined, undefined], ["df %>% │", undefined, undefined],
  ]) {
    client.updateInput("");
    const { terminal } = createTerminal(t);
    delete terminal.applyCompletion;
    terminal.lang = new RTermLang({ extensionPath: "", rPath: "", env: {} });
    const handle = terminal.lang.handleAutocomplete.bind(terminal.lang);
    terminal.lang.handleAutocomplete = request => handle({ ...request, getWorkspaceData: () => ({ search: [], loaded_namespaces: [], globalenv: {
      df: { names: ['zebra', 'alpha', 'beta', 'a b'], class: ['data.frame'], type: 'list' },
      dt: { names: ['zebra', 'alpha', 'beta', 'a b'], class: ['data.table', 'data.frame'], type: 'list' },
    } }) });
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
        marked === "df[[al│pha]]" ? ["alpha"] : ["zebra", "alpha", "beta", "a b"], `column order: ${marked}`);
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
  piped.lang = new RTermLang({ extensionPath: "", rPath: "", env: {} });
  piped.applyKeyAction({ type: "text", text: '"file.csv" |> rdcsv' });
  const pipeChoices = () => piped.inlineCompletion.items.filter(item => "insertText" in item);
  await waitFor(() => pipeChoices().some(item => item.insertText === "read.csv()"), "fuzzy pipe function completion");
  piped.inlineCompletion.move(pipeChoices().findIndex(item => item.insertText === "read.csv()") - piped.inlineCompletion.selected);
  piped.applyKeyAction({ type: "tab" });
  assert.equal(piped.inputState.textBeforeCursor, '"file.csv" |> read.csv(');
  await waitFor(() => pipeChoices().some(item => item.detail === "parameter"), "arguments after accepting a piped function");
  piped.dismissInlineCompletion(false);
});

test("accepting a chained method opens its inferred arguments without executing the receiver", { timeout: 90000 }, async t => {
  const { createConsoleLsp } = require('./helpers/console-lsp.cjs');
  const { createTerminal } = require('./helpers/inline-terminal.cjs');
  let inspections = 0;
  const { client } = createConsoleLsp(t, { requestRuntimeFunctionArguments: () => {
    inspections++;
    return { status: 'unavailable' };
  } });
  const provide = client.provideCompletionItems.bind(client);
  client.provideCompletionItems = async (...args) => {
    const response = await provide(...args);
    return { ...response, items: response.items.map(item => ({ ...item, kind: item.kind - 1 })) };
  };
  const { RTermLang } = loadSource('src/Terminal/rTerminal/lang.ts', {
    vscode: {
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      Uri: { parse: value => ({ toString: () => value }) },
      CompletionItemKind: { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5 },
      QuickPickItemKind: { Separator: -1 }, SnippetString: class {},
    },
    '../../Language/consoleLspClient': { ConsoleLspClient: class { constructor() { return client; } } },
  });
  const { terminal } = createTerminal(t, 100, 24, 'typing', { 'completion.staticAnalysis': true });
  delete terminal.applyCompletion;
  terminal.lang = new RTermLang({ extensionPath: '', rPath: '', env: {}, getStaticAnalysisEnabled: () => true });
  t.after(() => terminal.lang.cancelCompletion());
  const marker = path.join(os.tmpdir(), 'r-console-chain-' + randomBytes(8).toString('hex'));
  t.after(() => fs.rmSync(marker, { force: true }));
  const definition = `api <- list(scan = function() { file.create(${JSON.stringify(marker)}); list(collect = function(engine, optimize = TRUE) NULL) })`;
  terminal.inputState.text = definition + '\napi$scan()$collec';
  terminal.inputState.cursorPosition = terminal.inputState.text.length;
  terminal.applyKeyAction({ type: 'text', text: 't' });
  const choices = () => terminal.inlineCompletion.items.filter(item => 'insertText' in item);
  const until = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await until(() => choices().some(item => item.insertText === 'collect()'), 'method popup');
  const method = choices().find(item => item.insertText === 'collect()');
  assert.match(method.detail, /engine/);
  terminal.inlineCompletion.move(choices().indexOf(method) - terminal.inlineCompletion.selected);
  terminal.applyKeyAction({ type: 'tab' });
  assert.equal(terminal.inputState.textBeforeCursor, definition + '\napi$scan()$collect(');
  await until(() => choices().some(item => item.insertText === 'engine = '), 'arguments after accepting chained method');
  assert.deepEqual(choices().filter(item => item.detail === 'parameter').map(item => item.insertText),
    ['engine = ', 'optimize = ']);
  assert.equal(terminal.submitted, undefined);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(inspections, 0);
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
    const result = await completeStatic(client, { getText: () => text },
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
    ["base::atan2(1, │)", ["x"]],
    ["base::atan2(│, x = 2)", ["y"]],
    ["base::atan2(`x` = stop('must not run'), │)", ["y"]],
    ['base::atan2("x" = , │)', ["y"]],
    ['stats::cor(x = 1, y = 2, u = "everything", m = "pearson", │)', []],
    ['stats::cor(x = 1, y = 2, u = "everything", │)', ["method"]],
    ["1 |> base::atan2(2, │)", []],
    ["1 |> base::atan2(x = _, │)", ["y"]],
    ["1 |> base::atan2(│)", ["x"]],
    ["base::sum(1, 2, │)", ["...", "na.rm"]],
    ["base::sum(na = 1, │)", ["...", "na.rm"]],
    ["base::sum(na.rm = TRUE, │)", ["..."]],
  ]) {
    const cursor = marked.indexOf("│");
    const text = marked.replace("│", "");
    const result = await completeStatic(client, { getText: () => text }, { line: 0, character: cursor });
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
    const result = await completeStatic(client, { getText: () => text },
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
    ["atan2(1, │)", ["second"]],
  ]) assert.deepEqual(await parameters(marked), expected, marked);
});

test("local quoted formals retain unused arguments and reject supplied names", { timeout: 90000 }, async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t);
  const definition = 'f <- function(`a b`, `a\\`b`, normal = stop("default evaluated")) stop("body evaluated")\n';
  const parameters = async marked => {
    const text = definition + marked.replace("│", "");
    const result = await completeStatic(client, { getText: () => text },
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
    const result = await completeStatic(client, { getText: () => text }, position);
    assert.deepEqual((result.items ?? result).filter(item => item.detail === "parameter").map(item => item.label), expected, marked);
    const request = instances.at(-1).requests.filter(request => request.params?.position).at(-1);
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
    getStaticAnalysisEnabled: () => true,
  });
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
  const session = { globalenv: { f: { type: "closure" } } };
  client.setRuntimeSignatures({ f: 'function(old_arg = "old_value")' });
  const request = async () => assert.fail("workspace arguments must not query sess");
  for (const [marked, expected] of [
    ["{\n f <- function(new_arg) NULL\n f(│", ["new_arg"]],
    ["f <- function(new_arg) NULL\nf(│)", ["new_arg"]],
    ["{\n f <- function(new_argument) NULL\n f(nwrg│", ["new_argument"]],
    ["{\n f <- function(new_arg) NULL\n f(zzzz│", []],
    ["{\n f <- function(new_arg) NULL\n f(new_arg = 1, │", []],
    ["{\n f <- function() NULL\n f(│", []],
    ["{\n f <- function(...) NULL\n f(│", ["..."]],
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
    const entries = await collectStaticEntries(client, context, { getText: () => text }, position, session,
      lines.slice(0, position.line), [], request);
    assert.deepEqual(entries.filter(item => item.detail === "parameter").map(item => item.label), expected, marked);
    if (!expected.includes("old_arg")) assert.ok(!entries.some(item => item.label === "old_value"), marked);
  }
});

test("runtime mode ignores unsubmitted definitions; opt-in static mode can infer them", {
  timeout: 90000,
}, async t => {
  const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
  const { client: runtime } = createConsoleLsp(t, { staticAnalysis: false });
  runtime.setRuntimeSignatures({ f: "function(old_arg)" });
  const params = async (client, marked) => {
    const cursor = marked.indexOf("│");
    const text = marked.replace("│", "");
    const before = marked.slice(0, cursor).split("\n");
    const result = await (client === runtime ? client.provideCompletionItems.bind(client) : completeStatic.bind(null, client))({ getText: () => text },
      { line: before.length - 1, character: before.at(-1).length });
    assert.ok(result, marked);
    return { result, parameters: (result.items ?? result).filter(item => item.detail === "parameter")
      .map(item => item.label) };
  };
  const runtimePlain = await params(runtime, "f <- function(new_arg) NULL\nf(│");
  assert.deepEqual(runtimePlain.parameters, ["old_arg"]);
  assert.equal(runtimePlain.result.rConsoleLocalFunction, undefined);
  assert.equal(runtimePlain.result.rConsoleWorkspaceFunction, true);
  const member = await params(runtime, "obj <- list(fun = function(new_arg) NULL)\nobj$fun(│");
  assert.deepEqual(member.parameters, [], "member signatures require an explicit safe metadata source");
  const nonexistent = await params(runtime, "only_source <- function(source_arg) NULL\nonly_source(│");
  assert.deepEqual(nonexistent.parameters, []);
  const pipe = await params(runtime, "only_source <- function(source_arg) NULL\n1 |> only_so│");
  assert.ok(!(pipe.result.items ?? pipe.result).some(item => item.label === "only_source"));

  const { client: staticClient } = createConsoleLsp(t, { staticAnalysis: true });
  staticClient.setRuntimeSignatures({ f: "function(old_arg)" });
  const staticPlain = await params(staticClient, "f <- function(new_arg) NULL\nf(│");
  assert.deepEqual(staticPlain.parameters, ["new_arg"]);
  assert.equal(staticPlain.result.rConsoleLocalFunction, true);
});

test("cached top-level function signatures track executed redefinitions", {
  timeout: 90000,
}, async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t, { staticAnalysis: false });
  const text = "f(";
  const position = { line: 0, character: text.length };
  const complete = async () => {
    const result = await client.provideCompletionItems({ getText: () => text }, position);
    return (result?.items ?? []).filter(item => item.detail === "parameter").map(item => item.label);
  };
  client.setRuntimeSignatures({ f: "function(old_arg)" });
  assert.deepEqual(await complete(), ["old_arg"]);
  client.setRuntimeSignatures({ f: "function(new_arg)" });
  assert.deepEqual(await complete(), ["new_arg"]);
  client.setRuntimeSignatures({});
  assert.deepEqual(await complete(), []);
});

test("accepting a console-defined function opens its live arguments and values", { timeout: 90000 }, async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t);
  const provide = client.provideCompletionItems.bind(client);
  client.provideCompletionItems = async (...args) => {
    const result = await provide(...args);
    return { ...result, items: (result.items ?? result).map(item => ({ ...item,
      kind: item.kind === undefined ? undefined : item.kind - 1 })), isIncomplete: result.isIncomplete };
  };
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      CompletionItemKind: { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Value: 11, Snippet: 14 },
      Uri: { parse: value => ({ toString: () => value }) },
      QuickPickItemKind: { Separator: -1 }, SnippetString: class {},
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class { constructor() { return client; } } },
  });
  const setup = 'f <- function(`a b`, normal = c("first", "second"), lazy = stop("default evaluated")) stop("body evaluated")\n' +
    'my_function <- function(method = c("fast", "accurate")) {}\n';
  client.setRuntimeSignatures({
    f: 'function(`a b`, normal = c("first", "second"), lazy = stop("default evaluated"))',
    my_function: 'function(method = c("fast", "accurate"))',
  });
  const session = runRJson(setup + 'cat(jsonlite::toJSON(list(search = search(), loaded_namespaces = loadedNamespaces(), globalenv = lapply(mget(c("f", "my_function")), function(fn) list(type = typeof(fn), str = paste(capture.output(str(fn)), collapse="\\n")))), auto_unbox = TRUE))');
  const lang = new RTermLang({ extensionPath: "", rPath: "", env: {} });
  lang.updateSessionData(session);
  t.after(() => lang.dispose());
  await lang.start();
  for (const [text, expected] of [
    ['my_fun', ['my_function']], ['1 |> my_fun', ['my_function']],
    ['my_function(', ['method']], ['my_function(fa', []],
    ['my_function(method = ', ['fast', 'accurate']], ['my_function(method = "fa', ['fast']],
  ]) {
    const entries = await completion.collectCompletionEntries(completion.getCompletionContext(text, text.length),
      { getText: () => text, uri: client.inputDocument.uri }, { line: 0, character: text.length },
      session, [], [], client, async () => assert.fail("function completion must not query sess"));
    const displayed = entries.filter(item => item.label === 'my_function' || item.role === 'argument' || item.role === 'value');
    assert.deepEqual(displayed.map(item => item.label), expected, text);
    if (expected.includes('my_function')) assert.equal(displayed[0].source, 'session');
  }
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
  assert.ok(choices().every(item => !item.detail?.startsWith("value for ")));
  terminal.applyKeyAction({ type: "tab" });
  await waitFor(() => choices().some(item => item.insertText === '"second"'), "live default values");
  assert.equal(terminal.submitted, undefined, "completion must never execute the function");
});

test("cached workspace signatures replace and remove native definitions and survive restart", { timeout: 90000 }, async t => {
  const { client, instances } = require('./helpers/console-lsp.cjs').createConsoleLsp(t, { staticAnalysis: false });
  const complete = () => client.provideCompletionItems({ getText: () => 'workspace_test_fn(' }, { line: 0, character: 18 });
  for (const [functions, expected] of [
    [{ workspace_test_fn: 'function(first)' }, ['first']],
    [{ workspace_test_fn: 'function(second = stop("never evaluate"))' }, ['second']],
    [{ workspace_test_fn: 'function(truncated = c("a",' }, []],
    [{ workspace_test_fn: 'function()' }, []],
    [{}, []],
  ]) {
    client.setRuntimeSignatures(functions);
    const result = await complete();
    assert.deepEqual(result.items.filter(item => item.detail === 'parameter').map(item => item.label), expected);
    assert.equal(!!result.rConsoleWorkspaceFunction, !!functions.workspace_test_fn && !functions.workspace_test_fn.includes('truncated'));
  }
  const state = { attachedPackages: [], functions: { workspace_test_fn: 'function(restored)' } };
  client.setRuntimeSignatures(state.functions);
  await instances.at(-1).stop();
  const result = await complete();
  assert.deepEqual(result.items.filter(item => item.detail === 'parameter').map(item => item.label), ['restored']);
});

test("qualified namespace arguments use the real LSP despite a same-name local function", { timeout: 90000 }, async t => {
  const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
  const { client } = createConsoleLsp(t);
  for (const operator of ["::", ":::"]) {
    const input = `lm <- function(wrong_argument) {}; stats${operator}lm(`;
    const context = completion.getCompletionContext(input, input.length);
    let runtimeRequests = 0;
    const entries = await collectStaticEntries(client, context, { getText: () => input },
      { line: 0, character: input.length }, undefined, [], [], async () => { runtimeRequests++; return []; });
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
  const entries = await collectStaticEntries(client, completion.getCompletionContext(input, 3),
    { getText: () => input }, { line: 0, character: 3 }, { globalenv: { lm: { type: "closure" } } }, [], [],
    async () => { assert.fail("selected package must not query the session namesake"); });
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
      const entries = await collectStaticEntries(client, context, { getText: () => input },
        { line: row, character: column }, undefined, linesBefore.slice(0, -1), []);
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
      const entries = await collectStaticEntries(client, context, { getText: () => input },
        { line: 1, character: column }, undefined, [input.split("\n")[0]], []);
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
      const result = await completeStatic(client, { getText: () => input }, position);
      parameters = (Array.isArray(result) ? result : result?.items ?? [])
        .filter(item => item.detail === "parameter").map(item => item.label);
      if (validNames[index] ? parameters.includes("correct_argument") : parameters.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.deepEqual(parameters, validNames[index] ? ["correct_argument"] : [], input);
    assert.equal(instances.at(-1).requests.filter(request => request.params?.position).at(-1).params.rConsoleCall, name);
  }
  // Exercise parse rejection on every platform, even where unquoted
  // supplementary characters are accepted by R.
  const instance = instances.at(-1);
  const result = await instance.sendRequest("textDocument/completion", {
    ...instance.requests.filter(request => request.params?.position).at(-1).params, rConsoleCall: "not a valid name",
  });
  assert.ok(result.items.every(item => item.detail !== "parameter" && !item.detail?.startsWith("value for ")));
});

test("fuzzy fallback preserves value, comment and member-call identities", { timeout: 90000 }, async t => {
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
    const previousRequests = instances.at(-1)?.requests.length ?? 0;
    const entries = await collectStaticEntries(client, context, { getText: () => input },
      { line: 1, character: column }, undefined, [input.split("\n")[0]], []);
    if (context.suppressAutomatic) {
      assert.deepEqual(entries, [], input);
      assert.equal(instances.at(-1)?.requests.length ?? 0, previousRequests, 'literal/comment context must not query code completions');
      continue;
    }
    const requests = instances.at(-1).requests.filter(request => request.params?.position).slice(-2);
    assert.equal(requests[0].params.position.character, column, input);
    assert.equal(requests[1].params.position.character, column - 2, input);
    if (tail.startsWith("method =")) {
      assert.ok(requests.every(request => request.params.rConsoleCall === head && request.params.rConsoleArgument === "method"), input);
    } else if (head === "obj$lm") {
      assert.ok(requests.every(request => request.params.rConsoleCall === head), input);
    } else {
      assert.ok(requests.every(request => request.params.rConsoleCall === undefined), input);
    }
    assert.ok(entries.every(entry => entry.detail !== "parameter"), input);
  }
});

test("unknown runtime member signatures do not request expressions or borrow global signatures", async () => {
  for (const text of ["obj$lm(", "slot_obj@lm(", 'obj$choose(mode = "']) {
    const entries = await completion.collectCompletionEntries(completion.getCompletionContext(text, text.length),
      undefined, undefined, undefined, [], [], undefined,
      async () => assert.fail("member arguments must not evaluate expressions through sess"));
    assert.deepEqual(Array.from(entries), []);
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
    assert.equal(entries.some(entry => entry.detail === "parameter"), false, "unknown signature: " + input);
  }
});

test("live sess signatures agree with native R calls across pipe and argument combinations", { timeout: 120000 }, async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t, { staticAnalysis: false });
  client.setRuntimeSignatures(Object.fromEntries(["positional", "dots", "constructor"].map(name =>
    [name, name === "dots" ? "function(first, ..., after)" : "function(first, second, third)"])));
  const cases = [];
  const actualResults = [];
  for (const pipe of ["", "1 |> ", "1 %>% "]) {
    for (const fn of ["positional", "dots", "constructor"]) {
      const argumentsList = [
        "§", "1, §", "first = 1, §", "fi = 1, §", "§, third = 3",
        "third = 3, §", 'r"(third)" = 3, §', "§, 2", "1, §, 3",
        "§, , third = 3", "first = 1, second = 2, third = 3, §",
        "1, 2, §", "after = 1, §", "af = 1, §",
      ];
      if (pipe === "1 |> ") argumentsList.push("third = _, §", "§, second = _", "2 |> identity(x = _), §");
      if (pipe === "1 %>% ") argumentsList.push("third = ., §", "§, second = .", "identity(.), §", "., §");
      for (const args of argumentsList) {
        const marked = `${pipe}\`${fn}\`(${args})`;
        const cursor = marked.indexOf("§");
        const input = marked.replace("§", "");
        const result = await client.provideCompletionItems({ getText: () => input }, { line: 0, character: cursor });
        cases.push({ call: marked, fn });
        actualResults.push(result.items.filter(item => item.detail === "parameter" && item.label !== "...").map(item => item.label));
      }
    }
  }
  // Evaluate harmless test functions whose bodies only return match.call().
  // Let R and magrittr identify the arguments already bound by the actual
  // call, reserving the cursor slot. Remaining candidates must also form valid
  // named calls. Completion deliberately excludes names R could only reuse
  // by rematching an existing positional value.
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
    invisible(list2env(obj, .GlobalEnv))
    result <- lapply(seq_along(inputs$cases), function(i) {
      case <- inputs$cases[[i]]
      candidates <- setdiff(names(formals(obj[[case$fn]])), "...")
      current <- tryCatch(eval(parse(text = sub("§", ".cursor_marker", case$call, fixed = TRUE))),
        error = function(e) NULL)
      current <- as.list(current)[-1L]
      occupied <- setdiff(names(current)[!vapply(current, identical, logical(1), quote(.cursor_marker))], "...")
      candidates <- setdiff(candidates, occupied)
      expected <- candidates[vapply(candidates, function(name) {
        call <- sub("§", paste0(name, " = .cursor_marker"), case$call, fixed = TRUE)
        tryCatch({ eval(parse(text = call)); TRUE }, error = function(e) FALSE)
      }, logical(1))]
      as.list(expected)
    })
    cat(jsonlite::toJSON(result, auto_unbox = TRUE))
  `, { cases });
  assert.equal(results.length, cases.length);
  for (const [index, result] of results.entries()) {
    assert.deepEqual(actualResults[index], result, cases[index].call);
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
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const childClosed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await childClosed;
    if (!t.passed && stderr) t.diagnostic(stderr);
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
  });
  assert.ok(Array.isArray(synced.libraryPaths) && synced.libraryPaths.length > 0, "session synchronization returns the resolved libraries");

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
    ['df[│, cols[1]]', []],
    ['df[│, cols[[1]]]', []],
    ['df[, │, drop = FALSE]', ['alpha', 'beta']],
  ]) {
    const text = marked.replace('│', ''), cursor = marked.indexOf('│');
    const context = completion.getCompletionContext(text, cursor);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      { globalenv: { df: { names: ['alpha', 'beta'], class: ['data.frame'], type: 'list' } } }, [], [], undefined,
      async () => assert.fail("bracket completion must use workspace data"));
    assert.deepEqual(entries.filter(item => item.kind === 4).map(item => item.label), expected, marked);
    if (!expected.length) continue;
    const selected = entries.find(item => item.label === expected[0]);
    const code = text.slice(0, context.replaceStart) + selected.insertText + text.slice(cursor);
    assert.equal(runRJson(setup + 'invisible(suppressWarnings(eval(parse(text=inputs)))); cat("true")', code), true, code);
  }
});

test("partial argument values follow R matching in source and workspace signatures", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  const definitions = 'f <- function(method = c("spearman", "pearson"), metric = "other") stop("body evaluated")\n';
  for (const runtime of [false, true]) {
    client.setRuntimeSignatures(runtime ? { f: 'function(method = c("spearman", "pearson"), metric = "other")' } : {});
    for (const [call, expected] of [
      ['f(meth = sp│)', ['spearman']], ['f(meth = "sp│")', ['spearman']],
      ['f(met = sp│)', []], ['f(metric = stop("argument evaluated"), met = sp│)', ['spearman']],
      ['f(method = "pearson", meth = sp│)', []],
    ]) {
      const marked = (runtime ? '' : definitions) + call;
      const text = marked.replace('│', ''), before = marked.split('│')[0], lines = text.split('\n');
      const position = { line: before.split('\n').length - 1, character: before.split('\n').at(-1).length };
      const context = completion.getCompletionContext(lines[position.line], position.character, before, text.slice(before.length));
      const entries = await collectStaticEntries(client, context, { getText: () => text }, position,
        runtime ? { globalenv: { f: { type: 'closure' } } } : undefined, lines.slice(0, position.line), [],
        async () => assert.fail("workspace arguments must not query sess"));
      assert.deepEqual(entries.filter(item => item.detail?.startsWith('value for ')).map(item => item.label), expected,
        `${runtime ? 'runtime' : 'source'}: ${marked}`);
    }
  }
  const result = await completeStatic(client, { getText: () => 'stats::cor(met = sp)' }, { line: 0, character: 'stats::cor(met = sp'.length });
  assert.ok(result.items.some(item => item.label === 'spearman'));
  for (const tag of ['met', 'method']) {
    const text = `f <- function(..., method = "spearman") NULL\nf(${tag} = "sp")`;
    const result = await completeStatic(client, { getText: () => text }, { line: 1, character: `f(${tag} = "sp`.length });
    assert.equal(result.items.some(item => item.label === 'spearman'), tag === 'method', 'partial matching stops at dots');
  }
});

test("declarations outside the cursor binding preserve source and live signatures", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  client.setRuntimeSignatures({ f: 'function(live_arg)' });
  for (const [marked, expected, local] of [
    ['f <- function(alpha) NULL; f(│); f <- function(beta) NULL', ['alpha'], true],
    ['f <- function(alpha) NULL; g <- function() { f <- function(beta) NULL }; f(│)', ['alpha'], true],
    ['f(│); f <- function(beta) NULL', ['live_arg'], false],
    ['g <- function() { f <- function(hidden) NULL }; f(│)', ['live_arg'], false],
    ['f <- function(earlier) NULL; f <- function() { f(│) }; f <- function(earlier) NULL', [], true],
    ['(function(recursive) { f(│) }) -> f', [], true],
  ]) {
    const result = await completeStatic(client, { getText: () => marked.replace('│', '') },
      { line: 0, character: marked.indexOf('│') });
    assert.deepEqual(result.items.filter(item => item.detail === 'parameter').map(item => item.label), expected, marked);
    assert.equal(result.rConsoleLocalFunction === true, local, marked);
    assert.equal(result.rConsoleWorkspaceFunction === true, !local, marked);
  }
});

test("source redefinitions remain authoritative through wrappers, chains and lexical scopes", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  // Known native limitations use independently observed native evidence.
  // Adapter failures cannot downgrade a callable that native inference resolves.
  for (const [marked, expected, nativeMayDecline = false] of [
    ['f <- (function(new_arg) NULL)\nf(│)', ['new_arg']],
    ['f <- g <- function(new_arg) NULL\nf(│)', ['new_arg'], true],
    ['(function(new_arg) NULL) -> f\nf(│)', ['new_arg']],
    ['f <- (function(new_arg = stop("default evaluated")) {\n stop("body evaluated")\n NULL\n})\nf(│)', ['new_arg']],
    ['f <- (function() NULL)\nf(│)', []],
    ['f <- (function() stop("must not execute"))()\nf(│)', []],
    ['f <- function(outer_arg) NULL\ng <- function() { f <- (function(inner_arg) NULL); f(│) }', ['inner_arg']],
    ['f <- function(outer_arg) NULL\ng <- function() { f <- (function(inner_arg) NULL) }; f(│)', ['outer_arg']],
    ['f <- function(earlier) NULL; f(│); f <- function(later) NULL', ['earlier']],
    ['f <- function(earlier) NULL; f <- { f(│); function(later) NULL }', ['earlier']],
    ['f <- function(earlier) NULL; f <- f(│)', ['earlier']],
    ['f <- function(earlier) NULL; f <- (g <- f(│))', ['earlier']],
    ['f <- function(recursive_arg) { f(│) }', ['recursive_arg'], true],
    ['(function(recursive_arg) { f(│) }) -> f', ['recursive_arg'], true],
    ['f <- function(earlier) NULL; f <- function() { f(│) }', []],
    ['f <- function(earlier) NULL; f <- (function() { f(│) })()', ['earlier']],
    ['f <- (function(method = c("new_value", "other")) NULL)\nf(meth = "new│")', ['new_value']],
  ]) {
    const text = marked.replace('│', ''), before = marked.split('│')[0], lines = text.split('\n');
    const position = { line: before.split('\n').length - 1, character: before.split('\n').at(-1).length };
    const context = completion.getCompletionContext(lines[position.line], position.character, before, text.slice(before.length));
    const entries = await collectStaticEntries(client, context, { getText: () => text }, position,
      { globalenv: { f: { type: 'closure' } } }, lines.slice(0, position.line), [],
      async () => [{ name: 'old_arg' }]);
    assert.deepEqual(entries.filter(item => item.detail === 'parameter' || item.detail?.startsWith('value for '))
      .map(item => item.label), nativeMayDecline && nativeStaticEvidence(marked).signature === null ? [] : expected, marked);
  }
});

test("formal bindings shadow outer functions without evaluating their defaults", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  for (const [marked, expected, nativeMayDecline = false] of [
    ['f <- function(outer_arg) NULL\ng <- function(f = function(inner_arg) NULL) { f(│) }', ['inner_arg'], true],
    ['f <- function(outer_arg) NULL\ng <- function(f) { f(│) }', []],
    ['f <- function(outer_arg) NULL\ng <- function(f = stop("must not evaluate")) { f(│) }', []],
    ['g <- function(f = (function(inner_arg) NULL)) { f(│) }', ['inner_arg'], true],
    ['g <- \\(f = \\(inner_arg) NULL) { f(│) }', ['inner_arg'], true],
    ['g <- function(`a b` = function(inner_arg) NULL) { `a b`(│) }', ['inner_arg'], true],
    ['g <- function(f = function(default_arg) NULL) { f <- function(assigned_arg) NULL; f(│) }', ['assigned_arg']],
    ['g <- function(f = function(default_arg) NULL) { f(│); f <- function(later_arg) NULL }', ['default_arg'], true],
    ['g <- function(f = function(local_arg) NULL) { f <<- function(parent_arg) NULL; f(│) }', ['local_arg'], true],
    ['g <- function(f = function(local_arg) NULL) { function(parent_arg) NULL ->> f; f(│) }', ['local_arg'], true],
    ['g <- function() { f <- function(local_arg) NULL; f <<- function(parent_arg) NULL; f(│) }', ['local_arg']],
    ['g <- function(f = function(outer_arg) NULL) { h <- function() { f <<- function(new_arg) NULL; f(│) } }', ['new_arg'], true],
    ['g <- function(f = function(outer_arg) NULL) { h <- function(f = function(inner_arg) NULL) { f(│) } }', ['inner_arg'], true],
    ['g <- function(f = function(outer_arg) NULL) { h <- function() { f(│) } }', ['outer_arg'], true],
    ['g <- function(f = function(outer_arg) NULL) { h <- function(f) { f(│) } }', []],
    ['f <- function(outer_arg) NULL\ng <- function(f = function(inner_arg) NULL) NULL; f(│)', ['outer_arg']],
    ['g <- function(f = function(inner_arg) NULL) {\n f(│', ['inner_arg'], true],
    ['f <- function(outer_arg) NULL; g <- function(x = { f <- function(lazy_arg) NULL }) { f(│) }', ['outer_arg']],
    ['f <- function(outer_arg) NULL; g <- function(x = f <- function(lazy_arg) NULL) { f(│) }', ['outer_arg']],
    ['f <- function(outer_arg) NULL; g <- function(x = { f <- function(lazy_arg) NULL; f(│) }) NULL', ['lazy_arg']],
    ['f <- function(outer_arg) NULL; g <- function(x = { f <- function(lazy_arg) NULL }, y = f(│)) NULL', ['outer_arg']],
  ]) {
    const text = marked.replace('│', ''), before = marked.split('│')[0], lines = before.split('\n');
    const result = await completeStatic(client, { getText: () => text },
      { line: lines.length - 1, character: lines.at(-1).length });
    assert.equal(result.rConsoleLocalFunction, true, marked);
    assert.deepEqual(result.items.filter(item => item.detail === 'parameter').map(item => item.label),
      nativeMayDecline && nativeStaticEvidence(marked).signature === null ? [] : expected, marked);
    if (result.rConsoleArgumentsResolved === false) assert.equal(result.rConsoleStaticUnavailableReason, 'receiver-unresolved');
  }
});

test("source bindings do not escape quoted, lazy or locally evaluated arguments", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  for (const [tail, nativeMayDecline = false] of [
    ['quote(f <- function(hidden_arg) NULL); f(│)', true],
    ['substitute({ f <- function(hidden_arg) NULL }); f(│)', true],
    ['expression(f <- function(hidden_arg) NULL); f(│)', true],
    ['alist(f <- function(hidden_arg) NULL); f(│)', true],
    ['local({ f <- function(hidden_arg) NULL }); f(│)', true],
    ['base::local({ f <- function(hidden_arg) NULL }); f(│)', true],
    ['ignore <- function(...) NULL; ignore(f <- function(hidden_arg) NULL); f(│)', true],
    ['ignore <- function(x, y) y; ignore({ f <- function(hidden_arg) NULL }, f(│))'],
    ['local({ f <- function(inner_arg) NULL; f(│) })'],
    ['base::local({ f <- function(inner_arg) NULL; f(│) })'],
  ]) {
    const marked = 'f <- function(outer_arg) NULL; ' + tail;
    // Execute only these controlled fixtures to derive the expected binding
    // from R itself. The completion server must inspect their syntax only.
    const expected = runRJson('cat(jsonlite::toJSON(eval(parse(text=inputs)), auto_unbox=FALSE))',
      marked.replace('f(│)', 'names(formals(f))'));
    const text = marked.replace('│', '');
    const result = await completeStatic(client, { getText: () => text },
      { line: 0, character: marked.indexOf('│') });
    assert.deepEqual(result.items.filter(item => item.detail === 'parameter').map(item => item.label),
      nativeMayDecline && nativeStaticEvidence(marked).signature === null ? [] : expected, tail);
    if (result.rConsoleArgumentsResolved === false) assert.equal(result.rConsoleStaticUnavailableReason, 'receiver-unresolved');
  }
});

test("positional value suggestions match only the receiving argument", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  for (const [definition, call, expected] of [
    ['function(method = c("one", "two")) NULL', 'f(method = "one", │)', []],
    ['function(method = c("one", "two")) NULL', 'f(│, method = "one")', []],
    ['function(method = c("one", "two")) NULL', 'f("one", │)', []],
    ['function(method = c("one", "two")) NULL', 'f(met = "one", │)', []],
    ['function(method = c("one", "two")) NULL', '"one" |> f(│)', []],
    ['function(method = c("one", "two")) NULL', 'f(│)', ['one', 'two']],
    ['function(first = "first_value", second = "second_value") NULL', 'f(│)', ['first_value']],
    ['function(first = "first_value", second = "second_value") NULL', 'f(1, │)', ['second_value']],
    ['function(first = "first_value", second = "second_value") NULL', 'f(│, first = 1)', ['second_value']],
    ['function(..., method = "named_only") NULL', 'f(│)', []],
    ['function(method = "already_used", ...) NULL', 'f(method = "already_used", │)', []],
    ['function(method = "still_available") NULL', 'f(method = "still│")', ['still_available']],
  ]) {
    const text = `f <- ${definition}\n${call.replace('│', '')}`;
    const result = await completeStatic(client, { getText: () => text }, { line: 1, character: call.indexOf('│') });
    assert.deepEqual(result.items.filter(item => item.detail?.startsWith('value for ')).map(item => item.label), expected, call);
  }
  // Package signatures use the same positional matching as source definitions.
  const text = 'stats::cor(x = 1, y = 2, use = "everything", method = "pearson", )';
  const result = await completeStatic(client, { getText: () => text }, { line: 0, character: text.length - 1 });
  assert.deepEqual(result.items.filter(item => item.detail?.startsWith('value for ')), []);
});

test("literal argument names and values are never interpreted as snippet placeholders", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  for (const [marked, expected] of [
    ['f <- function(pattern = c("$1", "${2:text}")) NULL\nf(│)', ['pattern = ', '"$1"', '"${2:text}"']],
    ['f <- function(pattern = c("$1", "${2:text}")) NULL\nf(pattern = "│")', ['$1', '${2:text}']],
    ['f <- function(pattern = c("$1", "${2:text}")) NULL\nf(pattern = "$│")', ['$1', '${2:text}']],
    ['f <- function(`$1`) NULL\nf(│)', ['`$1` = ']],
    ['f <- function(`$1` = "$2") NULL\nf(`$1` = "│")', ['$2']],
  ]) {
    const text = marked.replace('│', ''), before = marked.split('│')[0], lines = text.split('\n');
    const position = { line: 1, character: before.split('\n').at(-1).length };
    const context = completion.getCompletionContext(lines[1], position.character, before, text.slice(before.length));
    const entries = (await collectStaticEntries(client, context, { getText: () => text }, position, undefined,
      lines.slice(0, 1), [])).filter(item => item.detail === 'parameter' || item.detail?.startsWith('value for '));
    assert.deepEqual(entries.map(item => item.insertText), expected, marked);
    assert.ok(entries.every(item => item.label.includes('$') || item.label === 'pattern'), marked);
    for (const entry of entries) {
      const pick = completion.toCompletionPick(entry, context);
      assert.equal(pick.detail, entry.detail, 'literal parameter names also survive in displayed details');
    }
  }
});

test("pipe completion preserves native recovery without synthetic source edits", { timeout: 90000 }, async t => {
  const { client, instances } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  for (const [marked, required] of [
    ['my_frob <- function(x) x\n1 %>% my_fr│', true],
    ['my_frob <- function(x) x\n1 |> my_fr│', false],
    ['{\n my_frob <- function(x) x\n 1 |> my_fr│', false],
    ['{\n my_frob <- function(x) x\n 1 |> my_fr│ }', false],
    ['{\n my_frob <- function(x) x\n 1 |> my_f│rob }', false],
    ['my_frob <- function(x) x\n1 |> my_fr│()', true],
    ['my_frob <- function(x) x\n"😀" |> my_fr│', false],
    ['my_frob <- function(x) x\n\t1 |> my_fr│', false],
    ['my_frob <- function(x) x\n1 |> │', false],
  ]) {
    const text = marked.replace('│', ''), before = marked.split('│')[0], lines = text.split('\n');
    const position = { line: before.split('\n').length - 1, character: before.split('\n').at(-1).length };
    const doc = { getText: () => text, uri: client.inputDocument.uri };
    const context = completion.getCompletionContext(lines[position.line], position.character, before, text.slice(before.length));
    const entries = await collectStaticEntries(client, context, doc, position, undefined,
      lines.slice(0, position.line), []);
    if (required) assert.ok(entries.some(item => item.insertText === 'my_frob()'), marked);
    const native = nativeStaticEvidence(marked, context.prefix);
    assert.equal(entries.some(item => item.insertText === 'my_frob()'), native.functions.includes('my_frob'), marked);
    // Incomplete native-pipe destinations may remain unresolved upstream. Never
    // synthesize a call/closing braces to manufacture static source bindings.
    const params = instances.at(-1).requests.filter(request => request.params?.position).at(-1).params;
    assert.equal(params.rConsoleParseSuffix, undefined);
    assert.equal(params.rConsoleParseInsertion, undefined);
    assert.equal([...client.syncedDocuments.values()].at(-1).document.getText(), text, 'repair stays out of the visible/LSP document');
    assert.ok(instances.at(-1).requests.filter(request => request.params?.position).at(-1).params.position.character <= lines[position.line].length);
  }
});

test("source callable names preserve literal dollar signs and quoting", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  for (const name of ['foo$1', 'foo${2:text}', 'foo bar']) {
    const text = '`' + name + '` <- function(x) NULL\nfoo';
    const context = completion.getCompletionContext('foo', 3, text);
    const entries = await collectStaticEntries(client, context,
      { getText: () => text, uri: client.inputDocument.uri }, { line: 1, character: 3 }, undefined,
      [text.split('\n')[0]], []);
    assert.ok(entries.some(item => item.insertText === '`' + name + '`()'), name);
  }
});

test("empty sess default choices survive native completion", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  client.setRuntimeSignatures({ choose: 'function(mode = c("", "auto", "value:literal"))' });
  const result = await client.provideCompletionItems({ getText: () => 'choose(mode = )' }, { line: 0, character: 14 });
  assert.deepEqual(result.items.filter(item => item.detail === 'value for mode').map(item => item.label), ['', 'auto', 'value:literal']);
});

test("complex defaults cannot suppress source argument completions", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  for (const expression of ['c(base::identity("never evaluate"))',
    'c((function() stop("never evaluate"))())', 'c("known", base::stop("never evaluate"))',
    'c(I("known"), , base::stop("never evaluate"))']) {
    const text = `f <- function(x = ${expression}, good) NULL\nf()`;
    const result = await completeStatic(client, { getText: () => text }, { line: 1, character: 2 });
    assert.ok(result, expression);
    assert.deepEqual(result.items.filter(item => item.detail === 'parameter').map(item => item.label), ['x', 'good'], expression);
    assert.deepEqual(result.items.filter(item => item.detail === 'value for x').map(item => item.label),
      expression.includes('"known"') ? ['known'] : [], expression);
    const symbols = await completeStatic(client, { getText: () => text.replace('f()', 'f(lib)') },
      { line: 1, character: 5 });
    assert.ok(symbols?.items.some(item => item.label === 'library'), 'ordinary symbol completion is preserved');
    const values = await completeStatic(client, { getText: () => text.replace('f()', 'f(x = "")') },
      { line: 1, character: 7 });
    assert.deepEqual(values?.items.filter(item => item.detail === 'value for x').map(item => item.label),
      expression.includes('"known"') ? ['known'] : [], 'quoted values use the same safe extraction');
  }
});

test("sess literal choices use native extraction without evaluating defaults", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  for (const expression of ['c(I("known"), , base::stop("never evaluate"))',
    'c("known", base::identity("never evaluate"))', 'c((function() stop("never evaluate"))())']) {
    client.setRuntimeSignatures({ f: 'function(x = ' + expression + ')' });
    const result = await client.provideCompletionItems({ getText: () => 'f(x = "")' }, { line: 0, character: 7 });
    assert.deepEqual(result.items.filter(item => item.detail === 'value for x').map(item => item.label), expression.includes('"known"') ? ['known'] : [], expression);
  }
});

test("unavailable runtime data scopes never execute R expressions to supply columns", async () => {
  const setup = 'old_df <- data.frame(old_column = 1); new_df <- data.frame(new_column = 1); obj <- list(data = new_df)\n';
  for (const [marked, expected] of [
    ['with(old_df, x)\nnew_fun(│)', []],
    ['old_df |> identity()\nnew_df |> subset(│)', []],
    ['old_df |> subset(new_df, │)', []],
    ['old_df %>% subset(., │)', []],
    ['with(old_df, subset(new_df, │))', []],
    ['with(new_df, text = ")", │)', []],
    ['obj$data |> subset(│)', []],
    ['with(old_df, stop("must not execute") |> subset(│))', []],
  ]) {
    const text = marked.replace('│', ''), before = marked.split('│')[0], lines = text.split('\n');
    const row = before.split('\n').length - 1;
    const context = completion.getCompletionContext(lines[row], before.split('\n').at(-1).length,
      before, text.slice(before.length));
    let probes = 0;
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [], undefined,
      async expression => {
        probes++;
        return runRJson(setup + 'x <- eval(parse(text=inputs)); cat(jsonlite::toJSON(lapply(names(x), function(n) list(name=n)), auto_unbox=TRUE))', expression);
      });
    assert.deepEqual(entries.filter(item => item.kind === 4).map(item => item.label), expected, marked);
    assert.equal(probes, 0, 'unsubmitted inputs and runtime objects must not be evaluated');
  }
});

test("native member inference owns edits, callable snippets and empty source objects", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  for (const [marked, expected] of [
    ['obj <- list(alpha = 1, beta = 2)\nobj$al│pha', ['alpha']],
    ['obj <- list()\nobj$│', []],
    ['obj <- list(alpha = 1)\nobj$missing│', []],
    ['obj <- list(`fun$1` = function(x) NULL)\nobj$fu│', ['`fun$1`()']],
    ['obj <- list(fun = function(x) NULL)\nobj$fu│n(123)', ['fun']],
  ]) {
    const cursor = marked.indexOf('│'), text = marked.replace('│', '');
    const before = text.slice(0, cursor).split('\n');
    const position = { line: before.length - 1, character: before.at(-1).length };
    const line = text.split('\n')[position.line];
    const context = completion.getCompletionContext(line, position.character, text.slice(0, cursor), text.slice(cursor));
    let probes = 0;
    const entries = await collectStaticEntries(client, context,
      { getText: () => text, uri: client.inputDocument.uri }, position,
      { globalenv: { obj: { names: ['stale'] } } }, text.split('\n').slice(0, position.line), [],
      async () => { probes++; return [{ name: 'stale' }]; });
    assert.deepEqual(entries.map(item => item.insertText), expected, marked);
    assert.equal(probes, 0, 'native source inference must not probe the active R session');
    if (expected[0] === 'alpha') {
      const pick = completion.toCompletionPick(entries[0], context);
      assert.equal(line.slice(0, pick.replaceStart) + pick.insertText + line.slice(pick.replaceEnd), 'obj$alpha');
    }
    if (expected[0] === 'fun') {
      const { terminal } = require('./helpers/inline-terminal.cjs').createTerminal(t);
      delete terminal.applyCompletion;
      terminal.lang.recordCompletion = () => {};
      let requests = 0;
      terminal.scheduleInlineCompletion = () => { requests++; };
      terminal.inputState.text = text;
      terminal.inputState.cursorPosition = cursor;
      terminal.applyCompletion(completion.toCompletionPick(entries[0], context));
      assert.equal(terminal.inputState.text, text);
      assert.equal(terminal.inputState.text.slice(terminal.inputState.cursorPosition), '123)');
      assert.equal(requests, 1);
    }
  }
});

test("static completion explains missing source and unresolved accessors using native inference evidence", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  const definition = [
    'probe <- new.env(parent = emptyenv())',
    'probe$calls <- 0L',
    'custom_obj <- structure(list(inner = list(secret = 123)), class = "dangerous")',
    '`$.dangerous` <- function(x, name) { probe$calls <- probe$calls + 1L; unclass(x)[[name]] }',
    'make_object <- function() { probe$calls <- probe$calls + 1L; list(inner = list(secret = 456)) }',
  ].join('\n');
  for (const [text, reason, resolved, labels] of [
    ['custom_obj$inner$', 'receiver-unresolved', false, []],
    [definition + '\ncustom_obj$inner$', 'unresolved-dispatch', false, []],
    [definition + '\nmake_object()$inner$', undefined, true, ['secret']],
    ['obj <- list()\nobj$', undefined, true, []],
    ['obj <- list(alpha = 1)\nobj$missing', undefined, true, []],
    ['make_object()[["se', 'unsupported-context', false, []],
    ['again <- function() again()\nagain()$', 'analysis-limit', false, []],
  ]) {
    const lines = text.split('\n'), line = lines.at(-1);
    const position = { line: lines.length - 1, character: line.length };
    const doc = { getText: () => text, uri: client.inputDocument.uri };
    const context = completion.getStaticCompletionContext(line, line.length, text);
    const result = await completeStatic(client, doc, position, context.triggerCharacter);
    assert.equal(result.rConsoleStaticUnavailableReason, reason, text);
    // This source-only fixture has no live bindings to mask native inference.
    const entries = await completion.collectStaticFallbackEntries(context, doc, position,
      lines.slice(0, -1), client, {
        bindings: createGuardedBindingResolver(async () => ({ status: 'missing' })),
      });
    assert.equal(entries.staticResolved, resolved, text);
    assert.equal(entries.staticUnavailableReason, reason, text);
    assert.deepEqual(entries.map(entry => entry.label), labels, text);
  }
});

test("native S3 arguments retain their resolved method and presentation role", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  const text = 'df <- data.frame(alpha = 1)\nsubset(df, )';
  const position = { line: 1, character: 11 };
  const context = completion.getCompletionContext('subset(df, )', 11, text.slice(0, text.length - 1), ')');
  const entries = await collectStaticEntries(client, context,
    { getText: () => text, uri: client.inputDocument.uri }, position, undefined, [text.split('\n')[0]], []);
  assert.deepEqual(entries.filter(item => item.role === 'argument').map(item => item.label), ['subset', 'select', 'drop']);
  assert.ok(entries.find(item => item.label === 'drop').detail.includes('drop = FALSE'));
});

test("live function arguments survive native S3 inference while source and package calls keep precedence", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  const setup = 'print <- function(x, custom_arg) NULL\n';
  const provider = {
    ...staticFixtureProvider(client),
    getCallContext: client.getCallContext.bind(client),
    provideCompletionItems: async (...args) => {
      const result = await client.provideCompletionItems(...args);
      return { ...result, items: result.items.map(item => ({ ...item, kind: item.kind - 1 })) };
    },
  };
  for (const [marked, expected, workspaceCall, shadow = true, selected = false] of [
    ['print(data.frame(a=1), │)', 'custom_arg = ', true],
    ['print(data.frame(a=1), cus│)', 'custom_arg = ', true],
    ['print(data.frame(a=1), custom_arg=1, │)', undefined, true],
    ['base::print(data.frame(a=1), │)', 'digits = ', false],
    ['print(data.frame(a=1), │)', 'digits = ', false, false],
    ['print <- function(x, source_arg) NULL\nprint(data.frame(a=1), │)', 'source_arg = ', false],
    ['print(data.frame(a=1), │)', 'digits = ', false, true, true],
  ]) {
    const cursor = marked.indexOf('│'), text = marked.replace('│', '');
    const before = text.slice(0, cursor), lines = text.split('\n');
    const row = before.split('\n').length - 1, col = before.split('\n').at(-1).length;
    if (workspaceCall && expected) {
      // R may also list S3 method arguments. The live callable's own argument
      // must remain available regardless of those optional additional results.
      const reference = runRJson(setup + `
        utils:::.assignLinebuffer(inputs)
        utils:::.assignEnd(nchar(inputs))
        invisible(utils:::.guessTokenFromLine())
        invisible(utils:::.completeToken())
        cat(jsonlite::toJSON(utils:::.retrieveCompletions()))
      `, before);
      assert.ok(reference.includes('custom_arg='), marked);
    }
    client.updateInput('');
    client.setRuntimeSignatures(shadow ? { print: 'function(x, custom_arg)' } : {});
    const staticMode = !shadow || marked.includes('print <- function');
    client.setStaticAnalysis(staticMode);
    if (selected) {
      client.updateInput(text);
      client.recordCompletion(text, 0, { insertText: 'print()', source: 'lsp', packageName: 'base' });
    }
    let probes = 0;
    const entries = await completion.collectCompletionEntries(
      completion.getCompletionContext(lines[row], col, before, text.slice(cursor)),
      { version: 1, getText: () => text, uri: client.inputDocument.uri }, { line: row, character: col },
      shadow ? { globalenv: { print: { type: 'closure' } } } : undefined,
      lines.slice(0, row), [], provider, async () => { probes++; },
      undefined, undefined, staticMode ? 'static' : 'runtime', staticFixtureAccess());
    assert.equal(probes, 0, marked);
    if (expected) assert.ok(entries.some(entry => entry.insertText === expected), marked);
    else assert.deepEqual(entries, [], marked);
    if (!workspaceCall) assert.ok(entries.every(entry => entry.insertText !== 'custom_arg = '), marked);
  }
});

test("source bindings inside blocks override inferred S3 signatures and live functions", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  const provider = {
    ...staticFixtureProvider(client),
    getCallContext: client.getCallContext.bind(client),
    provideCompletionItems: async (...args) => {
      const result = await client.provideCompletionItems(...args);
      return { ...result, items: result.items.map(item => ({ ...item, kind: item.kind - 1 })) };
    },
  };
  client.setRuntimeSignatures({ print: 'function(x, custom_arg)' });
  for (const [marked, expected] of [
    ['print(data.frame(a=1), │)', ['custom_arg = ']],
    ['print(x=data.frame(a=1), │)', ['custom_arg = ']],
    ['{ print <- function(x, source_arg) NULL; print(data.frame(a=1), │) }', ['source_arg = ']],
    ['{ print <- function(x, source_arg) NULL; print(x=data.frame(a=1), │) }', ['source_arg = ']],
    ['{ print <- function(x, source_arg) NULL; print(data.frame(a=1), sou│) }', ['source_arg = ']],
    ['{ print <- function(x, source_arg) NULL; print(data.frame(a=1), source_arg=1, │) }', []],
    ['{ print <- function() NULL; print(data.frame(a=1), │) }', []],
    ['{ print <- get("identity"); print(data.frame(a=1), │) }', []],
    ['g <- function(print) { print(data.frame(a=1), │) }', []],
    ['{ print <- function(x, mode=c("auto", "manual")) NULL; print(data.frame(a=1), mode="aut│") }', ['auto']],
  ]) {
    const cursor = marked.indexOf('│'), text = marked.replace('│', '');
    const staticMode = marked.includes('<-');
    client.setStaticAnalysis(staticMode);
    let probes = 0;
    const entries = await completion.collectCompletionEntries(
      completion.getCompletionContext(text, cursor),
      { version: 1, getText: () => text, uri: client.inputDocument.uri }, { line: 0, character: cursor },
      { globalenv: { print: { type: 'closure' } } }, [], [], provider, async () => { probes++; },
      undefined, undefined, staticMode ? 'static' : 'runtime', staticFixtureAccess());
    const argumentsAndValues = entries.filter(item => item.role === 'argument' || item.role === 'value' ||
      item.detail === 'parameter' || item.detail?.startsWith('value for '));
    assert.deepEqual(argumentsAndValues.map(item => item.insertText), expected, marked);
    if (!expected.length) assert.deepEqual(entries, [], marked);
    assert.equal(probes, 0, marked);
  }
});

test("source-defined member arguments use native inference without a live-session probe", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  for (const [line, expected] of [['obj$fun(', 'arg = '], ['obj$choose(mode = "a', 'auto']]) {
    const first = 'obj <- list(fun = function(arg) NULL, choose = function(mode = c("auto", "manual")) NULL)';
    const text = first + '\n' + line;
    const context = completion.getCompletionContext(line, line.length, text);
    let probes = 0;
    const entries = await collectStaticEntries(client, context,
      { getText: () => text, uri: client.inputDocument.uri }, { line: 1, character: line.length }, undefined,
      [first], [], async () => { probes++; return [{ name: 'stale' }]; });
    assert.ok(entries.some(item => item.insertText === expected), line);
    assert.equal(probes, 0);
  }
});

test("receiver-only static inference uses the shared path across object systems", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  const marker = path.join(os.tmpdir(), 'r-console-oop-getter-' + randomBytes(8).toString('hex'));
  t.after(() => fs.rmSync(marker, { force: true }));
  const effect = `file.create(${JSON.stringify(marker)})`;
  for (const [definition, input, expected] of [
    ['obj <- list(stored = 1)', 'obj$', ['stored']],
    [`Example <- R6::R6Class("Example", public = list(stored = 1), active = list(computed = function(value) { ${effect}; 1 })); obj <- Example$new()`,
      'obj$', ['stored', 'computed']],
    ['methods::setClass("Example", slots = c(stored = "numeric")); obj <- methods::new("Example", stored = 1)',
      'obj@', ['stored']],
    [`Example <- S7::new_class("Example", properties = list(stored = S7::class_numeric, computed = S7::new_property(S7::class_numeric, getter = function(self) { ${effect}; 1 }))); obj <- Example(stored = 1)`,
      'obj@', ['stored', 'computed']],
  ]) {
    const text = definition + '\n' + input;
    const context = completion.getCompletionContext(input, input.length, text);
    const entries = await retryStaticCompletion(() => completion.collectStaticFallbackEntries(context,
      { getText: () => text, uri: client.inputDocument.uri }, { line: 1, character: input.length },
      [definition], { provideStaticCompletion: async request => {
        const outcome = await client.provideStaticCompletion(request);
        const result = outcome.completion;
        return { ...outcome, completion: result && {
          ...result, items: result.items.map(item => ({ ...item, kind: item.kind - 1 })),
        } };
      } }));
    assert.equal(entries.staticResolved, true, `${definition}: ${entries.staticUnavailableReason ?? 'resolved'}`);
    for (const label of expected) assert.ok(entries.some(item => item.label === label), definition + ': ' + label);
    assert.ok(entries.every(item => item.role === 'member'), definition);
    assert.equal(fs.existsSync(marker), false, 'inference must not run a getter');
  }
});

test("native constructor signatures exclude supplied arguments without runtime fallbacks", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  for (const [line, expected] of [
    ['Thing$new(', ['value', 'other']],
    ['Thing$new(value=1, ', ['other']],
    ['Thing$new(value=1, other=2, ', []],
  ]) {
    const first = 'Thing <- R6::R6Class("Thing", public = list(initialize = function(value, other = 1) NULL))';
    const text = first + '\n' + line;
    const context = completion.getCompletionContext(line, line.length, text);
    let probes = 0;
    const entries = await collectStaticEntries(client, context,
      { getText: () => text, uri: client.inputDocument.uri }, { line: 1, character: line.length }, undefined,
      [first], [], async () => { probes++; return [{ name: 'stale' }]; });
    assert.deepEqual(entries.filter(item => item.role === 'argument').map(item => item.label), expected, line);
    assert.equal(probes, 0);
  }
});

test("exhausted fixed-arity calls suppress all completion sources", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  const session = { globalenv: { runtime_function: { type: 'closure' }, runtime_value: { type: 'double' } } };
  for (const [marked, exhausted] of [
    ['base::atan2(1,2, │)', true], ['base::atan2(y=1,x=2, │)', true],
    ['base::atan2(1, │, 2)', true], ['1 |> base::atan2(2, │)', true],
    ['base::atan2(1,2, run│)', true],
    ['base::Sys.time(│)', true], ['Sys.time(│)', true],
    ['f <- function() NULL\nf(│)', true],
    ['f <- function(a,b) NULL\nf(1,2, │)', true],
    ['base::atan2(1, run│)', false], ['base::atan2(1, x=run│)', false],
    ['base::list(1,2, run│)', false], ['unknown_function(1,2, run│)', false],
    ['base::unknown_function(1,2, run│)', false],
    ['f <- function(a,...) NULL\nf(1,2, run│)', false],
    ['g <- function(f) { f(run│) }', false],
    ['g <- function(atan2) { atan2(1,2, run│) }', false],
    ['g <- function(f = stop("must not evaluate")) { f(run│) }', false],
    ['f <- get("identity")\nf(run│)', false],
  ]) {
    const cursor = marked.indexOf('│'), text = marked.replace('│', '');
    const before = text.slice(0, cursor), lines = text.split('\n');
    const row = before.split('\n').length - 1, col = before.split('\n').at(-1).length;
    const context = completion.getCompletionContext(lines[row], col, before, text.slice(cursor));
    const entries = await collectStaticEntries(client, context,
      { getText: () => text, uri: client.inputDocument.uri }, { line: row, character: col }, session,
      lines.slice(0, row), ['recent_symbol']);
    if (exhausted) assert.equal(entries.length, 0, marked);
    else assert.ok(entries.some(item => item.label === 'runtime_function'), marked);
  }
});

test("unquoted list indices prioritize matching index variables", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  const text = 'lst <- list(alpha = 10, beta = 20)\nindex <- "beta"\nlst[[ind]]';
  const line = text.split('\n').at(-1), col = line.indexOf(']]');
  const context = completion.getCompletionContext(line, col, text.slice(0, -2), ']]');
  const session = { globalenv: { lst: { names: ['alpha', 'beta'] }, index: { type: 'character' } } };
  const entries = await collectStaticEntries(client, context,
    { getText: () => text, uri: client.inputDocument.uri }, { line: 2, character: col }, session,
    text.split('\n').slice(0, 2), []);
  assert.deepEqual(entries.map(item => item.label), ['index']);
  assert.equal(entries[0].insertText, 'index');
});

test("sess argument exhaustion preserves variadic and unknown signatures", { timeout: 90000 }, async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t);
  const session = { globalenv: { f: { type: 'closure' }, runtime_function: { type: 'closure' } } };
  for (const [definition, marked, exhausted] of [
    ['function(a,b) NULL', 'f(1,2, │)', true],
    ['function(a,b) NULL', 'f(1, run│)', false],
    ['function() NULL', 'f(│)', true],
    ['function(a,...) NULL', 'f(1,2, run│)', false],
    ['function(...) NULL', 'f(1,2, run│)', false],
  ]) {
    const text = marked.replace('│', ''), cursor = marked.indexOf('│');
    client.setRuntimeSignatures({ f: definition.replace(/ NULL$/, '') });
    const entries = await completion.collectCompletionEntries(completion.getCompletionContext(text, cursor),
      { getText: () => text }, { line: 0, character: cursor }, session, [], [], { provideCompletionItems: async (...args) => {
        const result = await client.provideCompletionItems(...args);
        return { ...result, items: result.items.map(item => ({ ...item, kind: item.kind - 1 })) };
      } }, async () => assert.fail("arguments must not query sess"));
    if (exhausted) assert.equal(entries.length, 0, marked);
    else assert.ok(entries.some(entry => entry.label === 'runtime_function'), marked);
  }
  const unknown = await completion.collectCompletionEntries(completion.getCompletionContext('f(1,2, run', 10),
    undefined, undefined, session, [], [], undefined, async () => undefined);
  assert.ok(unknown.some(entry => entry.label === 'runtime_function'));
});

test("completion sources stay inside every R cursor context", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  const session = { globalenv: {
    global_function: { type: 'closure' }, global_value: { type: 'double' },
    df: { class: ['data.frame'], names: ['zebra', 'alpha', 'beta'] },
    object: { names: ['alpha', 'beta'] }, slot_object: { slots: ['slot_alpha', 'slot_beta'] },
  } };
  const collect = async marked => {
    const cursor = marked.indexOf('│'), text = marked.replace('│', '');
    const before = text.slice(0, cursor), lines = text.split('\n');
    const row = before.split('\n').length - 1, col = before.split('\n').at(-1).length;
    const context = completion.getCompletionContext(lines[row], col, before, text.slice(cursor));
    return collectStaticEntries(client, context, { getText: () => text, uri: client.inputDocument.uri },
      { line: row, character: col }, session, lines.slice(0, row), ['global_history']);
  };
  const labels = entries => entries.map(item => item.label);
  for (const [marked, expected] of [
    ['object$│', ['alpha', 'beta']], ['slot_object@│', ['slot_alpha', 'slot_beta']],
    ['df[["│"]]', ['zebra', 'alpha', 'beta']], ['df[, "│"]', ['zebra', 'alpha', 'beta']],
    ['stats::cor(method = df[["│"]])', ['zebra', 'alpha', 'beta']],
    ['stats::cor(method = "│")', ['pearson', 'kendall', 'spearman']],
  ]) assert.deepEqual(labels(await collect(marked)), expected, marked);
  for (const marked of ['base::ata│', 'base:::ata│']) {
    const entries = await collect(marked);
    assert.ok(entries.some(item => item.insertText === 'atan2()'), marked);
    assert.ok(entries.every(item => item.source === 'lsp'), marked);
  }
  for (const marked of ['df |> │', 'df %>% │']) {
    const entries = await collect(marked);
    assert.ok(entries.some(item => item.label === 'global_function'), marked);
    assert.ok(entries.every(item => [1, 2, 3].includes(item.kind)), marked);
  }
  for (const marked of ['subset(df, │)', 'df |> subset(│)', 'with(df, │)',
    'subset(x = df, │)', 'with(data = df, │)', 'transform(`_data` = df, │)']) {
    const entries = await collect(marked);
    assert.deepEqual(labels(entries.filter(item => item.kind === 4)), ['zebra', 'alpha', 'beta'], marked);
    assert.ok(entries.some(item => item.role === 'argument'), marked);
    assert.ok(entries.every(item => item.role === 'argument' || item.role === 'value' || item.kind === 4), marked);
  }
  for (const marked of ['df[│]', 'df[, │]', 'df[[│]]']) {
    const entries = await collect(marked);
    assert.deepEqual(labels(entries.filter(item => item.kind === 4)), ['zebra', 'alpha', 'beta'], marked);
    assert.ok(entries.every(item => item.kind === 4), marked);
  }
  for (const marked of ['df |> print(│)', 'df |> stats::filter(│)', 'stats::filter(df, │)']) {
    const entries = await collect(marked);
    assert.ok(!entries.some(item => item.kind === 4), marked);
    assert.ok(!entries.some(item => item.label.startsWith('global_')), marked);
  }
  const ordinary = labels(await collect('global_│'));
  for (const name of ['global_function', 'global_value', 'global_history']) assert.ok(ordinary.includes(name));
  const args = await collect('base::atan2(y=1, │)');
  assert.ok(args.some(item => item.insertText === 'x = '));
  assert.ok(args.every(item => item.insertText !== 'y = '));
  assert.deepEqual(await collect('base::atan2(y=│)'), []);
  const value = await collect('base::atan2(y=glo│)');
  assert.ok(value.some(item => item.label === 'global_value'));
  assert.ok(value.every(item => item.role !== 'argument'));
  for (const marked of ['stats::cor(method = x + pea│)', 'stats::cor(method = !pea│)',
    'f <- function(method = c("pearson", "spearman")) NULL\nf(x + pea│)']) {
    assert.ok((await collect(marked)).every(item => item.role !== 'value'), marked);
  }
});

test("variadic completion retains dots after supplied arguments without leaking into values", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  const reference = runRJson(`
    results <- lapply(inputs, function(line) {
      utils:::.assignLinebuffer(line)
      utils:::.assignEnd(nchar(line))
      utils:::.guessTokenFromLine()
      utils:::.completeToken()
      utils:::.retrieveCompletions()
    })
    cat(jsonlite::toJSON(results))
  `, ['data.frame(', 'data.frame(row.names = NULL, ', 'data.frame(..., row.names = NULL, ']);
  for (const candidates of reference) assert.ok(candidates.includes('...'), 'R reference completer retains dots');
  for (const [marked, expected] of [
    ['data.frame(│)', true], ['base::data.frame(row.names = NULL, │)', true],
    ['data.frame(xxxx, row.names = NULL, │)', true], ['data.frame(..., row.names = NULL, │)', true],
    ['data.frame(.│)', true], ['data.frame(xxxx│)', false], ['data.frame(row.names = │)', false],
    ['f <- function(first, ..., last) NULL\nf(first = 1, last = 2, │)', true],
    ['f <- function(...) NULL\nf(1, 2, │)', true], ['base::atan2(1,2, │)', false],
    ['base::atan2(..., │)', false], ['base::atan2(1,2,..., │)', false],
  ]) {
    const cursor = marked.indexOf('│'), text = marked.replace('│', ''), before = text.slice(0, cursor);
    const lines = text.split('\n'), row = before.split('\n').length - 1, col = before.split('\n').at(-1).length;
    const context = completion.getCompletionContext(lines[row], col, before, text.slice(cursor));
    const entries = await collectStaticEntries(client, context,
      { getText: () => text, uri: client.inputDocument.uri }, { line: row, character: col }, undefined,
      lines.slice(0, row), []);
    const dots = entries.find(entry => entry.label === '...');
    assert.equal(!!dots, expected, marked);
    if (dots) { assert.equal(dots.insertText, '...'); assert.equal(dots.role, 'argument'); }
    if (marked.includes('row.names = NULL')) assert.ok(!entries.some(entry => entry.insertText === 'row.names = '), marked);
    if (marked === 'base::atan2(..., │)') assert.deepEqual(entries.map(entry => entry.label), ['y', 'x']);
    if (marked === 'base::atan2(1,2,..., │)') assert.deepEqual(entries, []);
  }
});

test("workspace subscript columns respect receiver class and dimensions without sess expressions", async () => {
  const workspace = { globalenv: {
    DT: { class: ['data.table', 'data.frame'], names: ['alpha', 'beta'], type: 'list' },
    df: { class: ['data.frame'], names: ['alpha', 'beta'], type: 'list' },
    lst: { names: ['alpha', 'beta'], type: 'list' },
  } };
  for (const [marked, expected] of [
    ['DT[, │]', ['alpha', 'beta']], ['df[, │]', ['"alpha"', '"beta"']],
    ['lst[[│]]', ['"alpha"', '"beta"']], ['df[│, ]', []], ['DT[, by = │]', ['alpha', 'beta']],
    ['unknown[[│]]', []], ['lst$nested[[│]]', []],
  ]) {
    const cursor = marked.indexOf('│'), text = marked.replace('│', '');
    const entries = await completion.collectCompletionEntries(completion.getCompletionContext(text, cursor),
      undefined, undefined, workspace, [], [], undefined, async () => assert.fail('no bracket expressions'));
    assert.deepEqual(entries.filter(item => item.kind === 4).map(item => item.insertText), expected, marked);
  }
});

test("safe runtime bracket completion retains installed method arguments and specials without attaching data.table", { timeout: 90000 }, async t => {
  const { client, instances } = require("./helpers/console-lsp.cjs").createConsoleLsp(t, { staticAnalysis: false });
  const workspace = { globalenv: {
    test: { type: "list", class: ["data.table", "data.frame"], names: ["xtest"] },
    df: { type: "list", class: "data.frame", names: "xtest" },
    custom: { type: "list", class: ["custom", "data.table"], names: ["xtest"] },
  } };
  client.options.getCachedWorkspaceData = () => workspace;
  await client.syncSessionState({ attachedPackages: ["stats", "base"] });
  const inspected = [];
  const collect = async marked => {
    const cursor = marked.indexOf("│"), text = marked.replace("│", "");
    const context = completion.getCompletionContext(text, cursor);
    assert.equal(context.kind, "bracket", marked);
    return completion.collectCompletionEntries(context,
      { getText: () => text, uri: client.inputDocument.uri },
      { line: 0, character: cursor }, workspace, [], [],
      { provideCompletionItems: async (...args) => {
        const raw = await client.provideCompletionItems(...args);
        return { ...raw, items: raw.items.map(item => ({ ...item, kind: item.kind - 1 })) };
      } },
      async (receiver, operator) => {
        inspected.push([receiver, operator]);
        return { status: "available", names: ["xtest"],
          bracketKind: receiver === "test" ? "data.table" : "data.frame" };
      });
  };
  const columns = await collect("test[, xt│]");
  assert.ok(columns.some(item => item.label === "xtest" &&
    item.source === "session" && item.insertText === "xtest"));
  const indexed = await collect("test[, xtest, key│]");
  assert.ok(indexed.some(item => item.label === "keyby" && item.insertText === "keyby = " &&
    item.role === "argument"), "the third bracket position must complete installed [.data.table formals");
  const empty = await collect("test[, xtest, │]");
  for (const name of ["by", "keyby", ".SDcols", "with", "nomatch", "mult",
    "roll", "rollends", "which", "verbose", "allow.cartesian", "drop", "on", "env",
    "showProgress"]) {
    assert.ok(empty.some(item => item.label === name && item.insertText === name + " = "),
      "missing installed method parameter " + name);
  }
  const special = await collect("test[, .S│]");
  assert.ok(special.some(item => item.label === ".SD" &&
    item.bracketSpecial === true && item.insertText === ".SD"),
    ".SD must be sourced from the installed namespace, not from guessed columns");
  const frame = await collect("df[, dr│]");
  assert.ok(frame.some(item => item.label === "drop" && item.insertText === "drop = "));
  assert.ok(!(await collect("df[, .S│]")).some(item => item.bracketSpecial),
    "base data.frame indexing must not receive data.table symbols");
  assert.ok(!(await collect("custom[, key│]")).some(item => item.label === "keyby"),
    "do not infer data.table method metadata through a custom leading class");
  assert.deepEqual(inspected, [
    ["test", "["], ["test", "["], ["test", "["], ["test", "["],
    ["df", "["], ["df", "["], ["custom", "["],
  ]);
  const requests = instances.flatMap(instance => instance.requests)
    .filter(entry => entry.method?.method === "textDocument/completion" ||
      entry.method === "textDocument/completion");
  assert.ok(requests.length >= 7, "all cases must exercise the real language server");
  for (const request of requests) {
    assert.equal(request.params.rConsoleStaticAnalysis, undefined,
      "runtime completion must never activate source inference");
  }
  const unsafe = completion.getCompletionContext("make_data()[, key", "make_data()[, key".length);
  assert.equal(unsafe.rejectionReason, "executable-receiver");
  assert.deepEqual(await completion.collectCompletionEntries(
    unsafe, undefined, undefined, workspace, [], [],
    { provideCompletionItems: () => assert.fail("rejected receiver reached language server") },
    () => assert.fail("rejected receiver reached native inspector")), []);
});

test("installed bracket methods use guarded receiver classification without sess class metadata", { timeout: 90000 }, async t => {
  const { client } = require("./helpers/console-lsp.cjs").createConsoleLsp(t, { staticAnalysis: false });
  await client.syncSessionState({ attachedPackages: ["stats", "base"] });
  const collect = async (marked, nativeKind) => {
    const cursor = marked.indexOf("│"), input = marked.replace("│", "");
    const context = completion.getCompletionContext(input, cursor);
    assert.equal(context.kind, "bracket", marked);
    assert.ok(context.objectName === "test" || context.objectName === "test2");
    return completion.collectCompletionEntries(
      context, { getText: () => input, uri: client.inputDocument.uri },
      { line: 0, character: cursor }, undefined, [], [], {
        provideCompletionItems: async (...args) => {
          const response = await client.provideCompletionItems(...args);
          return { ...response, items: response.items.map(item => ({ ...item, kind: item.kind - 1 })) };
        },
      }, undefined, input, Promise.resolve({
        status: "available", names: ["xtest"], bracketKind: nativeKind,
      }));
  };
  // Neither receiver exists in the LSP's cached globals. Only the prior,
  // safely bounded native inspection supplies reliable class metadata.
  const table = await collect("test[, xtest, key│]", "data.table");
  assert.ok(table.some(item => item.label === "keyby" && item.insertText === "keyby = "));
  const symbols = await collect("test[, .S│]", "data.table");
  assert.ok(symbols.some(item => item.label === ".SD" && item.bracketSpecial));
  const frame = await collect('test2[, "xtest", dr│]', "data.frame");
  assert.ok(frame.some(item => item.label === "drop" && item.insertText === "drop = "));
  const completed = await collect('test2[, "xtest", │]', "data.frame");
  assert.ok(completed.some(item => item.label === "drop" && item.insertText === "drop = "));
  for (const marked of ['test[1, mult = "│"]', 'test[1, roll = │]', 'test[1, nomatch = │]']) {
    assert.ok(!(await collect(marked, "data.table")).some(item => item.label === "xtest"), marked);
  }
  for (const [marked, insertText] of [
    ['test[, by = │]', 'xtest'], ['test[, keyby = │]', 'xtest'],
    ['test[, .SDcols = │]', '"xtest"'], ['test[1, on = │]', '"xtest"'],
  ]) {
    assert.ok((await collect(marked, "data.table")).some(item =>
      item.label === "xtest" && item.insertText === insertText), marked);
  }
  for (const [marked, expected] of [
    ['test2[i = │]', true], ['test2[j = │]', false],
    ['test2[i = │, ]', false], ['test2[, j = │]', true],
  ]) {
    assert.equal((await collect(marked, "data.frame")).some(item =>
      item.label === "xtest" && item.insertText === '"xtest"'), expected, marked);
  }
});

test("subscript symbols and fields come from the real language server", { timeout: 90000 }, async t => {
  const { client } = require('./helpers/console-lsp.cjs').createConsoleLsp(t);
  await client.syncSessionState({ attachedPackages: ['data.table', 'stats', 'base'] });
  const collect = async marked => {
    marked = 'DT <- data.table::data.table(alpha = 1, beta = 2); df <- as.data.frame(DT)\n' + marked;
    const cursor = marked.indexOf('│'), text = marked.replace('│', '');
    const before = text.slice(0, cursor), lines = text.split('\n');
    const row = before.split('\n').length - 1, col = before.split('\n').at(-1).length;
    const context = completion.getCompletionContext(lines[row], col, before, text.slice(cursor));
    return collectStaticEntries(client, context, { getText: () => text, uri: client.inputDocument.uri },
      { line: row, character: col }, undefined, lines.slice(0, row), [],
      async () => assert.fail("source inference must not query sess"));
  };
  for (const [marked, insertion] of [['DT[, fca│]', 'fcase()'], ['df[, mea│]', 'mean()']]) {
    assert.ok((await collect(marked)).some(e => e.kind === 2 && e.insertText === insertion), marked);
  }
  const specials = await collect('DT[, .N│]');
  assert.equal(specials.filter(e => e.label === '.N').length, 1);
  assert.ok(specials.some(e => e.label === '.N' && e.source === 'lsp'));
  // Follow R's visible-symbol provider; the console must not maintain a
  // separate slot-specific blacklist of package exports.
  assert.ok((await collect('DT[.S│]')).some(e => e.label === '.SD'));
  const values = await collect('DT[, keyby = al│]');
  assert.ok(values.every(e => e.role !== 'argument'));
  const source = 'DT <- data.table::data.table(alpha = 1, beta = 2)\n';
  assert.deepEqual(await collect(source + 'DT[, mult = "│"]'), []);
});
