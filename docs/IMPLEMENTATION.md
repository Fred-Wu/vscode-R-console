# Implementation

This document is the current implementation note for `vscode-R-console`.

It is written for another engineer or Codex instance that needs to understand:

- what the extension is actually running
- how the backend is implemented on Unix and Windows
- how the extension depends on VS Code, `vscode-R`, and `languageserver`
- what should be tested on Windows

It reflects the current codebase, not older design notes.

## 1. True Runtime Model

The runtime model is:

1. VS Code hosts the extension.
2. The extension creates a custom pseudoterminal implemented by `RTerminal`.
3. `RTerminal` starts one bundled Rust binary: `R_CONSOLE_HOST`.
4. `R_CONSOLE_HOST` embeds R directly in-process.
5. The TypeScript side and the Rust side communicate over a framed protocol carried on stdio.
6. `vscode-R` is still required for startup/bootstrap/session-watcher integration.
7. `languageserver` is started in a separate R process for completion, signatures, and semantic tokens.

Important correction:

- `R_CONSOLE_HOST` is not a wrapper around a second internal session-host process.
- The sidecar process is the embedded host.

### 1.1 Integration summary

This extension sits between VS Code, `vscode-R`, and `languageserver` rather than replacing them.

`vscode-R` integration:

- provides the configured `r.rpath.*` executable that R Console prefers at startup
- provides `R/session/init.R`, which is required for bootstrap
- provides the watcher/session-server files under `VSCODE_WATCHER_DIR`
- provides the session state used for search-path updates, workspace/global-environment data, and `$` / `@` member completion

`languageserver` integration:

- runs in a separate R process started by `resources/r/console-language-server.R`
- receives console-scoped virtual `r-console://` documents from the extension
- provides completion, signature help, and semantic tokens for the console buffer
- receives synchronized attached-package and loaded-namespace state from the active session
- has diagnostics disabled for console buffers, and cleans up virtual documents on close

VS Code integration:

- hosts the extension entrypoint and the custom pseudoterminal lifecycle
- provides terminal, tab, dialog, workspace-trust, and color-theme events used by the console
- remains the UI layer, while `vscode-R` and `languageserver` provide R-specific bootstrap and language intelligence

## 2. Packaging And Installed Binaries

The repo only stages one sidecar binary into `bundled/bin/` at a time, but Marketplace/release packaging is target-specific.

Current target-specific VSIX targets are:

