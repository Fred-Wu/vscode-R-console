# R Console Manual Stress Test Plan

This checklist is aimed at the parts of `R Console` that are easiest to get
almost-right but still break in real use:

- custom pseudoterminal input/editing
- embedded R callback handling
- nested console prompts such as `readline()` and pager prompts
- console-scoped LSP/session-watcher integration
- plot/server/Shiny workflows
- resize, reattach, and interrupt behavior

These are intentionally tougher than basic smoke tests.

## Suggested Setup

Use a fresh VS Code window with:

- `REditorSupport.r` installed
- `r.alwaysUseActiveTerminal = true`
- `r.sessionWatcher = true`
- `r.bracketedPaste = true`
- `languageserver` installed in R

Optional packages used below:

```r
install.packages(c(
  "languageserver",
  "shiny",
  "httpuv",
  "later",
  "promises",
  "Rcpp",
  "cli",
  "crayon",
  "jsonlite",
  "plotly",
  "progress"
))
```

## 1. Startup And Prompt Sanity

Run:

```r
sessionInfo()
Sys.getenv(c("R_HOME", "R_PROFILE_USER", "VSCODE_INIT_R", "VSC_R_SESSION_CWD"))
getOption(c("prompt", "continue", "menu.graphics"))
```

Expected:

- console starts without hanging
- prompt is stable and stays `R> ` / continuation prompt
- `menu.graphics` is `FALSE`
- startup does not fall back to a different R installation unexpectedly

Failure signs:

- blank console
- duplicated prompt
- prompt changes after startup
- `sessionWatcher`/completion never warms up

## 2. Multiline Editing And Parse Completeness

Type this slowly by hand instead of pasting:

```r
if (TRUE) {
  x <- 1
  y <- x + 1
```

Expected:

- Enter should stay in multiline mode after incomplete input
- continuation prompt should appear
- cursor movement across lines should stay correct

Then finish it:

```r
}
y
```

Expected:

- submission happens once
- no duplicated lines
- result is `2`

## 3. Long Input Viewport Stress

Paste this as one expression:

```r
very_long_name <- paste(sprintf("chunk_%03d", 1:200), collapse = " + ")
```

Now edit in the middle, start, and end using:

- Left/Right
- Home/End
- Ctrl+A / Ctrl+E
- Ctrl+Left / Ctrl+Right or Alt+B / Alt+F

Then build a long multiline object:

```r
z <- list(
  a = 1,
  b = 2,
  c = 3,
  d = 4,
  e = 5,
  f = 6,
  g = 7,
  h = 8,
  i = 9,
  j = 10,
  k = 11,
  l = 12
)
z$j
```

Expected:

- viewport collapses or windows long input without corrupting the buffer
- cursor stays on the intended character
- final submission echoes once

## 4. Bracketed Paste, Auto-Match, And Quotes

Paste this whole block:

```r
paste_test <- function(x = c("a", "b", "c")) {
  data.frame(
    txt = x,
    value = seq_along(x),
    check.names = FALSE
  )
}
paste_test()
```

Then manually type:

```r
list(
```

Expected:

- auto-match inserts `)` only once
- paste does not add doubled brackets/quotes
- Enter after a bracketed paste should not accidentally submit twice

## 5. History And Reverse Search

Run:

```r
alpha_test <- 1
beta_test <- 2
gamma_test <- alpha_test + beta_test
```

Then test:

- Up/Down history navigation
- `Ctrl+R`, search for `alpha_test`
- press `Ctrl+R` again to keep searching backward
- edit the recalled command before submitting

Expected:

- multiline history entries are restored intact
- reverse search does not corrupt the current buffer
- recalled command can be edited normally

## 6. Nested Input: `readline()`, `menu()`, `browser()`

Run:

```r
answer <- readline("Type something: ")
answer
```

Expected:

- nested prompt appears inline
- typed reply is captured once
- console returns to the main prompt cleanly

Run:

```r
menu(c("apple", "banana", "cherry"), title = "Pick one")
```

Expected:

- console prompts for a numeric choice
- no GUI menu is launched

Run:

```r
f <- function() {
  x <- 1
  browser()
  x + 10
}
f()
```

At the `Browse` prompt, try:

```r
x
n
```

Expected:

- browser prompt is usable
- nested prompt and normal prompt do not overlap
- leaving `browser()` returns to the main console cleanly

## 7. Pager And `file.show()`

Run:

```r
tf <- tempfile(fileext = ".txt")
writeLines(sprintf("Line %03d", 1:120), tf)
file.show(tf, title = "Pager Stress")
```

At the pager `:` prompt try:

- Enter
- `b`
- `50`
- `q`

Expected:

- pager stays inside the console
- page navigation works
- quitting the pager restores a normal prompt

## 8. Interrupts And Busy-State Recovery

Run:

```r
repeat {
  Sys.sleep(0.2)
  cat("tick\n")
}
```

Interrupt with `Ctrl+C`.

Expected:

- interrupt stops execution promptly
- prompt returns
- next command still works

Then run:

