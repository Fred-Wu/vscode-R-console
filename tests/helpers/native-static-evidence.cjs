const { runRJson } = require('./run-r-json.cjs');

// An independent oracle: load only native languageserver APIs, with no console
// supplement or provider adapter. Input remains unexecuted source throughout.
const cache = new Map();
function nativeStaticEvidence(marked, scopePrefix) {
  const key = JSON.stringify([marked, scopePrefix]);
  if (!cache.has(key)) cache.set(key, runRJson(String.raw`
    cursor <- regexpr('│', inputs$marked, fixed = TRUE)[[1L]] - 1L
    before <- substr(inputs$marked, 1L, cursor)
    content <- strsplit(sub('│', '', inputs$marked, fixed = TRUE), '\n', fixed = TRUE)[[1L]]
    row <- lengths(regmatches(before, gregexpr('\n', before, fixed = TRUE)))
    col <- nchar(sub('.*\n', '', before))
    point <- list(row = row, col = col)
    uri <- 'r-console://native-evidence/console.R'
    document <- languageserver:::Document$new(uri, language = 'r', version = 1L, content = content)
    parsed <- languageserver:::parse_document(uri, content)
    parsed$version <- document$version
    document$update_parse_data(parsed)
    workspace <- list(member_metadata = collections::dict())
    location <- languageserver:::member_call_location(document, point, symbols = TRUE)
    symbol <- if (!is.null(location)) languageserver:::member_symbol(uri, workspace, document, location)
    result <- list(signature = symbol$signature)
    if (!is.null(inputs$scopePrefix)) {
      workspace <- languageserver:::Workspace$new(tempdir())
      workspace$documents$set(uri, document)
      scope <- languageserver:::scope_completion(uri, workspace, inputs$scopePrefix, point, TRUE)
      symbols <- languageserver:::workspace_completion(workspace, inputs$scopePrefix,
        snippet_support = TRUE, uri = uri)
      functions <- Filter(function(item) identical(item$kind, languageserver:::CompletionItemKind$Function), c(scope, symbols))
      result$functions <- as.list(unique(vapply(functions, function(item) item$label, character(1))))
    }
    cat(jsonlite::toJSON(result, auto_unbox = TRUE, null = 'null'))
  `, { marked, scopePrefix }));
  return cache.get(key);
}

module.exports = { nativeStaticEvidence };