- `win32-x64`
- `win32-arm64`
- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`

That means:

- a Windows install gets a Windows VSIX containing one Windows sidecar
- a macOS install gets a macOS VSIX containing one macOS sidecar
- a Linux install gets a Linux VSIX containing one Linux sidecar

Runtime lookup is simple because the installed package already matches the host:

- Windows: `bundled/bin/R_CONSOLE_HOST.exe`
- Unix: `bundled/bin/R_CONSOLE_HOST`

There is no runtime multi-binary chooser inside the installed extension.

## 3. Main Extension Flow

### 3.1 Terminal creation

The extension entrypoint is [`src/extension.ts`](../src/extension.ts).

When the user runs `r-console.createTerminal` or `r-console.createTerminalSide`:

1. the extension validates trust and workspace constraints
2. it resolves `RTerminalOptions`
3. it creates an `RTerminal`
4. it attaches the pseudoterminal to a VS Code terminal tab

### 3.2 Close / reattach behavior

VS Code does not provide a terminal "before close" hook for custom terminals.

Current behavior differs slightly between panel terminals and side-editor tabs, but the shutdown model is the same:

1. panel terminals are detected from `onDidCloseTerminal`
2. side-editor terminals are detected from tab-close events and then resolved back to the same console record by pid
3. if the R console is still running, the extension immediately reattaches the same `RTerminal` instance to a new terminal tab
4. it then shows the modal confirmation dialog
5. if the user confirms close, the backend is shut down
6. if the user cancels, the reattached terminal remains visible

This is implemented in [`src/extension.ts`](../src/extension.ts).

## 4. How The TypeScript Side Starts R

The relevant entrypoint is [`src/Terminal/options.ts`](../src/Terminal/options.ts).

### 4.1 R path selection

The extension prefers the R executable path from `vscode-R` settings:

- `r.rpath.windows`
- `r.rpath.mac`
- `r.rpath.linux`

If `r.rpath.*` is unset, the extension falls back to ambient `R_HOME` by
resolving `R_HOME/bin/R` (or `R.exe` on Windows). If `R_HOME` is also unset,
it finally falls back to `R` on `PATH`.

Once an executable is selected, the extension derives `R_HOME` from that
executable path and passes the derived value into the sidecar environment so
the embedded host loads the matching shared-library tree from the same
installation.

### 4.2 Hard dependency on `vscode-R`

This extension depends on `REditorSupport.r`.

It requires the file:

- `REditorSupport.r/R/session/init.R`

If that file is missing, startup is rejected.

This means the console is intentionally coupled to `vscode-R`'s session bootstrap model.

Implementation details:

- [`src/Terminal/options.ts`](../src/Terminal/options.ts) calls `vscode.extensions.getExtension("REditorSupport.r")` and resolves the installed extension path through the VS Code extension host.
- startup fails early if the extension is not installed or if `R/session/init.R` is missing from that installation
- the console does not try to reproduce vscode-R bootstrap logic itself; it delegates bootstrap to that `init.R`
- this is why there is no real standalone mode even though the terminal UI and the embedded host live in this repo

`vscode-R` settings and behaviors consumed directly by this extension:

- `r.rpath.windows`, `r.rpath.mac`, `r.rpath.linux`
- `r.rterm.option`
- `r.sessionWatcher`
- `r.bracketedPaste`
- `r.alwaysUseActiveTerminal`

How those settings are used in practice:

- `r.rpath.*` selects the R executable that both the embedded host and the console LSP use
- `r.rterm.option` is sanitized and forwarded, but wrapper-specific flags are removed and incompatible flags such as `--vanilla` / `--no-init-file` are rejected
- `r.sessionWatcher` controls whether the console watches vscode-R session files and enables session-aware completion/state sync
- `r.bracketedPaste` controls editor-send / paste behavior compatibility
- `r.alwaysUseActiveTerminal` influences whether the created R Console grabs focus immediately

### 4.3 Startup environment

The runtime launch environment is assembled in two stages:

1. [`src/Terminal/options.ts`](../src/Terminal/options.ts) builds the shared base environment while resolving startup options
2. [`src/Terminal/rTerminal/runtime.ts`](../src/Terminal/rTerminal/runtime.ts) adds launch-only values such as the current terminal size and the active console bootstrap script immediately before spawning the sidecar

Base environment values:

- `VSCODE_INIT_R`
  points to `vscode-R`'s `init.R`
- `VSCODE_WATCHER_DIR`
  points to the watcher directory used by `vscode-R`
- `R_PROFILE_USER_OLD`
  preserves the user's previous `R_PROFILE_USER`
- `VSC_R_EXECUTABLE`
  keeps the original configured R binary path
- `COLORTERM`
  is set to `truecolor`
- `R_CLI_NUM_COLORS`
  is set to `256`
- `R_CLI_DYNAMIC`
  is set to `true`

Launch-time environment values:

- `R_PROFILE_USER`
  is replaced with this extension's own `console-profile.R`
- `VSC_R_COLS`
  initial console width
- `VSC_R_ROWS`
  initial row count
- `VSC_R_SESSION_CWD`
  workspace cwd when available
- `VSC_R_EXT`
  extension install path used to resolve bundled resources

The extension also sets the normal R environment such as `R_HOME`, `R_SHARE_DIR`, `R_INCLUDE_DIR`, `R_DOC_DIR`, `PATH`, and platform-specific loader paths.

`R_HOME` is forced from the selected executable instead of inheriting an
unrelated outer-process `R_HOME`.

The ANSI and `cli` / `crayon` capability hints are currently env-based rather
than R-option-based because the embedded host is not a real tty.

### 4.4 `console-profile.R`

[`resources/r/console-profile.R`](../resources/r/console-profile.R) does three important things:

1. it sources the user's original `.Rprofile`
2. it sources `vscode-R`'s `init.R` via `VSCODE_INIT_R`
3. it replaces the pager so `file.show()` stays inside the console

This is part of the reason the extension depends on `vscode-R`: the console wants the same session bootstrap/watcher behavior as the normal `vscode-R` workflow.

Implementation details inside `console-profile.R`:

- it temporarily restores the user's original `R_PROFILE_USER` from `R_PROFILE_USER_OLD` before sourcing the user's profile
- profile lookup order is:
  `R_PROFILE_USER_OLD` if set, otherwise working-directory `.Rprofile`, otherwise `~/.Rprofile`
- the working directory is normally the selected workspace folder, so workspace `.Rprofile` is usually preferred over the global user profile when no explicit `R_PROFILE_USER` was present
- after user profile sourcing, it runs vscode-R bootstrap from `VSCODE_INIT_R` inside `tryCatch(...)` so bootstrap failures are reported but do not crash the whole console session
- it replaces `options(pager=...)` with a console pager implemented in R so pager navigation stays inside the terminal
- it locks `options(prompt=...)`, `options(continue=...)`, and `options(menu.graphics=...)` while the console is active so the embedded console prompt contract stays stable

That means `vscode-R` is not just a startup prerequisite. Its bootstrap script is part of the live session model that the console expects to run for every session.

## 5. Runtime Backend Protocol

The TypeScript/Rust boundary is defined in [`src/Runtime/backendProtocol.ts`](../src/Runtime/backendProtocol.ts) and [`sidecar/pty-host/src/protocol.rs`](../sidecar/pty-host/src/protocol.rs).

### 5.1 Transport

- Normal extension runs use a session socket: TypeScript passes `VSC_R_BACKEND_SESSION_FILE`, the Rust host binds a localhost command/output socket, writes the selected port and process id to that file, and TypeScript connects to it.
- That socket is the reload-reconnect boundary. The Rust host keeps the embedded R session alive for a short reconnect grace window if the extension host disconnects.
- If no session file is configured, the Rust host falls back to stdin commands and framed stdout output.
- Rust host stderr is reserved for diagnostic/error text.

The protocol frame header is 12 bytes and includes:

- payload length
- frame kind
- flags
- request id

### 5.2 Host capabilities

Current capabilities advertised by the embedded host:

- `control-channel`
- `shutdown`
- `session-control`
- `top-level-submit`
- `nested-input`
- `parse-status`
- `set-width`

### 5.3 Control events sent from Rust to TypeScript

Key events:

- `backend-ready`
- `host-connected`
- `session-state`
- `prompt`
- `busy`
- `input-request`
- `input-end`
- `dialog-request`
- `output-flush`
- `parse-status-result`
- `host-error`

### 5.4 Commands sent from TypeScript to Rust

Key commands:

- `submit`
- `reply-input`
- `interrupt`
- `set-width`
- `dialog-result`
- `shutdown`

### 5.5 Why stdout handling matters

The protocol shares stdio with R output, so the sidecar has to keep raw console writes from corrupting protocol frames.

Current behavior:

- Unix duplicates the original stdout fd for protocol output and redirects process stdout to stderr.
- Windows duplicates the stdout handle for protocol output, then redirects process stdout to stderr as well.

That keeps framed protocol traffic isolated from direct R console writes.

## 6. Terminal Frontend Model

The main terminal implementation is [`src/Terminal/rTerminal.ts`](../src/Terminal/rTerminal.ts).

### 6.1 `RTerminal` responsibilities

`RTerminal` owns:

- input state
- cursor movement
- multiline editing
- history
- reverse search
- prompt state
- submission queueing
- pseudoterminal writes
- runtime backend lifecycle
- reattach/restore behavior

### 6.2 Renderer and long-input viewport

Long live input is not rendered as an unbounded terminal transcript.

Instead:

- the editable input area is rendered through the viewport logic in [`src/Terminal/inputViewport.ts`](../src/Terminal/inputViewport.ts)
- [`src/Terminal/renderer.ts`](../src/Terminal/renderer.ts) tracks rendered row counts and cursor position inside that viewport
- the terminal can collapse or window long inputs instead of letting them spill uncontrollably

This matters because earlier duplication bugs came from mismatches between the viewport and submission echo paths.

### 6.3 Submission echo model

Current submit behavior is intentionally simple:

- when the current input is already fully visible and stable, the visible input can be reused
- otherwise, the live input render is cleared and the submission is echoed once
- before block splitting, submission normalization strips only true full-line R comment tokens; quoted `#...` text such as `Rcpp::sourceCpp()` headers is preserved
- the submission echo uses `ConsoleSyntax.snapshotNow(...)`
- there is no second async restyle/rewrite pass for submitted code