```r
for (i in 1:200) {
  cat(sprintf("\rprogress %03d/200", i))
  flush.console()
  Sys.sleep(0.01)
}
cat("\nDone\n")
```

Expected:

- carriage-return updates do not smear the screen badly
- prompt does not appear in the middle of progress output

## 9. Progress Bars And In-Place Redraw

These are worth testing because different progress-bar implementations stress
different output paths:

- base R `txtProgressBar()` uses carriage-return redraws
- `cli` uses ANSI styling and transient status updates
- `progress` mixes redraw, width handling, and ETA text

Run:

```r
# Define the total number of iterations
n <- 100

# style = 3 gives a compact progress bar with percentage
pb <- txtProgressBar(min = 0, max = n, style = 3)

for (i in 1:n) {
  Sys.sleep(0.01)
  setTxtProgressBar(pb, i)
}

close(pb)
```

Then run:

```r
if (requireNamespace("cli", quietly = TRUE)) {
  n <- 100
  cli::cli_progress_bar("Processing data", total = n)
  for (i in 1:n) {
    Sys.sleep(0.02)
    cli::cli_progress_update()
  }
  cli::cli_progress_done()
}
```

Then run:

```r
if (requireNamespace("progress", quietly = TRUE)) {
  pb <- progress::progress_bar$new(
    format = "  downloading [:bar] :percent eta: :eta",
    total = 100,
    clear = FALSE,
    width = 60,
    force = TRUE
  )

  for (i in 1:100) {
    pb$tick()
    Sys.sleep(1 / 100)
  }
}
```

Optional harder variant:

- interrupt one of the loops around 30 to 50 percent with `Ctrl+C`
- resize the terminal while the progress bar is actively updating

Expected:

- progress bars redraw mostly in place instead of printing hundreds of broken lines
- percentage/bar text remains legible
- ANSI styling from `cli` does not leak into later output or the prompt
- prompt returns cleanly after completion
- after an interrupt, the console still accepts the next command normally

Failure signs:

- every update appears on its own line
- half-rendered bars remain mixed with the prompt
- cursor jumps into the middle of old output
- prompt never fully returns after the bar completes

## 10. Console Output Flood

Run:

```r
cat(paste(sprintf("row_%05d %s", 1:5000, strrep("x", 40)), collapse = "\n"), "\n")
```

Expected:

- output remains readable
- prompt eventually returns
- scrolling stays stable
- reattach later should preserve useful scrollback

## 11. Unicode, Width, And ANSI Styling

Run:

```r
txt <- c(
  "plain ASCII",
  "accented caf\u00e9",
  "combining e\u0301",
  "\u65e5\u672c\u8a9e",
  "\U0001f642 emoji"
)
enc2utf8(txt)
```

Run:

```r
if (requireNamespace("crayon", quietly = TRUE)) {
  cat(crayon::red("red text"), "\n")
  cat(crayon::green$bold("bold green"), "\n")
}
if (requireNamespace("cli", quietly = TRUE)) {
  cli::cli_alert_info("cli styles")
}
```

Expected:

- text is not mangled
- cursor placement after wide characters is still sane
- ANSI colors do not leak into the prompt

## 12. Completion, Signatures, And Session Watcher

Run:

```r
df_test <- data.frame(alpha = 1:3, beta = 4:6, gamma = 7:9)
lm_test <- lm(mpg ~ wt + cyl, data = mtcars)
```

Now test in the console:

- type `df_test$` and request completion
- type `lm(` and request signature help
- type `mtcars[` and request completion inside brackets
- type `stats::f` and request package completion

Expected:

- `$` completions include `alpha`, `beta`, `gamma`
- signature help shows `lm` arguments
- completion still works after several commands, not just right after startup

Failure signs:

- completion works only for global symbols but not members
- stale members from an earlier console appear
- LSP dies silently after an error

## 13. Editor-To-Console Integration

Create a file `manual-editor-test.R` with:

```r
editor_value <- 123
editor_square <- function(x) x^2
editor_square(editor_value)

editor_value <- editor_value + 1
editor_square(editor_value)
```

From the editor, test:

- send current line
- send selection
- source entire file
- repeat with the cursor in the middle of the file

Expected:

- code is sent to the active R Console, not some other terminal
- echoed code appears once
- object state matches the exact lines sent

Also test with:

- a file path containing spaces
- CRLF line endings
- no trailing newline at EOF

## 14. Plotting Base Graphics

Run:

```r
op <- par(no.readonly = TRUE)
on.exit(par(op), add = TRUE)
par(mfrow = c(2, 2))
plot(cars, main = "cars")
hist(rnorm(1000), col = "steelblue", main = "hist")
image(volcano, col = hcl.colors(32, "YlOrRd", rev = TRUE), main = "image")
boxplot(split(mtcars$mpg, mtcars$cyl), main = "boxplot")
```

Expected:

- plots render consistently
- the console does not hang after plotting
- subsequent input still works

Then run several plots quickly:

```r
for (i in 1:10) {
  plot(rnorm(100), rnorm(100), main = paste("plot", i))
}
```

