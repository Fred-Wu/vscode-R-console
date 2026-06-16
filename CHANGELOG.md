# Changelog

All notable changes to R Console will be documented in this file.

## [0.2.8] - 2026-06-16

### Fixed

- Fixed top-level console completion for objects created in the active R session using live session server workspace data instead of relying on stale watcher files.
- Fixed console semantic syntax highlighting to resolve colors from the active VS Code theme, including auto-detected preferred themes.
- Fixed console semantic token handling with current R `languageserver` workspace internals.

## [0.2.7] - 2026-05-24

### Added

- Added the Command Palette command `R Console: Insert Pipe Operator`.
- Added a configurable pipe-insertion keybinding, set to `Ctrl+Alt+M` by default in active R Console terminals.
- Added `r.console.pipeOperator` to choose whether pipe insertion uses R's native pipe `|>` or the magrittr pipe `%>%`.

### Changed

- Improved console completions in data-aware contexts.
- Field completions now quote column names such as `a b` correctly in member and bracket contexts.

## [0.2.6] - 2026-05-20

### Changed

- Clarified R logo asset licensing in the project license.
- Documented how to restore a dropped custom pseudoterminal UI from persistent sessions.

### Fixed

- Fixed duplicate R> prompts after console resize.

## [0.2.5] - 2026-05-15

### Changed

- Release packaging now reuses unchanged sidecar binaries from the previous GitHub release VSIX instead of rebuilding them for every extension release.
- Release workflow now publishes the target-specific VSIX packages to the Open VSX Registry.

### Fixed

- Fixed leading blank echo after stripped R comments.

## [0.2.4] - 2026-05-13

### Fixed

- Fixed console LSP startup on Windows by using a consistent loopback host between VS Code and the R language server helper.
- Preserved the inherited environment when spawning the console LSP R process.
- Avoided repeated semantic token retry loops when semantic tokens are unavailable.

## [0.2.3] - 2026-05-10

### Added

- Added persistent-session detach actions that remove the VS Code console UI without closing the running R backend session.

### Changed

- Removed the old `reload-sessions.json` persistent-session compatibility path; current sessions now use only `persistent-sessions.json`.
- Removed redundant source comments while keeping comments that document non-obvious terminal, R, and platform behavior.

## [0.2.2] - 2026-05-03

### Changed

- Changed the Marketplace package identity to `RConsole.vsc-r-console`.
- Changed the Marketplace display name to `R Console for VS Code`.
- Updated the extension icon to a 128x128 PNG.

## [0.2.1] - 2026-05-03

### Fixed

- Fixed R 4.6 startup compatibility with vscode-R's legacy deferred `.First.sys` attach hook.

## [0.2.0] - 2026-05-02

### Added

- Persistent self-managed console sessions that can survive VS Code terminal UI detaches.
- A session manager for attaching to or closing running R Console sessions.
- Backend/UI transport over a TCP session server with reconnect metadata.
- Persistence for console runtime state, terminal replay state, prompt/input state, and terminal location for later reattach.

### Fixed

- Nested prompt handling now preserves reply input and multiline paste behavior while R is waiting for input.
- R event and input-handler pumping now keeps interactive event loops responsive and interruptible.

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
