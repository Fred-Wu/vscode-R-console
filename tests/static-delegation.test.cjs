const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runRJson } = require('./helpers/run-r-json.cjs');

// Exercise the real parser/recovery/inference engine without starting a socket
// server. Console input is data: these fixtures are never sourced or evaluated.
const setup = String.raw`
  source('resources/r/completion-static.R')
  fixture <- function(marked) {
    before <- strsplit(marked, '|CURSOR|', fixed = TRUE)[[1L]][[1L]]
    content <- strsplit(sub('|CURSOR|', '', marked, fixed = TRUE), '\n', fixed = TRUE)[[1L]]
    lines <- strsplit(before, '\n', fixed = TRUE)[[1L]]
    point <- list(row = length(lines) - 1L, col = nchar(tail(lines, 1L)))
    uri <- 'r-console://delegation/console.R'
    document <- languageserver:::Document$new(uri, language = 'r', version = 1L, content = content)
    parsed <- languageserver:::parse_document(uri, content)
    parsed$version <- document$version
    document$update_parse_data(parsed)
    workspace <- list(member_metadata = collections::dict())
    list(document = document, point = point, uri = uri, workspace = workspace)
  }
  lookup <- function(f, name = 'f') console_source_function(f$document, f$point, name, f$uri, f$workspace)
`;

test('native source inference supplies signatures and preserves unknown shadowing', () => {
  const result = runRJson(setup + String.raw`
    out <- lapply(inputs, function(code) {
      binding <- lookup(fixture(code))
      list(unknown = isTRUE(binding$unknown), names = as.list(names(binding$formals)),
        source = isTRUE(binding$source_binding))
    })
    cat(jsonlite::toJSON(out, auto_unbox = TRUE))
  `, [
    'f <- function(alpha, beta) NULL; f(|CURSOR|)',
    'f <- (function(alpha) NULL); f(|CURSOR|)',
    '(function(alpha) NULL) -> f; f(|CURSOR|)',
    'g <- function(alpha) NULL; f <- g; f(|CURSOR|)',
    'f <- function() NULL; f(|CURSOR|)',
    'f <- function(outer) NULL; g <- function(f) { f(|CURSOR|) }',
    'f <- unknown_factory(); f(|CURSOR|)',
    'f <- function(outer) NULL; g <- function() { f <- function(inner) NULL; f(|CURSOR|',
    'f <- function(earlier) NULL; f <- function() { f(|CURSOR|) }',
  ]);
  assert.deepEqual(result, [
    { unknown: false, names: ['alpha', 'beta'], source: true },
    { unknown: false, names: ['alpha'], source: true },
    { unknown: false, names: ['alpha'], source: true },
    { unknown: false, names: ['alpha'], source: true },
    { unknown: false, names: [], source: true },
    { unknown: true, names: [], source: true },
    { unknown: true, names: [], source: true },
    { unknown: false, names: ['inner'], source: true },
    { unknown: true, names: [], source: true },
  ]);
});

test('opaque live bindings require positive native source evidence', () => {
  const result = runRJson(setup + String.raw`
    out <- lapply(inputs, function(code) {
      f <- fixture(code)
      position <- f$document$to_lsp_position(f$point$row, f$point$col)
      console_source_overrides_opaque('f', f$uri, f$workspace, f$document, position)
    })
    f <- fixture('f <- function(alpha) NULL; f(|CURSOR|)')
    position <- f$document$to_lsp_position(f$point$row, f$point$col)
    f$document$version <- f$document$version + 1L
    stale <- console_source_overrides_opaque('f', f$uri, f$workspace, f$document, position)
    cat(jsonlite::toJSON(list(overrides = out, stale = stale), auto_unbox = TRUE))
  `, [
    'f(|CURSOR|)',
    'f <- unknown_factory(); f(|CURSOR|)',
    'g <- function(f) { f(|CURSOR|) }',
    'f <- function(alpha) NULL; f(|CURSOR|)',
  ]);
  assert.deepEqual(result, { overrides: [false, false, false, true], stale: false });
});

test('native binding positions exclude later and unrelated declarations', () => {
  const result = runRJson(setup + String.raw`
    out <- lapply(inputs, function(code) {
      binding <- lookup(fixture(code))
      list(absent = is.null(binding), unknown = isTRUE(binding$unknown),
        names = as.list(names(binding$formals)))
    })
    cat(jsonlite::toJSON(out, auto_unbox = TRUE))
  `, [
    'f <- function(alpha) NULL; f(|CURSOR|); f <- function(beta) NULL',
    'f <- function(alpha) NULL; g <- function() { f <- function(beta) NULL }; f(|CURSOR|)',
    'f(|CURSOR|); f <- function(beta) NULL',
    'g <- function() { f <- function(beta) NULL }; f(|CURSOR|)',
    // An enclosing declaration remains relevant even with another later definition.
    'f <- function(earlier) NULL; f <- function() { f(|CURSOR|) }; f <- function(earlier) NULL',
    '(function(recursive) { f(|CURSOR|) }) -> f',
  ]);
  assert.deepEqual(result, [
    { absent: false, unknown: false, names: ['alpha'] },
    { absent: false, unknown: false, names: ['alpha'] },
    { absent: true, unknown: false, names: [] },
    { absent: true, unknown: false, names: [] },
    { absent: false, unknown: true, names: [] },
    { absent: false, unknown: true, names: [] },
  ]);
});