This is the current fix for the long-code duplication regressions.

## 7. Screen And Scrollback Restoration

The reattach model changed materially.

Current model:

- every terminal write is mirrored into an off-screen `@xterm/headless` terminal
- on reattach, the extension serializes that headless terminal buffer back into ANSI text
- style information is preserved per cell
- wrapped lines are reassembled into logical lines
- cursor position is restored after replay

The same replay buffer is also used for resize recovery:

- the viewport and scrollback are cleared first
- the saved logical lines are replayed at the new width so xterm can wrap them again naturally
- if the live prompt is visible, it is rendered again after the replay pass

Important related behavior:

- `Ctrl+L` resets the replay terminal itself, not just the visible viewport
- cleared output therefore stays cleared after both resize and reattach

Relevant implementation:

- [`src/Terminal/rTerminal.ts`](../src/Terminal/rTerminal.ts)

Important consequence:

- reattach restoration is based on a headless terminal buffer, not on a hand-maintained append-only scrollback transcript
- this is why restored styling now survives reattach

## 8. Syntax Highlighting Model

The console uses a two-layer highlighting model.

### 8.1 Immediate local styling

[`src/Terminal/consoleSyntax.ts`](../src/Terminal/consoleSyntax.ts) applies:

- default theme styling
- parser-driven token coloring
- bracket-pair coloring

