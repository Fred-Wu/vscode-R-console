# Changelog

All notable changes to R Console will be documented in this file.

## [Unreleased]

### Added
- Windows embedded-R backend in `R_CONSOLE_HOST` for `win32-x64` and `win32-arm64`.
- Windows `Rstart` / `R_SetParams` initialization, support-DLL preloading, and graphapp event pumping in the Rust sidecar.
- Styled screen and scrollback restoration backed by an off-screen `@xterm/headless` terminal buffer.

### Changed
- The documented runtime model now matches the code: `R_CONSOLE_HOST` is the embedded host itself, not a wrapper around a second internal session-host process.
- Packaging and release documentation now reflects all currently scripted targets: `win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`, `darwin-x64`, and `darwin-arm64`.
- Close confirmation keeps the running console visible by reattaching immediately before showing the modal warning.

### Fixed
- Long submitted inputs no longer duplicate viewport content or produce a second `R>` prompt when the submission is larger than the visible input window.
- Reattached terminals now restore styled code instead of flattening restored content to plain text.
- Function-call highlighting for obvious call sites such as `plot(...)` now appears immediately instead of waiting for delayed semantic-token updates.

## [0.1.0] - 2026-01-30

### Added
- Initial release
- Pseudoterminal UI with VS Code terminal integration
- Rust console host and embedded R session host
- Multi-line input with expression-aware editing
- Console syntax highlighting with semantic-token support
- Persistent command history with Up/Down navigation
- Reverse history search (Ctrl+R)
- QuickPick completion UI with session watcher and language server integration
- Signature help through the console language server
- Auto-matching brackets and quotes
- Smart auto-indentation
- Bracketed paste handling
- Parser-backed completeness checks
- vscode-R session watcher integration

### Known Limitations
- Requires R 4.5.x
- Terminal close interception is limited by the VS Code custom terminal API
