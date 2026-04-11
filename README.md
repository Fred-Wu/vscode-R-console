# R Console

R Console is a VS Code extension that runs R inside a custom pseudoterminal. It combines a TypeScript console frontend, a bundled Rust sidecar that embeds R directly, and a console-scoped language server client. It is designed to work with VS Code, the [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) extension, and R's `languageserver`.

## Architecture

### Runtime Layers

1. Terminal layer owns the pseudoterminal implementation, input buffer, cursor movement, multiline editing, history, the long-input viewport renderer, prompt handling, and an off-screen `@xterm/headless` buffer used to restore screen and scrollback state on reattach.

2. Language layer owns completion-context analysis, local parse heuristics, immediate token-based styling, virtual documents, and the console-specific LSP bridge.

3. Runtime layer owns the sidecar/session control protocol, bundled binary resolution, dialog bridging, and the vscode-R session watcher bridge.

4. Rust sidecar
- `sidecar/pty-host/` builds one binary:
- `R_CONSOLE_HOST` is the embedded host. It does not spawn a second internal session-host process.
- It loads the R shared library dynamically, wires console callbacks, and emits prompt, busy, input-request, dialog, and parse-status events back to the extension over the backend protocol.
- On Unix it uses the `ptr_R_*` callback globals and the native event-pump APIs.
- On Windows it uses `Rstart` / `R_SetParams`, support-DLL preloading, `getRUser`, `GA_initapp`, `GA_peekevent`, and `R_ProcessEvents` while preserving the same extension-facing protocol.

### Dependency Model

- `vscode-R` is a hard dependency. R Console uses the same configured R binary and the same session bootstrap model as the Unix implementation.
- `languageserver` is optional but required for console semantic tokens, completion, and signature help.
- The bundled `R_CONSOLE_HOST` sidecar is required at runtime. If the bundled binary for the current target is missing, the console does not fall back to a separate backend.

## Features

- Custom R console hosted in the VS Code terminal area.
- Multiline editing with local history navigation, reverse search, and a windowed/collapsed viewport renderer for long inputs.
- Auto-matching brackets and quotes.
- Bracketed paste handling.
- Parser-backed completeness checks before submission.
- Immediate local syntax highlighting plus semantic-token styling through `languageserver`.
- Immediate function-call highlighting for obvious call sites such as `plot(...)`, without waiting for semantic-token round trips.
- Console-scoped completion and signature help through `languageserver`.
- Session watcher integration with vscode-R for search-path data, global-environment data, and runtime `$` / `@` member completion.
- Screen, scrollback, cursor, and ANSI style restoration when the terminal UI is recreated after a cancelled close or a reattach.
- Close confirmation that immediately reattaches the running console before showing the modal prompt, which keeps the console visible despite the VS Code terminal API lacking a before-close hook.
- Embedded console backend for macOS, Linux, and Windows.

## Requirements

- VS Code 1.85.0 or later.
- Node.js 24.x for the extension build and packaging scripts.
- R 4.5.x installed and configured through vscode-R settings. The current runtime rejects other R major/minor versions.
- [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r). This extension depends on vscode-R session bootstrap and configuration; there is no standalone startup path.
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

The GitHub release workflow packages six target-specific builds: `win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`, `darwin-x64`, and `darwin-arm64`.

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

- `src/Terminal/` contains the console editor, viewport renderer, history manager, headless replay/restore logic, options, and the main `RTerminal` implementation.
- `src/Language/` contains completion logic, the console LSP client, parse heuristics, and the virtual in-memory R document.
- `src/Runtime/` contains the backend control protocol, bundled Rust binary resolution, and the session watcher integration.
- `sidecar/pty-host/` contains the Rust embedded host and protocol framing code.

## Credits

R Console is built on the broader VS Code, Rust, and R tooling ecosystems, and on the work of several open-source projects that shaped the extension. In particular, the following projects informed the current design and implementation:

- [vscode-R](https://github.com/REditorSupport/vscode-R) provides the settings surface this extension reads, the session bootstrap scripts (`R/session/profile.R` and `R/session/init.R`) that the console integrates with, and the watcher/request model that informed `SessionWatcher`.
- [arf](https://github.com/eitsupi/arf) is the closest reference for the current Rust-side console host implementation. The `sidecar/pty-host/src/host.rs` code follows the same Rust `libloading` approach to loading `libR`, platform-specific callback wiring, Windows support-DLL preloading (`Rblas.dll`, `Riconv.dll`, `Rlapack.dll`, `Rgraphapp.dll`), `R_SetParams` / `getRUser` / `GA_initapp` setup on Windows, and Unix callback/event integration.
- [rchitect](https://github.com/randy3k/rchitect) informed the embedded-R callback model behind the current Rust host: the `Rstart` / `ptr_R_*` callback surface, `R_ToplevelExec`-guarded parse/eval flow, and the Unix event-pump pattern around `R_PolledEvents`, `R_checkActivity`, and `R_runHandlers`.
- Multiline editing, console history storage, and several input heuristics were shaped by prior terminal-first R console patterns, but the implementation here is self-contained within this extension.
- [`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless) maintains the off-screen terminal buffer that lets the extension replay a styled screen when the UI is reattached.
- [`vscode-languageclient`](https://www.npmjs.com/package/vscode-languageclient) powers the console-scoped LSP client used with the R `languageserver` package.
- [`libloading`](https://crates.io/crates/libloading) makes it possible for `R_CONSOLE_HOST` to dynamically load the R shared library and bind the embedded-console callbacks.
- Built on the [VS Code Extension API](https://code.visualstudio.com/api).

## Development Note

This extension's source code was written with assistance from Codex (GPT-5.3-Codex and GPT-5.4). The overall feature design and logic decisions are mine; GPT models were used to generate and iterate on the implementation.

## License

MIT
