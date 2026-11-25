const { runRJson } = require('./run-r-json.cjs');

// An independent oracle: load only native languageserver APIs, with no console
// supplement or provider adapter. Input remains unexecuted source throughout.
const cache = new Map();
function nativeStaticEvidence(marked) {
  if (!cache.has(marked)) cache.set(marked, runRJson(String.raw`
    cursor <- regexpr('│', inputs, fixed = TRUE)[[1L]] - 1L
    before <- substr(inputs, 1L, cursor)
    content <- strsplit(sub('│', '', inputs, fixed = TRUE), '\n', fixed = TRUE)[[1L]]
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
    cat(jsonlite::toJSON(list(signature = symbol$signature), auto_unbox = TRUE, null = 'null'))
  `, marked));
  return cache.get(marked);
}

module.exports = { nativeStaticEvidence };
