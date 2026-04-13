# Changelog

All notable changes to R Console will be documented in this file.

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
