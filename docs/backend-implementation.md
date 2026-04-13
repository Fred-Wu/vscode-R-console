# Backend Implementation And Windows Test Handoff

This document is the current architecture note for `vscode-R-console`.

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

Current behavior:

1. `onDidCloseTerminal` fires after VS Code closes the tab
2. if the R console is still running, the extension immediately reattaches the same `RTerminal` instance to a new terminal tab
3. it then shows the modal confirmation dialog
4. if the user confirms close, the backend is shut down
5. if the user cancels, the reattached terminal remains visible

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

### 4.3 Startup environment

The extension builds the runtime environment before launching the sidecar.

Important environment values:

- `VSCODE_INIT_R`
  points to `vscode-R`'s `init.R`
- `VSCODE_WATCHER_DIR`
  points to the watcher directory used by `vscode-R`
- `R_PROFILE_USER`
  is replaced with this extension's own `console-profile.R`
- `R_PROFILE_USER_OLD`
  preserves the user's previous `R_PROFILE_USER`
- `VSC_R_EXECUTABLE`
  keeps the original configured R binary path
- `VSC_R_COLS`
  initial console width
- `VSC_R_ROWS`
  initial row count
- `VSC_R_SESSION_CWD`
  workspace cwd when available

The extension also sets the normal R environment such as `R_HOME`, `R_SHARE_DIR`, `R_INCLUDE_DIR`, `R_DOC_DIR`, `PATH`, and platform-specific loader paths.

`R_HOME` is forced from the selected executable instead of inheriting an
unrelated outer-process `R_HOME`.

### 4.4 `console-profile.R`

[`resources/r/console-profile.R`](../resources/r/console-profile.R) does three important things:

1. it sources the user's original `.Rprofile`
2. it sources `vscode-R`'s `init.R` via `VSCODE_INIT_R`
3. it replaces the pager so `file.show()` stays inside the console

This is part of the reason the extension depends on `vscode-R`: the console wants the same session bootstrap/watcher behavior as the normal `vscode-R` workflow.

## 5. Runtime Backend Protocol

The TypeScript/Rust boundary is defined in [`src/Runtime/backendProtocol.ts`](../src/Runtime/backendProtocol.ts) and [`sidecar/pty-host/src/protocol.rs`](../sidecar/pty-host/src/protocol.rs).

### 5.1 Transport

- Unix: Rust host stdin receives commands from the extension
- Windows: the extension writes commands to a dedicated named pipe passed in `VSC_R_BACKEND_COMMAND_PIPE`
- Rust host stdout carries framed output and control events
- Rust host stderr is reserved for diagnostic/error text

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
- `child-spawned`
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

### 9.2 Transport choice

The LSP transport is:

- stdio only when `r.lsp.use_stdio = true` and the platform is not Windows
- loopback socket otherwise

Windows uses the socket path, not stdio.

### 9.3 `console-language-server.R`

[`resources/r/console-language-server.R`](../resources/r/console-language-server.R) does the following:

1. adjusts `.libPaths()` using VS Code settings
2. optionally includes `renv` cache paths
3. verifies that the `languageserver` package is installed
4. starts `languageserver`
5. overrides `textDocument/semanticTokens/full` with a synchronous helper
6. adds a custom request:
   `rConsole/syncSessionState`

### 9.4 Session-state sync

The extension sends session state to the console LSP:

- attached packages
- loaded namespaces

That lets the LSP side know more about the live console session than a plain static text document would.

### 9.5 Completion sources

Completion is merged from:

- local context heuristics
- `languageserver`
- session watcher workspace state
- live member completion requests through the `vscode-R` session server for `$` and `@`

## 10. `vscode-R` Session Watcher Integration

The watcher integration lives in [`src/Runtime/sessionWatcher.ts`](../src/Runtime/sessionWatcher.ts).

### 10.1 What it watches

It watches files created by `vscode-R` under `VSCODE_WATCHER_DIR`:

- `request.log`
- `workspace.lock`
- `workspace.json`

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

### 10.3 Why it matters

The watcher is used for:

- scoping a console tab to one R session
- showing the real attached R pid when available
- session-aware completion
- passing package/namespace state to the console LSP

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

Windows idle/event pumping does not use the Unix input-handler APIs.

Current behavior:

- `GA_peekevent()` is called when available
- `R_ProcessEvents()` is called when available
- this is done from both the explicit idle pump and the callback path

This is what keeps Windows graphapp/help/GUI event processing moving while the console is waiting for input.

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
