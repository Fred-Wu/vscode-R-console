# R Console

R Console is a VS Code extension that runs R inside a custom pseudoterminal. It combines a TypeScript console frontend, a bundled Rust sidecar that embeds R directly, and a console-scoped language server client. It is designed to work with VS Code, the [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) extension, and R's `languageserver`.

Implementation details are documented in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## Features

- Custom R console hosted in the VS Code terminal area.
- Multiline editing with local history navigation, reverse search, and a windowed/collapsed viewport renderer for long inputs.
- Auto-matching brackets and quotes.
- Bracketed paste handling.
- Parser-backed completeness checks before submission.
- Console-scoped completion and signature help through R's `languageserver` package.
- Session watcher integration with vscode-R for search-path data, global-environment data, and runtime `$` / `@` member completion.
- Immediate local syntax highlighting plus semantic-token styling also through `languageserver`.
- Screen, scrollback, cursor, and ANSI style restoration when the terminal UI is recreated after a cancelled close or a reattach.
- Close confirmation that immediately reattaches the running console before showing the modal prompt, which keeps the console visible despite the VS Code terminal API lacking a before-close hook.
- Embedded console backend for macOS, Linux, and Windows.

https://github.com/user-attachments/assets/a1b7390e-eb33-4b9d-8915-85ae51c3039d

## Requirements

- VS Code 1.85.0 or later.
- Node.js 24.x for the extension build and packaging scripts.
- A local R installation. `R Console` resolves it in this order: vscode-R `r.rpath.*`, ambient `R_HOME`, then `PATH`.
- [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r). This extension declares `REditorSupport.r` in `extensionDependencies` and depends on vscode-R session bootstrap/configuration; there is no standalone startup path.
- The R package `languageserver` if you want completion, signature help, and semantic highlighting.
- Rust/Cargo only if you are building the sidecar binaries from source.

## Using R Console

Launch `R Console` from the Command Palette with:

- `R: Create R Console`
- `R: Create R Console in Side Editor`

The minimum vscode-R setup for those commands to work is:

1. Install [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r).
2. Prefer setting the platform-specific vscode-R `r.rpath.*` entry to the R binary path used by `R Console`:
   - Windows: `r.rpath.windows` -> path to `R.exe`
   - macOS: `r.rpath.mac` -> path to `R`
   - Linux: `r.rpath.linux` -> path to `R`
   
   `r.rterm.*` is not required to create `R Console`.
   If `r.rpath.*` is unset, `R Console` falls back to ambient `R_HOME`, then `PATH`.
   After selecting an executable, `R Console` derives `R_HOME` from that executable path and loads the matching shared library from that same installation.
3. Set `r.alwaysUseActiveTerminal` to be `true` to make vscode-R commands to target `R Console`
4. Keep `r.rterm.option` compatible with embedded startup. `R Console` strips some wrapper-only flags, but startup still requires the vscode-R bootstrap path and will reject options such as `--vanilla` and `--no-init-file`.

Useful optional settings:

- `r.sessionWatcher = true` keeps the vscode-R watcher bridge enabled for workspace/global-environment updates and member completion.
- `r.bracketedPaste = true` enables bracketed paste mode in the console.

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

`dist/`, `bundled/`, and `sidecar/pty-host/target/` are generated build outputs and are intentionally not committed.

### Packaging

```bash
npm run package
```

This produces a target-specific VSIX for the current host platform, for example `vscode-r-console-0.1.1-win32-x64.vsix`.

`vscode:prepublish` still prepares the production bundle and stages the current platform binary into `bundled/bin/`.

Each target-specific VSIX contains exactly one platform-matching `R_CONSOLE_HOST` binary in `bundled/bin/`.

Pushing a tag that matches `package.json`'s version, for example `v0.1.1`, runs the GitHub release workflow. It packages six target-specific builds (`win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`, `darwin-x64`, and `darwin-arm64`), generates `SHA256SUMS.txt`, and creates or updates the GitHub release for that tag. `workflow_dispatch` still acts as a packaging-only dry run.