The tokenizer comes from [`src/Language/parser.ts`](../src/Language/parser.ts).

Important recent change:

- obvious identifier-followed-by-`(` call sites are classified as `function` immediately
- for example, `plot(1:100)` now highlights `plot` as a function without waiting for semantic tokens

### 8.2 Semantic token overlay

The console then requests semantic tokens from the console-specific language server.

Those semantic tokens are layered on top of the immediate local styles.

This means:

- typing remains responsive even before LSP replies
- richer semantic styling still arrives when `languageserver` responds

## 9. `languageserver` Integration

The console-specific LSP client lives in:

- [`src/Language/consoleLspClient.ts`](../src/Language/consoleLspClient.ts)
- [`src/Terminal/rTerminal/lang.ts`](../src/Terminal/rTerminal/lang.ts)

### 9.1 Separate R process

The language server is not hosted inside `R_CONSOLE_HOST`.

It is a separate R process started with:

- the configured R binary
- `resources/r/console-language-server.R`

Implementation details:

- each `RTerminal` owns one [`RTermLang`](../src/Terminal/rTerminal/lang.ts) instance
- `RTermLang` lazily creates one [`ConsoleLspClient`](../src/Language/consoleLspClient.ts) per console session
- the client uses a unique console id and a dedicated temp working directory under the system temp folder
- the console LSP uses the same resolved `rPath` as the embedded runtime, so language features follow the same R installation as the running console

### 9.2 Transport choice

The LSP transport is:

- stdio only when `r.lsp.use_stdio = true` and the platform is not Windows
- loopback socket otherwise

Windows uses the socket path, not stdio.

Implementation details:

- the stdio path starts `R` directly through `vscode-languageclient`
- the socket path first opens a loopback server in the extension host, exports the chosen port through `VSCR_LSP_PORT`, then spawns `R` separately and waits for the language server to connect back
- Windows always uses the socket path to avoid the stdio/backend interaction problems that the console already has to manage for the embedded host
- stderr from the spawned LSP process is captured by the client, while normal LSP traffic goes over either stdio or the socket transport

### 9.3 `console-language-server.R`

[`resources/r/console-language-server.R`](../resources/r/console-language-server.R) does the following:

1. adjusts `.libPaths()` using VS Code settings
2. optionally includes `renv` cache paths
3. verifies that the `languageserver` package is installed
4. starts `languageserver`
5. overrides `textDocument/semanticTokens/full` with a synchronous helper
6. disables diagnostics for console-only buffers
7. overrides `textDocument/didClose` so `r-console://` documents are removed cleanly even though they have no filesystem path
8. adds a custom request:
   `rConsole/syncSessionState`

