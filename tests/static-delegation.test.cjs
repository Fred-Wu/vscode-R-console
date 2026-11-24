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

test('static inference never executes draft definitions, defaults or accessors', () => {
  const result = runRJson(setup + String.raw`
    marker <- tempfile()
    code <- paste0('f <- function(alpha = { writeLines("default", "', marker,
      '"); stop("default ran") }) { writeLines("body", "', marker,
      '"); stop("body ran") }; f(|CURSOR|)')
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
