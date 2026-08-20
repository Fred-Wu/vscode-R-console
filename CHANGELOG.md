# Changelog

All notable changes to R Console will be documented in this file.

## Unreleased

### vscode-R 3.0 session architecture compatibility

#### Added

- Added a console-scoped `sess` IPC proxy for vscode-R's pipe-based transport, allowing R Console to forward vscode-R session traffic while requesting workspace data and runtime member completions from the current embedded R session.
- Added `jgd` plot-hook support alongside `httpgd` when selected through vscode-R's plot settings.

#### Changed

- R Console now detects vscode-R's pipe-based `r.connectToSession` architecture while retaining the legacy file-based watcher integration for older vscode-R versions.
- Runtime `$`, `@`, and data-frame bracket completion in vscode-R 3.0 `sess` mode now uses the active console session through `sess` JSON-RPC.
- Legacy watcher and `sess` integrations now use a common runtime interface with isolated implementation directories and R bootstrap files.
- Persistent consoles now reuse their existing `sess` proxy when the console UI is detached and reattached, refresh their pipe metadata after a vscode-R extension-host restart, preserve an executing session's busy state, and defer `sess` reconnection until the focused session reaches a top-level prompt.
- Unix `sess` proxy sockets and persistent-session connection files now use owner-only permissions consistent with vscode-R 3.0.

### Development builds

- Added a rolling GitHub development prerelease with platform-specific VSIX packages and checksums for testing changes from the `dev` branch.

## [0.4.4] - 2026-08-05

### Fixed

- Fixed some valid R commands with balanced square brackets being incorrectly treated as incomplete during execution.

## [0.4.3] - 2026-07-16

### Recent changes

- Added a dedicated `R Console Language Server` output channel that reports server starts, stops, errors and the R executable location, without showing language-server protocol traffic.
- Added `F7` to open console completions anywhere, including positions without a completion prefix or context.
- Added `Restore Default Name` to the console tab menu for returning a renamed console to `R Console (PID)`.

### Fixed

- Fixed R errors not appearing in the output channel, while keeping debug and language-server protocol traffic hidden.

## [0.4.2] - 2026-07-15

### Added

- Added a dedicated `R Console Language Server` output channel that reports server starts, stops, errors and the R executable location, without showing language-server protocol traffic.

## [0.4.1] - 2026-07-11

### Added

- Added `F7` to open console completions anywhere, including positions without a completion prefix or context.
- Added `Restore Default Name` to the console tab menu for returning a renamed console to `R Console (PID)`.

### Changed

- Console syntax highlighting now follows the active VS Code theme without depending on the language server.
- Persistent-session reattachment now warns when the configured R path differs from the running session, with options to close the session or open the R path setting.
- Completion suggestions now keep runtime and language-server results in their existing groups.
- Runtime completions now appear immediately while language-server suggestions continue loading.
- Completions opened without a prefix now update as you type, including inside empty `[]` / `()` contexts and when using the completion shortcut.
- Runtime and language-server completions are now both available in normal expression positions, including function calls and data-frame/table expressions; `pkg::`, `pkg:::`, `$`, `@`, quoted column-name, and `[[` completions remain limited to their matching context.
- Further reduced the delay when opening language-server suggestions.
- Renamed consoles and their session-manager labels now keep their names when the console is reopened or detached and reattached.

### Fixed

- Improved how the console language server starts, runs, and stops.
- Fixed runtime session completions becoming unavailable when language-server completion is still starting or unavailable.
- Fixed the Close button hiding a renamed or moved console while its R session remained running.

## [0.3.1] - 2026-06-29

### Fixed

- Reduced the delay when opening console suggestions by avoiding duplicate workspace refreshes when Tab is pressed.

## [0.3.0] - 2026-06-24

### Fixed

- Improved autocompletion inside function calls so session objects appear with the usual completion groups.
- Fixed deduplication across different completion groups.

### Changed

* Updated README, and moved the local development descriptions to the Contributing section.

## [0.2.9] - 2026-06-19

### Fixed

- Fixed completion search for packages with large list of members

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