Implementation details:

- the script extends `.libPaths()` from `VSCR_LIB_PATHS` and optionally from `renv::paths$cache()` when `VSCR_USE_RENV_LIB_PATH` is enabled
- it exits with status code `10` when `languageserver` is missing; the TypeScript client treats that as the "package not installed" signal and warns the user
- it applies `languageserver` option-derived settings, then forces diagnostics off for console buffers
- it replaces `textDocument/semanticTokens/full` with a synchronous helper so the console can request semantic tokens deterministically for its virtual documents
- it special-cases `textDocument/didClose` because the console uses `r-console://...` virtual URIs rather than real workspace files
- it accepts console session state from the extension and pushes attached packages / loaded namespaces into the server workspace so completion and semantic context reflect the live console session more closely

### 9.4 Session-state sync

The extension sends session state to the console LSP:

- attached packages
- loaded namespaces

That lets the LSP side know more about the live console session than a plain static text document would.

Implementation details:

- [`RTermLang`](../src/Terminal/rTerminal/lang.ts) converts `SessionWatcher` workspace data into a `ConsoleLspSessionState`
- only package and namespace changes trigger a new sync; identical state is ignored
- [`ConsoleLspClient`](../src/Language/consoleLspClient.ts) sends that state through the custom `rConsole/syncSessionState` request after ensuring the client is running
- the R-side handler updates `startup_packages`, refreshes loaded-package state, and eagerly loads namespace metadata when possible

### 9.5 Completion sources

Completion is merged from:

- local context heuristics
- `languageserver`
- session watcher workspace state
- live member completion requests through the `vscode-R` session server for `$` and `@`

Implementation details:

- the current console input is mirrored into a long-lived virtual completion document
- completion requests manually send `textDocument/didOpen` / `didChange` notifications before each request so document state is ordered correctly
- semantic-token requests use short-lived snapshot virtual documents so one semantic request cannot corrupt the completion document state
- the completion pipeline prefers `languageserver` and session data, but can fall back to recent console/session identifiers when the language server does not return useful symbols
- `$` and `@` completions can bypass `languageserver` and go through vscode-R's session server when a live object/member lookup is needed

### 9.6 Error handling and lifecycle

The console LSP is intentionally quiet from the VS Code UI point of view.

Current behavior:

- client connection errors are suppressed as global popups
- shutdown close messages are suppressed when the console is intentionally disposing the client
- the client explicitly sends `workspace/didChangeConfiguration` with diagnostics disabled
- on stop/dispose, the client sends `textDocument/didClose` for all still-synced console documents before tearing the process down
- if a spawned R language-server process exits with code `10`, the console warns that the `languageserver` package is required

## 10. `vscode-R` Session Watcher Integration

The watcher integration lives in [`src/Runtime/sessionWatcher.ts`](../src/Runtime/sessionWatcher.ts).

### 10.1 What it watches

It watches lock files created by `vscode-R` under `VSCODE_WATCHER_DIR` and
then reads the corresponding data files:

- root `request.lock`, then reads root `request.log`
- attached-session `workspace.lock`, then reads session `workspace.json`
- the attached session directory itself until `workspace.lock` appears for the first time

### 10.2 What it gets from `vscode-R`

From `request.log`:

- attach/detach events
- R session tempdir
- session pid
- optional session server host/port/token

From `workspace.json`:

- search path
- loaded namespaces
- global environment summary

Implementation details:

- attach/detach/session metadata are read from `request.log`
- workspace state is reloaded from `workspace.json` when `workspace.lock` changes
- if the console does not yet know which session PID it belongs to, it auto-pins to the first fresh attach request it sees
- once pinned, it ignores attach events from other R sessions so multiple active R sessions do not cross-contaminate console state
- if vscode-R exposes an HTTP session server, the watcher also stores its host/port/token for later member-completion requests

### 10.3 Why it matters

The watcher is used for:

- scoping a console tab to one R session
- showing the real attached R pid when available
- session-aware completion
- passing package/namespace state to the console LSP

