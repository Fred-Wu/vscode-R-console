# R Console

R Console is a VS Code extension that runs R inside a custom pseudoterminal. It combines a TypeScript console frontend, a bundled Rust sidecar that embeds R directly, and a console-scoped language server client. It is designed to work with VS Code, the [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) extension, and R's `languageserver`.

Implementation details are documented in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## Features

- Custom R console hosted in the VS Code terminal area.
- Embedded console backend for macOS, Linux, and Windows
- Session watcher integration with vscode-R for search-path data, global-environment data, and runtime `$` / `@` member completion.
- Self-managed R console sessions that can be attached, detached, or closed from VS Code.
- Console-scoped completion and signature help through R's `languageserver` package.
- Immediate local syntax highlighting plus semantic-token styling also through `languageserver`.
- Multiline editing with local history navigation, reverse search, and a windowed/collapsed viewport renderer for long inputs.
- Auto-matching brackets and quotes.
- Bracketed paste handling.
- Parser-backed completeness checks before submission.

https://github.com/user-attachments/assets/a1b7390e-eb33-4b9d-8915-85ae51c3039d

https://github.com/user-attachments/assets/d4877829-07e9-42c2-a66b-652695a5ebf4

## Requirements

- VS Code 1.85.0 or later.
- Node.js 24.x for the extension build and packaging scripts.
- A local R installation. `R Console` resolves it in this order: vscode-R `r.rpath.*`, ambient `R_HOME`, then `PATH`.
- [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r). This extension declares `REditorSupport.r` in `extensionDependencies` and depends on vscode-R session bootstrap/configuration; there is no standalone startup path.
  
> [!IMPORTANT]
> Only official vscode-R 2.8.x releases are currently supported. Newer vscode-R builds are moving to a WebSocket and JSON-RPC 2.0 based architecture.
> A future R Console update will support both vscode-R architectures once the new architecture is officially released.

- The R package `languageserver` if you want completion, signature help, and semantic highlighting.
- Rust/Cargo only if you are building the sidecar binaries from source.

## Using R Console

Launch `R Console` from the Command Palette with:

- `R Console: Create R Console`
- `R Console: Create R Console in Side Editor`
- `R Console: Manage Persistent Sessions...`

Use the session manager to attach to, detach from, or close running R Console sessions.

### Restoring A Dropped Console UI

R Console runs in a VS Code custom pseudoterminal. VS Code may close the terminal UI during multi-root workspace folder reorder or removal, and after extension host restart/reload.

Use `R Console: Manage Persistent Sessions...` from the Command Palette, then choose `Attach Session...` or `Attach All Detached Sessions` to restore the console UI for the running session.

The minimum vscode-R setup for R Console commands to work is:

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

This produces a target-specific VSIX for the current host platform, for example `vsc-r-console-0.2.3-win32-x64.vsix`.

`vscode:prepublish` still prepares the production bundle and stages the current platform binary into `bundled/bin/`.

Each target-specific VSIX contains exactly one platform-matching `R_CONSOLE_HOST` binary in `bundled/bin/`.

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

## Dependency Model

- `vscode-R` is a hard dependency. R Console uses the same configured R binary.
- R's `languageserver` package is optional but required for console semantic tokens, completion, and signature help.
- The bundled `R_CONSOLE_HOST` sidecar is required at runtime. If the bundled binary for the current target is missing, the console does not fall back to a separate backend.

## Acknowledgements

R Console is built on the broader VS Code, Rust, and R ecosystems, and on the work of open-source projects that informed the extension. In particular, we would like to highlight the following projects:

- [vscode-R](https://github.com/REditorSupport/vscode-R) - R Console depends on vscode-R for configuration, session bootstrap, session watching, and the surrounding VS Code R workflow.
- [arf](https://github.com/eitsupi/arf) - The embedded-R host design was heavily informed by arf's Rust-based approach to loading and embedding R, platform-specific console initialization, callback wiring, event/input-handler pumping, and backend architecture.
- [Ark](https://github.com/posit-dev/ark) - The native R frontend model, nested-input handling, ReadConsole recovery concepts, and generic R event-loop integration were important references for the backend design.
- [rchitect](https://github.com/randy3k/rchitect) - Rchitect was a reference for embedding R from a non-R host process, including R home/shared-library discovery and callback/FFI boundary concepts.
- [radian](https://github.com/randy3k/radian) - The terminal-first interaction model and several console UX ideas, including multiline editing, history search/navigation, bracketed paste, and prompt-centric workflows, were inspired by radian.
- [languageserver](https://github.com/REditorSupport/languageserver) - Console completion, signature help, and semantic-token support are built around R's language server.

## Development Note

This extension's source code was written with assistance from GPT models using OpenAI's Codex. The overall feature design and logic decisions are mine; GPT models were used to generate and iterate on the implementation.

## License

MIT
