# Changelog

All notable changes to R Console will be documented in this file.

## unrelease

### Added
- `R Console: Manage Persistent Sessions...` now lets users attach selected/all detached R console sessions or permanently close selected/all persistent sessions.
- Running R console backends now survive extension-host and VS Code restarts without automatically reattaching on startup.

### Fixed
- Closing a non-current console no longer drops the `R: workspace` view for the still-attached console. This is for the custom [vscode-R](https://github.com/Fred-Wu/vscode-R) console build.
- Multiline pasted code at nested R prompts such as `readline()`, `menu()`, and debugger prompts is now submitted one line at a time, preserving line breaks and indentation.
- Nested prompt lines and their replies are now preserved when the terminal is resized.
- Progress bars and other carriage-return rewrites emitted through stderr now update in place instead of accumulating line by line.
- R console backend persistence now uses a durable live-session registry instead of one-shot extension-host reload restoration.

## [0.1.1] - 2026-04-16

### Changed
- Console resize now rebuilds the visible terminal from the headless replay buffer so wrapped output and prompt placement stay stable after width changes.
- Console completion now falls back to recent console/session identifiers when the language server does not return a useful symbol.

### Fixed
- `Ctrl+L` now performs a true clear by resetting both the visible console and the replay buffer, so cleared output does not come back after resize or reattach.
- Empty prompt submissions now preserve the visible `R> ` line during replay-driven resize restores instead of dropping it.
- Console-scoped LSP documents now close cleanly for `r-console://` URIs, and diagnostics are disabled for console buffers.
- Nested prompts such as `browser()` now stay on the nested-input path instead of being misclassified as top-level prompts.
- Submission preprocessing now strips real full-line R comments without removing quoted `#...` text such as `Rcpp::sourceCpp()` headers.
- Embedded console startup now advertises ANSI color and dynamic redraw capabilities for packages such as `cli` and `crayon`.
- Fixed a Windows R console Unicode regression, where some CJK characters and emoji could be evaluated or displayed incorrectly.

## [0.1.0] - 2026-04-13

### Added
- Pre-release build of the `R Console` VS Code extension ahead of VS Code Marketplace publication.
- Custom R console hosted in the VS Code terminal area.
- Embedded Rust `R_CONSOLE_HOST` runtime for macOS, Linux, and Windows.
- Multiline console editing with bracket matching, indentation, bracketed paste, history, and reverse history search.
- Parser-backed completeness checks and immediate console syntax highlighting.
- Console language-server bridge for completion, signature help, and semantic tokens.
- vscode-R session watcher integration for search path updates, workspace data, and member completion.
- Terminal reattach support with scrollback, cursor, and styled screen restoration.

### Notes
- Requires VS Code 1.85.0 or later.
- Requires vscode-R and a local R installation resolvable through `r.rpath.*`, ambient `R_HOME`, or `PATH`.
- Runtime selection now prefers `r.rpath.*`, then ambient `R_HOME`, then `PATH`, and derives `R_HOME` from the selected executable.
- Release packages are target-specific and include one matching `R_CONSOLE_HOST` binary per VSIX.