Detailed flow:

1. the console starts the watcher against `~/.vscode-R`
2. vscode-R writes an attach event to `request.log`
3. the watcher resolves the session tempdir and switches to that session's `vscode-R` directory
4. `workspace.lock` changes cause `workspace.json` reloads
5. workspace data is pushed into the terminal layer
6. `RTermLang` converts that data into LSP session state
7. member-completion HTTP requests use the stored session-server host/port/token when available

## 11. Unix Backend Implementation

Unix is implemented in the `unix_host` module inside [`sidecar/pty-host/src/host.rs`](../sidecar/pty-host/src/host.rs).

### 11.1 R library loading

The Unix host:

- resolves `R_HOME`
- loads `libR.so` on Linux or `libR.dylib` on macOS
- loads symbols with `libloading`

### 11.2 Callback registration

Unix uses the normal embedded callback globals:

- `ptr_R_ReadConsole`
- `ptr_R_WriteConsoleEx`
- optional `ptr_R_ShowMessage`
- optional `ptr_R_Busy`
- optional `ptr_R_Suicide`
- optional `ptr_R_ChooseFile`
- optional `ptr_R_EditFile`
- optional `ptr_R_EditFiles`
- optional `ptr_R_ProcessEvents`
- optional `R_PolledEvents`

It also sets:

- `R_Outputfile = NULL`
- `R_Consolefile = NULL`

so callback output is used instead of file-backed output.

### 11.3 Initialization

Unix initialization uses:

- `Rf_initialize_R`
- `setup_Rmainloop`
- `run_Rmainloop`

It marks R as interactive and captures:

- `R_interrupts_pending`
- `R_CheckUserInterrupt`
- `R_ExpandFileName`

### 11.4 Event pump

Unix idle/event pumping uses:

- `R_checkActivity`
- `R_runHandlers`
- `R_InputHandlers`
- optional `R_PolledEvents`

The host pumps these while waiting in `ReadConsole`.

### 11.5 Interrupt model

Unix interrupts use both:

- the `R_interrupts_pending` flag
- a real `SIGINT` to the current process

That combination is what the current Unix backend actually does.

## 12. Windows Backend Implementation

Windows is implemented in the `windows_host` module inside [`sidecar/pty-host/src/host.rs`](../sidecar/pty-host/src/host.rs).

### 12.1 R layout resolution

The Windows host derives `R_HOME` from:

- `R_HOME` if present
- otherwise the configured R executable path

It then looks for `R.dll` in:

1. `R_HOME/bin/<R_ARCH>` if `R_ARCH` is set
2. the executable's own parent directory
3. `R_HOME/bin/x64` on x64 builds
4. `R_HOME/bin/arm64` on arm64 builds
5. `R_HOME/bin`

Current intended support is:

- `x64`
- `arm64`
- fallback `bin`

Legacy `i386` is not a supported target.

### 12.2 DLL preload order

The Windows host preloads support DLLs from the chosen R DLL directory before loading `R.dll`.

Current order:

1. `Rgraphapp.dll`
2. `Rblas.dll`
3. `Riconv.dll`
4. `Rlapack.dll`
5. `R.dll`

This is done so dependent DLL resolution works correctly for embedded R and packages.

### 12.3 Windows symbol loading

The host loads Windows-specific symbols when present:

- `R_DefParams`
- `R_DefParamsEx`
- `R_SetParams`
- `cmdlineoptions`
- `R_common_command_line`
- `readconsolecfg`
- `getRUser`
- `GA_initapp`
- `GA_peekevent`
- `R_ProcessEvents`
- `CharacterMode`
- `UserBreak` or fallback `R_interrupts_pending`

### 12.4 Initialization path

Windows does not use the Unix `ptr_R_ReadConsole` initialization model.

Instead it:

1. builds an `Rstart` struct
2. initializes defaults with `R_DefParamsEx(..., 0)` when available, otherwise `R_DefParams`
3. optionally calls `cmdlineoptions`
4. optionally lets `R_common_command_line` fill startup flags from args
5. sets interactive mode and callback pointers on `Rstart`
6. sets `rhome` and `home`
7. calls `R_SetParams`
8. wires `ptr_R_ChooseFile`, `ptr_R_EditFile`, and `ptr_R_EditFiles` when available
9. calls `GA_initapp`
10. calls `readconsolecfg`
11. switches `CharacterMode` to `LinkDLL`
12. calls `setup_Rmainloop`

