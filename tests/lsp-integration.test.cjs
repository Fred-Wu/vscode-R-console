const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const loadSource = require("./helpers/load-source.cjs");
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
  const requestMemberCompletions = async (expression, operator) => JSON.parse(execFileSync(
    "Rscript", ["--vanilla", "-e", `
      obj <- list(lm = function(member_arg) stop("must not execute"))
      methods::setClass("InlineCompletionTest", slots = c(lm = "function"))
      slot_obj <- methods::new("InlineCompletionTest", lm = function(slot_arg) stop("must not execute"))
      value <- eval(parse(text = commandArgs(TRUE)[1]), .GlobalEnv)
      slots <- identical(commandArgs(TRUE)[2], "@")
      nms <- if (slots) methods::slotNames(value) else names(value)
      cat(jsonlite::toJSON(lapply(nms, function(n) list(name = n,
        type = typeof(if (slots) methods::slot(value, n) else value[[n]]))), auto_unbox = TRUE))
    `, expression, operator], { encoding: "utf8", timeout: 15000 }));
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
    assert.equal(terminal.inputState.text, expected, "argument popup must not insert or execute anything");
    const buffer = screen.buffer.active;
    const visible = Array.from({ length: 24 }, (_, row) => buffer.getLine(buffer.baseY + row).translateToString(true)).join("\n");
    assert.ok(visible.includes("Arguments"), expected);
    terminal.dismissInlineCompletion(false);
    terminal.lang.cancelCompletion();
  }
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
  for (const name of ["élm", "𐐀lm"]) {
    const input = `${name} <- function(correct_argument) {}; outer(${name}\n())`;
    const position = { line: 1, character: 1 };
    let parameters;
    const deadline = Date.now() + 10000;
    do {
      const result = await client.provideCompletionItems({ getText: () => input }, position);
      parameters = (Array.isArray(result) ? result : result?.items ?? [])
        .filter(item => item.detail === "parameter").map(item => item.label);
      if (parameters.includes("correct_argument")) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.deepEqual(parameters, ["correct_argument"], input);
    assert.equal(instances.at(-1).requests.at(-1).params.rConsoleCall, name);
  }
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
    assert.ok(requests.every(request => request.params.rConsoleCall === undefined), input);
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
    𐐀obj <- list(lm = function(correct_argument) stop("body called"))
    obj$unicode <- function(éarg, 𐐀arg, remaining) stop("body called")
    obj$pair <- function(first, second) stop("body called")
    .args <- .fn <- "unchanged"
  `;
  for (const [expression, expected, argumentsBefore = "", argumentsAfter = ""] of [
    ["obj$lm", ["list_argument", "missing", "lazy"]],
    ["éobj$lm", ["correct_argument"]],
    ["obj$élm", ["correct_argument"]],
    ["𐐀obj$lm", ["correct_argument"]],
    ["obj$unicode", ["remaining"], 'éarg = stop("value evaluated"), 𐐀arg = stop("value evaluated"), '],
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
        const result = execFileSync("Rscript", ["--vanilla", "-e", setup, "-e", `
          options(warn = 2, warnPartialMatchArgs = TRUE)
          value <- tryCatch(eval(parse(text = commandArgs(TRUE)[1]), .GlobalEnv), error = function(e) NULL)
          stopifnot(identical(.args, "unchanged"), identical(.fn, "unchanged"))
          cat(jsonlite::toJSON(lapply(names(value), function(n) list(name = n)), auto_unbox = TRUE))
        `, probe], { encoding: "utf8", timeout: 15000 });
        return JSON.parse(result);
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
  const nativeCalls = JSON.parse(execFileSync("Rscript", ["--vanilla", "-e", `
    has_call <- function(x) {
      if (!(is.call(x) || is.expression(x))) return(FALSE)
      if (is.call(x) && identical(x[[1]], quote(obj$fun))) return(TRUE)
      any(vapply(as.list(x), has_call, logical(1)))
    }
    inputs <- jsonlite::fromJSON(commandArgs(TRUE)[1])
    cat(jsonlite::toJSON(vapply(inputs, function(input) has_call(parse(text = input)), logical(1))))
  `, JSON.stringify(cases.map(([input]) => input))], { encoding: "utf8", timeout: 15000 }));
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
  const results = JSON.parse(execFileSync("Rscript", ["--vanilla", "-e", `
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
    inputs <- jsonlite::fromJSON(file("stdin"), simplifyVector = FALSE)
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
  `], { input: JSON.stringify({ cases, probes }), encoding: "utf8", timeout: 15000 }));
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
