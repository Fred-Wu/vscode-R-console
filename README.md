# R Console

R Console is a lightweight R console for VS Code that runs R inside a custom pseudoterminal. It combines a console frontend, a bundled R backend, and language-server completion integration. It is designed to work with VS Code, the [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) extension, and R's `languageserver` package.

## Features

- Custom R console hosted in the VS Code terminal area.
- Persistent R console sessions that can be attached, detached, or closed from VS Code.
- Tab-triggered completion, including objects from the active R session and runtime `$` / `@` member completion. `Alt+Esc` (`⌥ Esc` on macOS) opens the completion window at the cursor, including empty positions where Tab is used for indentation.
- Syntax highlighting that follows the active VS Code color theme.
- Multiline editing with local history navigation, reverse search, and long-input rendering.
- Auto-matching brackets and quotes.
- Bracketed paste handling.

https://github.com/user-attachments/assets/a1b7390e-eb33-4b9d-8915-85ae51c3039d

https://github.com/user-attachments/assets/d4877829-07e9-42c2-a66b-652695a5ebf4

## Using R Console

### Setup

1. Install [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r).
2. Configure the platform-specific [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) R path setting, or make sure R is available from `R_HOME` or `PATH`:

   - Windows: `r.rpath.windows`
   - macOS: `r.rpath.mac`
   - Linux: `r.rpath.linux`
3. Enable bracketed paste mode:

   ```json
   "r.bracketedPaste": true
   ```
4. To make [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) commands target R Console, enable:

   ```json
   "r.alwaysUseActiveTerminal": true
   ```
5. Optional: keep the [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) session watcher enabled for active-session object completion and runtime `$` / `@` member completion:

   ```json
   "r.sessionWatcher": true
   ```

   This setting is enabled by default unless explicitly set to `false`.
6. Optional: install the R package `languageserver` for language-server completion.

`R Console` launches from `r.rpath.*`, `R_HOME`, or `PATH`. It does not launch from `r.rterm.windows`, `r.rterm.mac`, or `r.rterm.linux`.

> [!IMPORTANT]
> Only official [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) 2.8.x releases are currently supported. Newer [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) builds are moving to a WebSocket and JSON-RPC 2.0 based architecture.
> A future R Console update will support both [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) architectures once the new architecture is officially released.

### Launch R Console

Launch R Console from the Command Palette:

- `R Console: Create R Console`
- `R Console: Create R Console in Side Editor`

### Persistent Session Management

Use `R Console: Manage Persistent Sessions...` to manage running R Console sessions.

- Attach to a detached R Console session.
- Detach a console UI or close VS Code while leaving the R process running.
- Detach and reattach a console to pick up startup-related setting changes.
- Close a session and stop its R process.
- Restore a dropped console UI after workspace folder changes or an extension host reload.

## Configuration

R Console reads several settings from [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r):

| Setting | Purpose |
| --- | --- |
| `r.rpath.windows` | R executable path on Windows for R Console startup |
| `r.rpath.mac` | R executable path on macOS for R Console startup |
| `r.rpath.linux` | R executable path on Linux for R Console startup |
| `r.rterm.option` | Extra arguments passed to R |
| `r.sessionWatcher` | Enables the [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) session watcher bridge |
| `r.bracketedPaste` | Enables bracketed paste mode |
| `r.lsp.args` | Extra arguments passed when starting `languageserver` |
| `r.lsp.use_stdio` | Uses stdio instead of a loopback socket for the console LSP client when supported |
| `r.alwaysUseActiveTerminal` | Controls whether the new console is immediately focused |

If `r.rpath.*` is set, an ambient `R_HOME` does not override it. If `r.rpath.*` is unset, ambient `R_HOME` is used before `PATH`.

R Console also contributes its own settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `r.console.autoMatch` | `true` | Auto-insert matching brackets and quotes |
| `r.console.tabSize` | `2` | Indentation width |
| `r.console.pipeOperator` | <code>&#124;&gt;</code> | Pipe operator inserted by `R Console: Insert Pipe Operator` / `Ctrl+Alt+M`; supported values are <code>&#124;&gt;</code> and `%>%` |

## Dependency Model

- [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) is a hard dependency. R Console uses the same configured R binary.
- R's `languageserver` package is optional at runtime but required for language-server completion.
- The bundled R backend is required at runtime. If the bundled backend for the current target is missing, the console does not fall back to a separate backend.

## Acknowledgements

R Console is built on the broader VS Code, Rust, and R ecosystems, and on the work of open-source projects that informed the extension. In particular:

- [vscode-R](https://github.com/REditorSupport/vscode-R) - R Console depends on [vscode-R](https://github.com/REditorSupport/vscode-R) for configuration, session bootstrap, session watching, and the surrounding VS Code R workflow.
- [arf](https://github.com/eitsupi/arf) - The embedded-R host design was heavily informed by arf's Rust-based approach to loading and embedding R, platform-specific console initialization, callback wiring, event/input-handler pumping, and backend architecture.
- [Ark](https://github.com/posit-dev/ark) - The native R frontend model, nested-input handling, ReadConsole recovery concepts, and generic R event-loop integration were important references for the backend design.
- [rchitect](https://github.com/randy3k/rchitect) - Rchitect was a reference for embedding R from a non-R host process, including R home/shared-library discovery and callback/FFI boundary concepts.
- [radian](https://github.com/randy3k/radian) - The terminal-first interaction model and several console UX ideas, including multiline editing, history search/navigation, bracketed paste, and prompt-centric workflows, were inspired by radian.
- [languageserver](https://github.com/REditorSupport/languageserver) - Language-server completion is built around R's language server.

## Development Note

This extension's source code was written with assistance from GPT models using OpenAI's Codex. The overall feature design and logic decisions are mine; GPT models were used to generate and iterate on the implementation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, build, packaging, and manual testing links.

## License

MIT