The `home` path is taken from `getRUser()` when possible, with ANSI-codepage decoding fallback.

### 12.5 Windows callbacks

Current Windows callback set includes:

- `ReadConsole`
- `WriteConsoleEx`
- `ShowMessage`
- `YesNoCancel`
- `Busy`
- `CallBack`
- `Suicide`
- `ChooseFile`
- `EditFile`
- `EditFiles`

### 12.6 Event pump

Windows idle/event pumping is centered on the Windows / graphapp message loop,
but it does not stop there.

Current behavior:

- the explicit idle pump drains the Windows message queue with `PeekMessageW` / `DispatchMessageW`
- optional input handlers still run through `R_checkActivity`, `R_runHandlers`, and `R_InputHandlers` when those symbols are available
- `later` callbacks are executed when `later.dll` is loaded
- `R_ProcessEvents()` is called when available
- the callback path (`process_events_callback` / `polled_events_callback`) also pumps Windows messages and available handlers

This is what keeps Windows graphapp/help/GUI event processing moving while the console is waiting for input, while still servicing handler-driven and `later`-driven work.

### 12.7 Interrupt model

Current Windows interrupt handling is flag-based, not signal-based.

The host sets:

- `UserBreak` when exported
- otherwise `R_interrupts_pending`

It also calls `R_CheckUserInterrupt` when needed after interrupted reads.

Important: the current implementation does not use `GenerateConsoleCtrlEvent`.
If someone is testing interrupts on Windows, they should validate the current flag-based path, not assume Unix-style `SIGINT` behavior.

## 13. Shared Backend Logic Between Unix And Windows

Although initialization differs per platform, most host-control logic is shared conceptually.

The same high-level state machine exists on both platforms:

- command reader thread reads backend frames from stdin on Unix or the backend named pipe on Windows
- commands are queued in shared state
- `ReadConsole` waits for top-level submits or nested replies
- parse-status requests are handled while waiting
- width changes are handled while waiting
- prompt/input-request events are emitted while waiting
- output is forwarded through `WriteConsoleEx`
- dialog requests are bridged back to VS Code

This means most frontend behavior is platform-independent even though the embedded-R wiring is platform-specific.

One important shared contract is prompt classification:

- only the locked console prompts `> ` and `+ ` are treated as top-level prompts
- everything else, including history-enabled prompts such as `Browse[1]>`, is treated as nested input

That shared rule is why `browser()`, pager prompts, and other nested reads now behave consistently on both Unix and Windows.

## 14. Recent Backend-Adjacent Fixes

These are important for Windows testing because they changed expected behavior.

### 14.1 Long-input duplication fix

Recent fixes removed the bad async submission-restyle model.

Current expected behavior:

- long live input is clipped/windowed in the editable viewport
- submitted code is echoed once
- no duplicated top rows
- no extra leading `R>`

### 14.2 Reattach restore fix

Reattach now restores:

- scrollback
- current visible screen
- cursor position
- ANSI styling

Expected behavior after cancelling a close:

- the console should look materially identical to before the close attempt

### 14.3 Immediate function-call coloring

`plot(1:100)` should color `plot` as a function immediately, even if the user submits quickly.

### 14.4 Resize replay and hard clear

Recent terminal fixes changed both resize recovery and clear-screen semantics.

Current expected behavior:

- terminal resize rebuilds the visible console from the headless replay buffer
- wrapped output is reflowed at the new width instead of replaying already-wrapped old rows
- empty prompt-only submits keep the visible `R> ` line after resize
- `Ctrl+L` clears the current viewport and also drops the replay buffer, so old content does not reappear later

### 14.5 Console completion and LSP cleanup

Recent console-language changes also affect what users should expect.

Current expected behavior:

- completion still prefers `languageserver` and session watcher data
- when those sources are missing, recent console identifiers can still appear as fallback suggestions
- console diagnostics are disabled
- closing a console-scoped `r-console://` virtual document should not leave stale LSP workspace state behind

