# R Console

R Console is a VS Code extension that runs R inside a custom pseudoterminal. It combines a TypeScript console frontend, a Rust sidecar that wraps an embedded session-host runtime, and a console-scoped language server client.

## Architecture

### Runtime Layers

1. Terminal layer owns the pseudoterminal implementation, input buffer, cursor movement, multiline editing, history, rendering, prompt handling, and screen replay.

2. Language layer owns completion-context analysis, local parse heuristics, virtual documents, and the console-specific LSP bridge.

3. Runtime layer owns the sidecar/session control protocol, bundled binary resolution, and the optional vscode-R session watcher bridge.

4. Rust sidecar
- `sidecar/pty-host/` builds one binary:
- `R_CONSOLE_HOST` launches an internal session-host process, forwards stdout and control messages, and preserves the existing packaging/binary contract.
- The internal session-host mode embeds R, wires the console callbacks, and emits prompt, busy, input-request, and parse-status events back to the extension.

## Features

- Custom R console hosted in the VS Code terminal area.
- Multiline editing with local history navigation and reverse search.
- Auto-matching brackets and quotes.
- Bracketed paste handling.
- Parser-backed completeness checks before submission.
- Console-scoped completion, signature help, and semantic-token styling through `languageserver`.
- Session watcher integration with vscode-R for search-path data, global-environment data, and runtime `$` / `@` member completion.
- Screen replay when the terminal UI is recreated after a cancelled close or a reattach.
- Cross-platform embedded console backend for macOS, Linux, and Windows.

## Requirements

- VS Code 1.85.0 or later.
- Node.js 24.x for the extension build and packaging scripts.
- R 4.5.x installed and configured through vscode-R settings. The current runtime rejects other R major/minor versions.
- [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r).
- The R package `languageserver` if you want completion, signature help, and semantic highlighting.
- Rust/Cargo only if you are building the sidecar binaries from source.

## Build

### Local Build For The Current OS

```bash
npm install
npm run compile
npm run build:sidecar
npm run stage:sidecar
```

`compile` type-checks the extension and bundles the extension host entrypoint into `dist/extension.js`.

`stage:sidecar` copies the current platform's `R_CONSOLE_HOST` into `bundled/bin/`.

### Packaging

```bash
npm run package
```

This produces a target-specific VSIX for the current host platform, for example `vscode-r-console-0.1.0-win32-x64.vsix`.

`vscode:prepublish` still prepares the production bundle and stages the current platform binary into `bundled/bin/`.

The GitHub release workflow packages and publishes four target-specific builds: `win32-x64`, `linux-x64`, `darwin-x64`, and `darwin-arm64`.

## Configuration

R Console reads several settings from vscode-R:

| Setting | Purpose |
| --- | --- |
| `r.rterm.windows` | R executable path on Windows |
| `r.rterm.mac` | R executable path on macOS |
| `r.rterm.linux` | R executable path on Linux |
| `r.rterm.option` | Extra arguments passed to R |
| `r.sessionWatcher` | Enables the vscode-R session watcher bridge |
| `r.bracketedPaste` | Enables bracketed paste mode |
| `r.lsp.args` | Extra arguments passed when starting `languageserver` |
| `r.lsp.use_stdio` | Uses stdio instead of a loopback socket for the console LSP client when supported |
| `r.alwaysUseActiveTerminal` | Controls whether the new console is immediately focused |

R Console also contributes its own settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `r.console.autoMatch` | `true` | Auto-insert matching brackets and quotes |
| `r.console.tabSize` | `2` | Indentation width |

## Project Layout

- `src/Terminal/` contains the console editor, renderer, history manager, terminal-state replay, options, and the main `RTerminal` implementation.
- `src/Language/` contains completion logic, the console LSP client, parse heuristics, and the virtual in-memory R document.
- `src/Runtime/` contains the backend control protocol, bundled Rust binary resolution, and the session watcher integration.
- `sidecar/pty-host/` contains the Rust sidecar wrapper and the internal session-host module.

## Credits

R Console is built on the broader VS Code, Rust, and R tooling ecosystems, and on the work of several open-source projects that shaped the extension. In particular, the following projects informed the current design and implementation:

- [vscode-R](https://github.com/REditorSupport/vscode-R) provides the settings surface this extension reads, the session bootstrap scripts (`R/session/profile.R` and `R/session/init.R`) that the console integrates with, and the watcher/request model that informed `SessionWatcher`.
- [arf](https://github.com/eitsupi/arf) is the closest reference for the current Rust-side console host implementation. The `sidecar/pty-host/src/session_host/` code follows the same Rust `libloading` approach to loading `libR`, platform-specific callback wiring, Windows support-DLL preloading (`Rblas.dll`, `Riconv.dll`, `Rlapack.dll`, `Rgraphapp.dll`), `R_SetParams` / `getRUser` / `GA_initapp` setup on Windows, and Unix callback/event integration.
- [rchitect](https://github.com/randy3k/rchitect) informed the embedded-R callback model behind the internal session host: the `Rstart` / `ptr_R_*` callback surface, `R_ToplevelExec`-guarded parse/eval flow, and the Unix event-pump pattern around `R_PolledEvents`, `R_checkActivity`, and `R_runHandlers`.
- Multiline editing, console history storage, and several input heuristics were shaped by prior terminal-first R console patterns, but the implementation here is self-contained within this extension.
- [`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless) maintains the off-screen terminal buffer that lets the extension replay a styled screen when the UI is reattached.
- [`vscode-languageclient`](https://www.npmjs.com/package/vscode-languageclient) powers the console-scoped LSP client used with the R `languageserver` package.
- [`libloading`](https://crates.io/crates/libloading) makes it possible for the internal session-host mode in `R_CONSOLE_HOST` to dynamically load the R shared library and bind the embedded-console callbacks.
- Built on the [VS Code Extension API](https://code.visualstudio.com/api).

## Development Note

This extension's source code was written with assistance from Codex (GPT-5.3-Codex and GPT-5.4). The overall feature design and logic decisions are mine; GPT models were used to generate and iterate on the implementation.

## License

MIT