## Configuration

R Console reads several settings from vscode-R:

| Setting | Purpose |
| --- | --- |
| `r.rpath.windows` | R executable path on Windows for R Console startup |
| `r.rpath.mac` | R executable path on macOS for R Console startup |
| `r.rpath.linux` | R executable path on Linux for R Console startup |
| `r.rterm.option` | Extra arguments passed to R |
| `r.sessionWatcher` | Enables the vscode-R session watcher bridge |
| `r.bracketedPaste` | Enables bracketed paste mode |
| `r.lsp.args` | Extra arguments passed when starting `languageserver` |
| `r.lsp.use_stdio` | Uses stdio instead of a loopback socket for the console LSP client when supported |
| `r.alwaysUseActiveTerminal` | Controls whether the new console is immediately focused |

`R Console` does not launch from `r.rterm.windows`, `r.rterm.mac`, or `r.rterm.linux`.
If `r.rpath.*` is set, an ambient `R_HOME` does not override it. If `r.rpath.*` is unset, ambient `R_HOME` is used before `PATH`.

R Console also contributes its own settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `r.console.autoMatch` | `true` | Auto-insert matching brackets and quotes |
| `r.console.tabSize` | `2` | Indentation width |

## Architecture

### Runtime Layers

1. Terminal layer owns the pseudoterminal implementation, input buffer, cursor movement, multiline editing, history, the long-input viewport renderer, prompt handling, and an off-screen `@xterm/headless` buffer used to restore screen and scrollback state on reattach.

2. Language layer owns completion-context analysis, local parse heuristics, immediate token-based styling, virtual documents, and the console-specific LSP bridge.

3. Runtime layer owns the sidecar/session control protocol, bundled binary resolution, dialog bridging, and the vscode-R session watcher bridge.

4. Rust sidecar
- `sidecar/pty-host/` builds one binary:
- `R_CONSOLE_HOST` is the embedded host. It does not spawn a second internal session-host process. It loads the R shared library dynamically, wires console callbacks, and emits prompt, busy, input-request, dialog, and parse-status events back to the extension over the backend protocol.

### Dependency Model

- `vscode-R` is a hard dependency. R Console uses the same configured R binary.
- R's `languageserver` package is optional but required for console semantic tokens, completion, and signature help.
- The bundled `R_CONSOLE_HOST` sidecar is required at runtime. If the bundled binary for the current target is missing, the console does not fall back to a separate backend.

## Project Layout

- `src/Terminal/` contains the console editor, viewport renderer, history manager, headless replay/restore logic, options, and the main `RTerminal` implementation.
- `src/Language/` contains completion logic, the console LSP client, parse heuristics, and the virtual in-memory R document.
- `src/Runtime/` contains the backend control protocol, bundled Rust binary resolution, and the session watcher integration.
- `sidecar/pty-host/` contains the Rust embedded host and protocol framing code.

## Acknowledgements

R Console is built on the broader VS Code, Rust, and R ecosystems, and on the work of open-source projects that informed the extension. In particular, we would like to highlight the following projects:

- [vscode-R](https://github.com/REditorSupport/vscode-R) - R Console depends on vscode-R for configuration, session bootstrap, session watching, and the surrounding VS Code R workflow.
- [arf](https://github.com/eitsupi/arf) - The current embedded-R host design was heavily informed by arf's Rust-based approach to loading and embedding R, platform-specific console initialization, callback wiring, and backend architecture.
- [radian](https://github.com/randy3k/radian) - The terminal-first interaction model and several console UX ideas, including multiline editing, history search/navigation, bracketed paste, and prompt-centric workflows, were inspired by radian.

## Development Note

This extension's source code was written with assistance from Codex (GPT-5.3-Codex and GPT-5.4). The overall feature design and logic decisions are mine; GPT models were used to generate and iterate on the implementation.

## License

MIT
