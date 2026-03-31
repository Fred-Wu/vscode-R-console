# Changelog

All notable changes to R Console will be documented in this file.

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