test('native definition metadata supports providers without a formals field', () => {
  const result = runRJson(setup + String.raw`
    out <- lapply(inputs, function(code) {
      f <- fixture(code)
      binding <- console_source_binding('f', f$uri, f$workspace, f$document, f$point)
      symbol <- languageserver:::member_symbol_info('f', binding$value,
        binding$value$function_key, binding$index)
      symbol$formals <- NULL
      signature <- console_native_formals(symbol, binding$index)
      list(unknown = signature$unknown, names = as.list(names(signature$formals)))
    })
    cat(jsonlite::toJSON(out, auto_unbox = TRUE))
  `, ['f <- function(alpha) NULL; f(|CURSOR|)',
    'g <- function(alpha) NULL; f <- g; f(|CURSOR|)',
    'f <- function() NULL; f(|CURSOR|)']);
  assert.deepEqual(result, [
    { unknown: false, names: ['alpha'] },
    { unknown: false, names: ['alpha'] },
    { unknown: false, names: [] },
  ]);
});

test('direct native formals distinguish an empty signature from unavailable metadata', () => {
  const result = runRJson(setup + String.raw`
    out <- lapply(list(
      list(formals = alist(alpha = ), signature = 'f(alpha)'),
      list(formals = NULL, signature = 'f()'),
      list(formals = NULL, signature = NULL)
    ), function(symbol) {
      binding <- console_native_formals(symbol, NULL)
      list(unknown = binding$unknown, names = as.list(names(binding$formals)))
    })
    cat(jsonlite::toJSON(out, auto_unbox = TRUE))
  `);
  assert.deepEqual(result, [
    { unknown: false, names: ['alpha'] },
    { unknown: false, names: [] },
    { unknown: true, names: [] },
  ]);
});

test('static literal requests use native parse queue cancellation and current-version replay', () => {
  const result = runRJson(String.raw`
    uri <- 'r-console://queue/console.R'
    document <- languageserver:::Document$new(uri, language = 'r', version = 2L,
      content = 'f <- function(choice = "new") NULL; f(choice = "n")')
    document$parse_data$version <- 1L
    queue <- collections::queue()
    delivered <- list()
    promoted <- 0L
    native_calls <- 0L
    self <- list(
      get_workspace = function(uri) list(documents = list(get = function(...) document)),
      pending_replies = list(get = function(uri) list('textDocument/completion' = queue)),
      parse_task_manager = list(promote = function(uri) { promoted <<- promoted + 1L }),
      deliver = function(reply) { delivered[[length(delivered) + 1L]] <<- reply })
    server <- list(request_handlers = list('textDocument/completion' = function(self, id, params) {
      native_calls <<- native_calls + 1L
      self$deliver(structure(list(id = id, result = list(items = list())), class = 'Response'))
    }))
    source('resources/r/completion-provider.R')
    console_supplement_completion <- function(reply, self, params) reply
    handler <- server$request_handlers[['textDocument/completion']]
    params <- list(textDocument = list(uri = uri), position = list(line = 0L, character = 47L),
      rConsoleStaticAnalysis = TRUE)
    handler(self, 1L, params)
    stopifnot(queue$size() == 1L, native_calls == 0L, !length(delivered))
    handler(self, 2L, params)
    stopifnot(queue$size() == 1L, native_calls == 0L, delivered[[1L]]$id == 1L,
      delivered[[1L]]$error$code == -32800L)
    document$parse_data$version <- document$version
    pending <- queue$pop()
    handler(self, pending$id, pending$params)
    stopifnot(native_calls == 1L, delivered[[2L]]$id == 2L, queue$size() == 0L)
    # Runtime-only requests retain native scheduling, including early literals.
    document$version <- 3L
    params$rConsoleStaticAnalysis <- FALSE
    handler(self, 3L, params)
    stopifnot(native_calls == 2L, queue$size() == 0L)
    cat(jsonlite::toJSON(list(promoted = promoted, native = native_calls), auto_unbox = TRUE))
  `);
  assert.deepEqual(result, { promoted: 2, native: 2 });
});

test('static inference never executes draft definitions, defaults or accessors', () => {
  const result = runRJson(setup + String.raw`
    marker <- tempfile()
    marker_literal <- encodeString(marker, quote = '"')
    code <- paste0('f <- function(alpha = { writeLines("default", ', marker_literal,
      '); stop("default ran") }) { writeLines("body", ', marker_literal,
      '); stop("body ran") }; f(|CURSOR|)')
    binding <- lookup(fixture(code))
    before <- options('width')
    unknown <- lookup(fixture('f <- { options(width = 999L); stop("draft ran") }; f(|CURSOR|)'))
    stopped <- lookup(fixture('f <- obj[[{ stop("index ran") }]]; f(|CURSOR|)'))
    cat(jsonlite::toJSON(list(names = as.list(names(binding$formals)),
      file = file.exists(marker), options = identical(before, options('width')),
      unknown = isTRUE(unknown$unknown), index = isTRUE(stopped$unknown)), auto_unbox = TRUE))
  `);
  assert.deepEqual(result, { names: ['alpha'], file: false, options: true, unknown: true, index: true });
});
