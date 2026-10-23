# R Console

<!-- badges: start -->

<a href="https://marketplace.visualstudio.com/items?itemName=RConsole.vsc-r-console"><img src="https://img.shields.io/github/v/release/Fred-Wu/vscode-R-console?label=release" alt="Release"></a>
<a href="https://github.com/Fred-Wu/vscode-R-console/releases/tag/development"><img src="https://img.shields.io/github/package-json/v/Fred-Wu/vscode-R-console/main?label=dev" alt="Development version"></a>
<a href="https://github.com/Fred-Wu/vscode-R-console/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/Fred-Wu/vscode-R-console/release.yml?branch=main&label=ci" alt="CI"></a>

<!-- badges: end -->

R Console is a lightweight R console for VS Code that runs R inside a custom pseudoterminal. It combines a console frontend, a bundled R backend, and language-server completion integration. It is designed to work with VS Code, the [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) extension, and R's `languageserver` package.

> [!IMPORTANT]
> The bundled backend executable, R_CONSOLE_HOST, is not currently code-signed. Depending on your OS and security settings, it may trigger a security warning or be blocked when first launched. Install R Console only from the official VS Code Marketplace or this repository's GitHub Releases.

## New in 0.5.4

Completion suggestions can now appear directly in the terminal. Choose inline completion and show suggestions while typing or when pressing Tab, or keep the default Quick Pick completion picker. This release also fixes completions for project-specific R package folders and Unicode input on Windows. See the [release notes](CHANGELOG.md#054---2026-10-23) for details.

## Features

- Custom R console hosted in the VS Code terminal area.
- Persistent R console sessions that can be attached, detached, or closed from VS Code, while preserving custom console names.
- Console completion, including objects from the active R session and runtime `$` / `@` member completion:
  - **Quick Pick completion picker:** The default mode (`r.console.completionUI: "quickPick"`). Press Tab for completions, or `F7` to open the **R console completions** picker at the cursor, including empty positions where Tab is used for indentation.
  - **Inline terminal completion:** Set `r.console.completionUI` to `"inline"` to show suggestions directly in the terminal. Press Tab to open the list, use Up/Down to select a suggestion, Tab or Enter to insert it, and Escape to dismiss the list. Set `r.console.inlineCompletion.trigger` to `"typing"` for automatic suggestions or keep `"tab"` for Tab-triggered suggestions. This trigger setting applies only to inline completion and does not affect Quick Pick. Tab still indents at the start of a line, and `F7` is only used in Quick Pick mode.
- Syntax highlighting that follows the active VS Code color theme.
- Multiline editing and long-input rendering.
- Reverse search on entered text using `Ctrl+R`; repeated presses find older matches. `F8` opens **Command History**, a searchable picker with on-demand loading, native multi-selection checkboxes, Select All, and a toggle to collapse or expand exact duplicate entries. Selected entries can be restored as a single editable input without execution, or deleted using the picker toolbar.
- Workspace-aware history:
  - **History scope:** `r.console.historyScope` defaults to `"workspace"`, sharing history between consoles in the same workspace folder. Set it to `"global"` for one shared history; consoles without a workspace automatically use global history.
  - **On-demand loading:** The history picker loads matching commands in pages, while console Up/Down navigation fetches older history from the on-disk file as needed.
  - **History deletion:** Delete individual or multiple entries using the history picker. When duplicates are collapsed, deleting a selected entry removes all its matching occurrences.
  - **History retention:** The latest 20,000 commands are retained per scope.
  - **Existing history:** The old `~/.r_console_history` file is left unchanged and is no longer used. Its commands are not imported into the new history.
- Auto-matching brackets and quotes.
- Bracketed paste handling.

https://github.com/user-attachments/assets/a1b7390e-eb33-4b9d-8915-85ae51c3039d

https://github.com/user-attachments/assets/d4877829-07e9-42c2-a66b-652695a5ebf4

## Using R Console

### Setup

1. Install a compatible version of [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) (see [Dependency Model](#dependency-model)).
2. Configure `r.executablePath`. The deprecated `r.rpath.<platform>` setting is still supported for compatibility. If neither setting is set, R Console looks for R on `PATH` and, on Windows, falls back to the R installation recorded in the Windows registry.
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

`R Console` resolves `r.executablePath`, then deprecated `r.rpath.*`, then `PATH`, with the Windows registry as the final Windows fallback. Ambient `R_HOME` is not used to select the executable; it is derived from the selected R executable instead.

## R Console Commands

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

### Delete All Command History

Use `R Console: Delete All Command History` from the Command Palette to delete all saved command history in the active R Console's history scope, including the on-disk history file.

The command requires confirmation and affects all consoles sharing that history scope. To delete individual or multiple history entries instead, open the history picker using `F8` and use the selection checkboxes and toolbar trash button.

## Configuration

R Console reads several settings from [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r):

| Setting | Purpose |
| --- | --- |
| `r.executablePath` | Vanilla R executable path |
| `r.consoleArgs` | Extra arguments passed to R |
| `r.rpath.<platform>` | Deprecated. Use `r.executablePath` instead |
| `r.rterm.option` | Deprecated. Use `r.consoleArgs` instead |
| `r.sessionWatcher` | Enables the [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) session watcher or console-scoped JSON-RPC bridge |
| `r.bracketedPaste` | Enables bracketed paste mode |
| `r.lsp.args` | Extra arguments passed when starting `languageserver` |
| `r.lsp.use_stdio` | Uses stdio instead of a loopback socket for the console LSP client when supported |
| `r.alwaysUseActiveTerminal` | Controls whether the new console is immediately focused |

The executable fallback order is `r.executablePath`, deprecated `r.rpath.*`, `PATH`, then the Windows registry on Windows. For console arguments, `r.consoleArgs` takes precedence over deprecated `r.rterm.option`.

R Console also contributes its own settings:

| Setting                    | Default       | Purpose                                                                                                                       |
| -------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `r.console.completionUI` | `quickPick` | Choose the Quick Pick completion picker (`quickPick`) or suggestions directly in the terminal (`inline`). |
| `r.console.inlineCompletion.trigger` | `tab` | Show inline suggestions while typing (`typing`) or when pressing Tab (`tab`). Applies only when `r.console.completionUI` is `inline`; it does not affect Quick Pick. |
| `r.console.historyScope` | `workspace` | Share history by workspace folder or use `global`. Applies when a console is created or reattached. |
| `r.console.autoMatch`    | `true`      | Auto-insert matching brackets and quotes                                                                                      |
| `r.console.tabSize`      | `2`         | Indentation width                                                                                                             |
| `r.console.pipeOperator` | <code>&#124;&gt;</code> | Pipe operator inserted by`R Console: Insert Pipe Operator` / `Ctrl+Alt+M`; supported values are <code>&#124;&gt;</code> and `%>%` |

## Dependency Model

Updated vscode-R compatibility requirements: R Console v0.5.3 requires vscode-R v3.2.0 or later. For vscode-R v3.0.1 or earlier, use R Console v0.5.2.

| R Console version | vscode-R version |
| --- | --- |
| v0.5.3 and later | v3.2.0 and later |
| v0.5.2 | v3.0.1 and earlier |

- [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) is a hard dependency. R Console uses the same configured R binary and the supported `sess` JSON-RPC 2.0 protocol for vscode-R 3.x, while retaining deprecated compatibility with the pre-3.0 session watcher.
- R's `languageserver` package is optional at runtime but required for language-server completion.
- The bundled `R_CONSOLE_HOST` sidecar is required at runtime. If the bundled binary for the current target is missing, the console does not fall back to a separate backend.

## Acknowledgements

R Console is built on the broader VS Code, Rust, and R ecosystems, and on the work of open-source projects that informed the extension. In particular:

- [vscode-R](https://github.com/REditorSupport/vscode-R) - R Console depends on vscode-R for configuration, session bootstrap, session watching, the supported JSON-RPC session protocol, and the surrounding VS Code R workflow.
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