Expected:

- repeated plotting does not stall the console or lose the prompt

## 15. HTML Widgets / Browser-Backed Plotting

If installed:

```r
if (requireNamespace("plotly", quietly = TRUE)) {
  plotly::plot_ly(x = 1:10, y = (1:10)^2, type = "scatter", mode = "lines+markers")
}
```

Expected:

- htmlwidget output opens in the expected VS Code/browser flow
- console remains usable afterward

## 16. Lightweight HTTP Server

Run:

```r
if (requireNamespace("httpuv", quietly = TRUE)) {
  server <- httpuv::startServer("127.0.0.1", 8123, list(
    call = function(req) {
      list(
        status = 200L,
        headers = list("Content-Type" = "application/json"),
        body = jsonlite::toJSON(list(
          path = req$PATH_INFO,
          method = req$REQUEST_METHOD
        ), auto_unbox = TRUE)
      )
    }
  ))
  cat("Server ready on http://127.0.0.1:8123\n")
}
```

Open `http://127.0.0.1:8123/test`.

Expected:

- server responds
- console stays responsive
- interrupting or stopping the server returns the prompt cleanly

Cleanup:

```r
if (exists("server")) server$stop()
```

## 17. Shiny App Lifecycle

Run:

```r
if (requireNamespace("shiny", quietly = TRUE)) {
  app <- shiny::shinyApp(
    ui = shiny::fluidPage(
      shiny::titlePanel("R Console stress"),
      shiny::textInput("txt", "Label", "hello"),
      shiny::sliderInput("n", "N", min = 10, max = 2000, value = 100),
      shiny::plotOutput("p"),
      shiny::verbatimTextOutput("v")
    ),
    server = function(input, output, session) {
      output$p <- shiny::renderPlot({
        hist(rnorm(input$n), col = "tomato", border = "white")
      })
      output$v <- shiny::renderPrint({
        list(
          text = input$txt,
          n = input$n,
          time = Sys.time()
        )
      })
    }
  )
  shiny::runApp(app, launch.browser = TRUE)
}
```

While the app is running:

- change controls in the browser
- return to VS Code and run another command if supported by the console state
- stop the app with interrupt

Expected:

- app launches
- reactive plot updates work
- stopping the app does not leave the console half-busy

## 18. Compilation With `Rcpp`

Run:

```r
if (requireNamespace("Rcpp", quietly = TRUE)) {
  Rcpp::sourceCpp(code = '
    #include <Rcpp.h>
    using namespace Rcpp;

    // [[Rcpp::export]]
    NumericVector times_two(NumericVector x) {
      return x * 2;
    }
  ')
  times_two(c(1, 2, 3))
}
```

Expected:

- compiler output does not corrupt prompt rendering
- compiled symbol loads into the current session
- result is `2 4 6`

Optional harder variant:

```r
if (requireNamespace("Rcpp", quietly = TRUE)) {
  Rcpp::sourceCpp(code = '
    #include <Rcpp.h>
    using namespace Rcpp;

    // [[Rcpp::export]]
    NumericMatrix crossprod_cpp(NumericMatrix x) {
      const int n = x.ncol();
      const int k = x.nrow();
      NumericMatrix out(n, n);

      for (int i = 0; i < n; ++i) {
        for (int j = 0; j < n; ++j) {
          double total = 0.0;
          for (int r = 0; r < k; ++r) {
            total += x(r, i) * x(r, j);
          }
          out(i, j) = total;
        }
      }

      return out;
    }
  ')
  crossprod_cpp(matrix(1:9, nrow = 3))
}
```

## 19. `source()`, Errors, Warnings, And Tracebacks

Create a file `manual-source-test.R`:

```r
message("starting source test")
warning("source warning")
stop("source error")
```

Run:

```r
source("manual-source-test.R")
traceback()
```

Expected:

- messages, warnings, and errors stay visually distinct enough to read
- traceback is printed correctly
- prompt returns after the error

## 20. Resize And Reattach

While the console contains scrollback and a partially edited multiline command:

1. resize the terminal narrower and wider several times
2. try plotting after a resize
3. close the terminal tab
4. cancel the close confirmation if shown

Expected:

- input buffer survives resize
- prompt/input do not duplicate
- reattached console restores visible state reasonably well
- cancelling close keeps the running session alive

## 21. Two Concurrent Consoles

Open two R Console instances.

In console A:

```r
whoami <- "A"
df_a <- data.frame(a_only = 1:3)
```

In console B:

```r
whoami <- "B"
df_b <- data.frame(b_only = 4:6)
```

Then in each console test:

- `whoami`
- `$` completion on the local data frame
- a few history entries

Expected:

- outputs and completions stay scoped to the correct console/session
- watcher/LSP state from one console does not bleed into the other

## Good Final Smoke Check

After running several of the tests above, the console should still handle:

```r
1 + 1
plot(1:10)
readline("still alive? ")
```

If these simple commands fail only after the heavy tests, the console likely has
a state-management bug rather than a basic startup problem.