## 15. Windows Testing Checklist

This is the minimum useful Windows validation list.

### 15.1 Installation / packaging

- install the correct target-specific VSIX for the machine
- confirm the installed extension contains one correct sidecar:
  `bundled/bin/R_CONSOLE_HOST.exe`
- confirm `REditorSupport.r` is installed
- confirm the startup resolution source points to the intended R install:
  `r.rpath.*`, else ambient `R_HOME`, else `PATH`

### 15.2 Startup

- create a console from the command palette
- confirm the sidecar starts cleanly
- confirm the prompt appears
- confirm the terminal title eventually shows the attached R pid
- confirm startup still works with `r.sessionWatcher` enabled

### 15.3 Console editing and submission

- single-line commands
- multi-line functions
- very long functions that exceed the visible input viewport
- history navigation through long commands
- reverse search
- bracketed paste
- parse completeness gating

Expected:

- no duplicated top rows
- no duplicate `R>`
- no second rewritten copy of the same submitted block

### 15.4 Highlighting and language features

- local highlighting while typing
- immediate function-call highlighting for `foo(...)`
- semantic highlighting after LSP response
- completions from `languageserver`
- signature help
- `$` / `@` member completion backed by the session server

### 15.5 `vscode-R` integration

- confirm `vscode-R` bootstrap still runs
- confirm session watcher updates search path and global env
- confirm attached packages / namespaces reach the console LSP
- confirm `file.show()` stays inside the console pager instead of spawning the external pager

### 15.6 Windows-specific backend behavior

- `plot()` responsiveness
- help/browser/graphapp responsiveness while waiting for input
- interrupt during long-running computation
- nested input (`readline()`, browser-like prompts, pager prompts)
- `file.choose()`
- `edit()`
- `file.edit()`
- `system()` and `system2()`

### 15.7 Reattach / close behavior

- close the terminal tab
- confirm it immediately reattaches before the modal dialog
- cancel close and verify the full screen is still there
- verify syntax coloring survives reattach
- confirm scrollback and cursor restoration are sane

## 16. Useful Failure Signals

When Windows testing fails, check these in order:

1. VS Code terminal output for startup failure text
2. the console LSP output channel
3. whether `R_CONSOLE_HOST.exe` exists in the installed extension
4. whether `vscode-R` is installed and its `R/session/init.R` exists
5. whether the resolved runtime source really points at the intended R install
6. whether `R.dll` and support DLLs exist in the expected `bin/x64`, `bin/arm64`, or `bin` directory

Typical failure classes:

- missing sidecar package for the current target
- missing `vscode-R`
- wrong runtime selection from `r.rpath.*`, ambient `R_HOME`, or `PATH`
- bad Windows R layout resolution
- missing support DLL preload
- no `languageserver`
- session watcher not attaching

## 17. Current Assumptions And Limits

- The console depends on `vscode-R`; there is no standalone mode.
- Windows support is for modern 64-bit layouts only.
- The Windows LSP path uses a socket transport, not stdio.
- Close interception is still constrained by the VS Code custom-terminal API.

## 18. Files To Read First

If another Codex needs to continue work, start with these files in this order:

1. [`src/extension.ts`](../src/extension.ts)
2. [`src/Terminal/options.ts`](../src/Terminal/options.ts)
3. [`src/Terminal/rTerminal.ts`](../src/Terminal/rTerminal.ts)
4. [`src/Terminal/rTerminal/runtime.ts`](../src/Terminal/rTerminal/runtime.ts)
5. [`src/Runtime/backendProtocol.ts`](../src/Runtime/backendProtocol.ts)
6. [`src/Runtime/sessionWatcher.ts`](../src/Runtime/sessionWatcher.ts)
7. [`src/Language/consoleLspClient.ts`](../src/Language/consoleLspClient.ts)
8. [`resources/r/console-profile.R`](../resources/r/console-profile.R)
9. [`resources/r/console-language-server.R`](../resources/r/console-language-server.R)
10. [`sidecar/pty-host/src/protocol.rs`](../sidecar/pty-host/src/protocol.rs)
11. [`sidecar/pty-host/src/host.rs`](../sidecar/pty-host/src/host.rs)
