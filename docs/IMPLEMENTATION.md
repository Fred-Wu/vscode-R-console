# Implementation

This document describes the implementation of `vscode-R-console`.

The implementation is centered on four parts:

1. the embedded R backend
2. the transport model between the backend and the VS Code UI
3. the `vscode-R` integration layer
4. the self-managed console session layer

## Implementation References

These are the main implementation references and the parts of this extension
they informed. They are references unless the entry explicitly says the project
is used as a dependency.

| Project | What is referenced or used | Where it appears here |
| --- | --- | --- |
| [`vscode-R`](https://github.com/REditorSupport/vscode-R) | Used for R executable settings, the vscode-R 3.x `sess` JSON-RPC 2.0 protocol, and deprecated pre-3.0 session-watcher compatibility. | `src/Terminal/options.ts`, `src/Runtime/VSCR/`, `resources/r/VSCR/` |
| [`arf`](https://github.com/eitsupi/arf) | Reference for Rust embedded-R host structure, dynamic R loading, platform-specific R initialization, callback wiring, generic event/input-handler pumping, and interrupt state handling. | `sidecar/pty-host/src/host.rs` |
| [Ark](https://github.com/posit-dev/ark) | Reference for native R frontend concepts, `ReadConsole` recovery after interrupts/nested input, nested-input separation, and generic R event/finalizer pumping while waiting for input. | `sidecar/pty-host/src/host.rs` |
| [`rchitect`](https://github.com/randy3k/rchitect) | Reference for embedding R from a non-R host process, R home/shared-library discovery, and callback/FFI boundary patterns. | `sidecar/pty-host/src/host.rs`, `src/Terminal/options.ts` |
| [`radian`](https://github.com/randy3k/radian) | Reference for terminal-first console interaction, prompt-centric editing, multiline editing, history, reverse search, and bracketed paste expectations. | `src/Terminal/rTerminal.ts` and supporting terminal modules |
| [`languageserver`](https://github.com/REditorSupport/languageserver) | Used directly as the R language server package for console completion. It is no longer used for console syntax highlighting. | `src/Language/consoleLspClient.ts`, `resources/r/console-language-server.R` |

No Ark, arf, radian, or rchitect source files are vendored into this repository.
The embedded backend, protocol, and terminal frontend are local
implementations adapted from those ideas.

## 1. Embedded Backend

The embedded backend is the Rust sidecar binary:

- Unix: `bundled/bin/R_CONSOLE_HOST`
- Windows: `bundled/bin/R_CONSOLE_HOST.exe`

Source files:

- [`sidecar/pty-host/src/main.rs`](../sidecar/pty-host/src/main.rs)
- [`sidecar/pty-host/src/host.rs`](../sidecar/pty-host/src/host.rs)
- [`sidecar/pty-host/src/protocol.rs`](../sidecar/pty-host/src/protocol.rs)

`R_CONSOLE_HOST` embeds R directly in its own process. It is not a wrapper
around another R terminal process, and it does not start a second session-host
binary.

On Windows, `main.rs` uses a launcher mode. The first process starts a detached
real host process using the same `R_CONSOLE_HOST.exe` binary. The detached
process is the process that loads R, owns the TCP control server, and owns the
console session.

### 1.1 Shared Backend State

Both Unix and Windows host modules maintain a shared state object for:

- queued top-level submissions
- queued nested replies
- parse-status requests
- dialog results
- pending width changes
- prompt/wait state
- busy state
- interrupt state
- shutdown state
- top-level recovery state

The backend command reader pushes protocol commands into this state. The R
callbacks read from the same state when R asks for console input, writes output,
requests dialogs, or reports busy state.

### 1.2 Unix R Loading

The Unix backend lives in the Unix module inside
[`sidecar/pty-host/src/host.rs`](../sidecar/pty-host/src/host.rs).

It resolves `R_HOME`, then dynamically loads:

- Linux: `libR.so`
- macOS: `libR.dylib`

The backend loads R symbols with `libloading`. Important symbols include:

- `Rf_initialize_R`
- `setup_Rmainloop`
- `run_Rmainloop`
- `R_ParseVector`
- `R_tryEval`
- `R_interrupts_pending`
- `R_CheckUserInterrupt`
- `R_ExpandFileName`
- optional event APIs such as `R_ProcessEvents`, `R_PolledEvents`, and
  `R_RunPendingFinalizers`

### 1.3 Unix Callback Wiring

Unix uses the normal embedded R callback globals:

- `ptr_R_ReadConsole`
- `ptr_R_WriteConsoleEx`
- `ptr_R_ShowMessage`
- `ptr_R_Busy`
- `ptr_R_Suicide`
- `ptr_R_ChooseFile`
- `ptr_R_EditFile`
- `ptr_R_EditFiles`
- `ptr_R_ProcessEvents`
- `R_PolledEvents`

It also sets:

- `R_Outputfile = NULL`
- `R_Consolefile = NULL`

That makes embedded R route console IO through the callback functions instead
of file-backed console streams.

Unix initialization calls:

1. `Rf_initialize_R`
2. `setup_Rmainloop`
3. `run_Rmainloop`

The backend adds `--interactive` when needed so embedded R is initialized as an
interactive console.

### 1.4 Windows R DLL Loading

The Windows backend lives in the Windows module inside
[`sidecar/pty-host/src/host.rs`](../sidecar/pty-host/src/host.rs).

It derives or uses `R_HOME`, then locates `R.dll` in this order:

1. `R_HOME/bin/<R_ARCH>` when `R_ARCH` is set
2. the configured R executable directory
3. `R_HOME/bin/x64`
4. `R_HOME/bin/arm64`
5. `R_HOME/bin`

Before loading `R.dll`, the backend preloads support DLLs from the selected R
DLL directory:

1. `Rgraphapp.dll`
2. `Rblas.dll`
3. `Riconv.dll`
4. `Rlapack.dll`
5. `R.dll`

This preload order is part of the backend implementation because embedded R and
some R packages rely on those DLLs resolving from the same R installation.

### 1.5 Windows Symbol Loading And Initialization

The Windows backend loads Windows-specific R symbols when present:

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
- `R_RunPendingFinalizers`
- `CharacterMode`
- `UserBreak`
- fallback `R_interrupts_pending`

Windows initialization uses `Rstart` instead of the Unix
`ptr_R_ReadConsole` startup path:

1. create an `Rstart` struct
2. initialize defaults through `R_DefParamsEx(..., 0)` or `R_DefParams`
3. apply command-line options through `cmdlineoptions` and
   `R_common_command_line` when available
4. set interactive mode and callback pointers on `Rstart`
5. set `rhome` and `home`
6. call `R_SetParams`
7. wire file/dialog callbacks
8. call `GA_initapp`
9. call `readconsolecfg`
10. switch `CharacterMode` to `LinkDLL`
11. call `setup_Rmainloop`

### 1.6 Windows Callback Wiring

Windows registers callbacks through the `Rstart` structure:

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

Those callbacks bridge embedded R to the same shared backend state used by the
Unix implementation.

### 1.7 R Event Loop And Input Handler Pumping

The backend does not hardcode package event loops. It only calls generic R and
platform event APIs.

Unix event pumping uses available symbols such as:

- `R_ProcessEvents`
- `R_checkActivity`
- `R_runHandlers`
- `R_InputHandlers`
- `R_PolledEvents`
- `R_RunPendingFinalizers`

Windows event pumping uses:

- the Windows message queue through `PeekMessageW` / `DispatchMessageW`
- `GA_peekevent`
- `R_ProcessEvents`
- `R_checkActivity`
- `R_runHandlers`
- `R_InputHandlers`
- `R_RunPendingFinalizers`

The backend runs these pumps while R is waiting in `ReadConsole` and from the
registered callback path. Input-handler draining is bounded per pump turn. If
an interrupt is requested during event processing, the backend preserves the R
interrupt flag and returns control to R.

### 1.8 ReadConsole State Machine

`ReadConsole` is the main bridge between R and the VS Code UI.

The backend distinguishes:

- top-level console prompts: the locked `> ` and `+ ` prompts
- nested prompts: every other prompt, including `readline()` and browser-style
  prompts

Top-level input is supplied from queued `submit` commands. Nested input is
supplied from queued `reply-input` commands.

While `ReadConsole` is waiting, the backend also handles:

- parse-status requests
- width changes
- interrupts
- shutdown requests
- dialog results
- event pumping

After busy evaluation or nested input returns, the backend can insert one
top-level recovery input before the next user command is consumed. The recovery
step is implemented in the shared backend state and is generic R console
handling; it does not inspect individual packages.

### 1.9 Interrupt Implementation

Unix interrupt implementation uses:

- `R_interrupts_pending`
- `SIGINT` sent to the current process
- `R_CheckUserInterrupt` where needed

Windows interrupt implementation uses:

- `UserBreak` when exported
- otherwise `R_interrupts_pending`
- `R_CheckUserInterrupt` where needed

Both platforms install a base R interrupt calling handler on the first real
top-level console read. That handler uses R's `abort` restart so R can unwind
through normal cleanup paths.

Windows does not use `GenerateConsoleCtrlEvent`.

## 2. Transport Model Between Backend And UI

TypeScript transport implementation:

- [`src/Runtime/runtimeBackend.ts`](../src/Runtime/runtimeBackend.ts)
- [`src/Runtime/backendProtocol.ts`](../src/Runtime/backendProtocol.ts)

Rust transport implementation:

- [`sidecar/pty-host/src/protocol.rs`](../sidecar/pty-host/src/protocol.rs)
- the session command reader in [`sidecar/pty-host/src/host.rs`](../sidecar/pty-host/src/host.rs)

### 2.1 Session Startup Transport

When a console starts, `RustSidecarRuntimeBackend.start(...)`:

1. creates a UUID session id
2. creates a per-session bootstrap file path
3. spawns `R_CONSOLE_HOST`
4. passes `VSC_R_BACKEND_SESSION_FILE` to the backend
5. passes initial connect and reconnect grace values
6. detaches/unrefs the process from the VS Code extension host

The Rust host reads `VSC_R_BACKEND_SESSION_FILE`, binds a TCP listener on
`127.0.0.1:0`, then writes JSON to the bootstrap file:

```json
{"port":12345,"pid":67890}
```

The TypeScript side polls that file, reads the port and pid, then connects to
the loopback server.

### 2.2 Reconnect Transport

Reconnect uses `RuntimeSessionReconnectInfo`:

- `sessionId`
- `port`
- `pid`

`RustSidecarRuntimeBackend.reconnect(...)` creates a new
`RuntimeSessionHandle` around that information. It does not spawn a new R
backend. It connects to the existing loopback TCP server.

The runtime checks process liveness before reconnecting:

- if the recorded backend pid is dead, the reconnect info is discarded
- if the Windows launcher process has exited but the detached real host pid is
  alive, reconnect continues

### 2.3 Active Client Model

The Rust backend accepts one active control client at a time.

Implementation details:

- each accepted socket receives a client id
- `current_client` stores the currently active id
- a new socket replaces the previous active socket
- command-reader threads exit when their client id is no longer current
- output is attached to the active client writer
- when the active client disconnects, output is detached and the reconnect
  grace timer is applied

This is how a console tab can detach and another UI instance can attach to the
same embedded R backend.

### 2.4 Framed Protocol

The protocol frame header is 12 bytes:

- payload length
- frame kind
- flags
- request id

Backend events sent to TypeScript include:

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

Commands sent to Rust include:

- `submit`
- `reply-input`
- `interrupt`
- `set-width`
- `dialog-result`
- `shutdown`

Host capabilities are advertised through `backend-ready`:

- `control-channel`
- `shutdown`
- `session-control`
- `top-level-submit`
- `nested-input`
- `parse-status`
- `set-width`

### 2.5 Output Channel

Rust emits console output and control events through the active protocol writer.
If no client is attached, `protocol.rs` queues frames in an output backlog.

The backlog is bounded by:

- maximum buffered frames
- maximum buffered bytes

When a client attaches, the backend:

1. attaches the socket writer
2. flushes the backlog
3. emits `backend-ready`
4. emits `host-connected`
5. emits `session-state`
6. emits `output-flush`

### 2.6 Shutdown Transport

Attached sessions close by writing a `shutdown` frame over the active socket.

Detached sessions close by:

1. constructing a temporary runtime backend in the extension host
2. reconnecting to the stored `sessionId` / `port` / `pid`
3. writing the same `shutdown` frame

The Rust command reader maps `shutdown` to the backend shared shutdown state.

## 3. `vscode-R` Integration

The console depends on `vscode-R`, but it does not own or manage the
`vscode-R` session.

Implementation files:

- [`src/Terminal/options.ts`](../src/Terminal/options.ts)
- [`src/Terminal/rTerminal/runtime.ts`](../src/Terminal/rTerminal/runtime.ts)
- [`src/Runtime/VSCR/index.ts`](../src/Runtime/VSCR/index.ts)
- [`src/Runtime/VSCR/integration.ts`](../src/Runtime/VSCR/integration.ts)
- [`src/Runtime/VSCR/types.ts`](../src/Runtime/VSCR/types.ts)
- [`src/Runtime/VSCR/legacy/integration.ts`](../src/Runtime/VSCR/legacy/integration.ts)
- [`src/Runtime/VSCR/legacy/sessionWatcher.ts`](../src/Runtime/VSCR/legacy/sessionWatcher.ts)
- [`src/Runtime/VSCR/sess/integration.ts`](../src/Runtime/VSCR/sess/integration.ts)
- [`src/Runtime/VSCR/sess/sessProxy.ts`](../src/Runtime/VSCR/sess/sessProxy.ts)
- [`resources/r/console-profile.R`](../resources/r/console-profile.R)
- [`resources/r/VSCR/legacy.R`](../resources/r/VSCR/legacy.R)

The terminal and shared runtime depend only on `VscodeRSessionIntegration`.
`src/Runtime/VSCR/index.ts` is the factory boundary that selects the disabled,
legacy, or `sess` implementation. Transport-specific state, startup, completion,
activation, reconnect, output filtering, and disposal stay inside the selected
implementation directory.

Support for vscode-R versions earlier than 3.0 is deprecated and may be removed
in a future R Console version. The legacy integration remains isolated so it can
be removed without changing the terminal or runtime architecture.

When legacy support is retired, its removal boundary is:

1. delete `src/Runtime/VSCR/legacy/` and `resources/r/VSCR/legacy.R`
2. remove the legacy option variant and detection branch from
   `src/Runtime/VSCR/types.ts` and `src/Runtime/VSCR/config.ts`
3. remove the legacy factory branch from `src/Runtime/VSCR/index.ts`

No terminal, runtime, language-service, or persistence code should require a
legacy-specific edit.

### 3.1 Startup Settings From `vscode-R`

R Console resolves the R executable in this order:

1. `r.executablePath`
2. deprecated `r.rpath.windows`, `r.rpath.mac`, or `r.rpath.linux`
3. `R` on `PATH`
4. the Windows R registry entry on Windows

Ambient `R_HOME` is not used to choose an R executable. After an executable is
selected, R Console derives `R_HOME` from that executable so the embedded
runtime stays anchored to the same R installation.

The selected executable is used to derive:

- `R_HOME`
- `R_SHARE_DIR`
- `R_INCLUDE_DIR`
- `R_DOC_DIR`
- platform loader paths

The same selected R executable is used for:

- the embedded backend
- the console-owned `languageserver` process

### 3.2 Startup Bootstrap

When `r.sessionWatcher` is enabled, startup chooses one vscode-R session
integration:

- `sess`: vscode-R 3.x architecture exposed by vscode-R's public session API.
  `src/Runtime/VSCR/sess/integration.ts` obtains the IPC endpoint through
  `session.getConnectionInfo()`, starts a console-owned `SessProxy`, then calls
  `session.prepareAttachment()` with the proxy endpoint. The resulting managed
  bootstrap script is sourced by the embedded R launch; vscode-R owns `sess`
  installation, plot-backend configuration, and attachment preparation.
- `legacy`: deprecated pre-3.0 file-based watcher architecture. `R Console`
  sources vscode-R's `R/session/init.R` and uses `VSCODE_WATCHER_DIR`.

In `sess` mode, vscode-R owns the IPC server and package installation/update
policy. The `sess` R package may be bundled with vscode-R or installed as a
regular R package; R Console does not use its filesystem location for
architecture detection. The transport is a Unix socket on macOS/Linux or a
Windows named pipe. Messages are JSON-RPC 2.0 objects framed as
newline-delimited JSON. R Console does not target the obsolete
WebSocket/port-token `sess` transport.

The `SessProxy` is a transparent IPC proxy. The embedded R session connects to
the console-owned proxy endpoint, and the proxy connects to vscode-R's endpoint.
Raw newline-delimited JSON-RPC messages are forwarded in both directions. R
Console observes workspace responses and injects its own `workspace` and
`completion` requests when the console needs session data. It uses vscode-R's
public API for connection discovery, attachment preparation, terminal
registration, connection references, and session activation; it does not use
VS Code's global completion command for runtime completion.

The proxy is scoped to the embedded backend runtime session and is indexed by
the backend session id while connected. The managed bootstrap connects `sess`
through the proxy endpoint and forwards the versioned attach handshake to
vscode-R. R Console validates attachment and connection references before
binding the corresponding pseudoterminal. Background consoles are bound
without changing the active R session; terminal focus selects the matching
session through vscode-R's public `session.activate()` API. No native shell
PID is required for the pseudoterminal.

The console passes its proxy endpoint to `prepareAttachment()`, not through
the launch environment, and does not create discovery files. It retains
`SESS_PLOT_BACKEND` and `SESS_RSTUDIOAPI` in the R environment for compatibility
with code that reads these settings. The values reflect vscode-R's resolved
plot-backend preference and `r.session.emulateRStudioAPI` setting, respectively;
vscode-R's managed bootstrap independently configures the actual sess options.
Reconnection refreshes both variables from the current configuration before
sourcing the newly prepared managed bootstrap.
It clears inherited `SESS_DISCOVERY_FILE` values so a console cannot attach through
another terminal's settings. After a window reload, it obtains a new endpoint
and reconnects when the restored console reaches an empty main prompt.
Detached consoles in the same window reuse their existing proxy connection.

The backend launch environment includes:

- `R_PROFILE_USER_OLD`
- `VSC_R_EXECUTABLE`

Depending on the selected session integration, it also includes:

- `R_CONSOLE_SESSION_BOOTSTRAP`
- `SESS_PLOT_BACKEND` (managed sess mode)
- `SESS_RSTUDIOAPI` (managed sess mode)
- `VSCODE_WATCHER_DIR`
- `VSCODE_INIT_R`

At launch time, `rTerminal/runtime.ts` also sets:

- `R_PROFILE_USER` to this extension's `console-profile.R`
- `VSC_R_COLS`
- `VSC_R_ROWS`
- `VSC_R_SESSION_CWD`
- `VSC_R_EXT`

`console-profile.R` then:

1. restores and sources the user's original profile through
   `R_PROFILE_USER_OLD`
2. sources the selected `R_CONSOLE_SESSION_BOOTSTRAP`, when present
3. installs the console pager
4. locks the prompt options used by the embedded console contract

The `sess` bootstrap is prepared by vscode-R and is not bundled with R Console.
The legacy implementation still sources `resources/r/VSCR/legacy.R`, which
runs vscode-R's legacy `init.R`.

### 3.3 Session Metadata

In `legacy` mode, `SessionWatcher` reads the file-based `request.log`,
`workspace.lock`, and `workspace.json` files.

In `sess` mode, session metadata flows through the proxy between R and vscode-R.
The R side sends JSON-RPC notifications such as `attach` and
`workspace_updated`; vscode-R sends JSON-RPC requests such as `workspace` and
`completion`. R Console may also inject `workspace` and `completion` requests
to the R-side socket and consumes the matching responses itself.

Notifications consumed from R:

- `attach`
- `detach`
- `workspace_updated`

Requests sent to R:

- `workspace`
- `completion`

The `workspace` response provides:

- search path
- loaded namespaces
- global environment summary

The `completion` response provides runtime `$` and `@` members for an
expression. Console data-frame bracket completion uses the same runtime
completion request with the data object expression, because vscode-R 3.0
workspace summaries do not carry column/member names.

For reconnect in `sess` mode, R Console does not create a vscode-R discovery
file. After a VS Code window reload, it obtains the current endpoint again through
vscode-R's public session API and reconnects the restored console when it reaches
an empty main prompt. Detached consoles in the same window reuse their existing
proxy connection.

### 3.4 Metadata Consumers

In `legacy` mode, the console consumes watcher metadata for:

- display pid selection
- search-path aware completion
- global-environment completion
- `$` and `@` member completion through the `vscode-R` session server when
  available
- attached package and namespace sync into the console-owned language server

In `sess` mode, vscode-R owns the broader session metadata stream. `R Console`
owns only the console-side proxy and completion routing needed for the embedded
console. Runtime `$`, `@`, and data-frame bracket completion are requested from
the current embedded R session through the `sess` JSON-RPC `completion` method.
Workspace snapshots are cached from forwarded or console-injected `workspace`
responses and are used for search-path/package synchronization and top-level
workspace completions.

This integration is read-only with respect to broader `vscode-R` session
features. The console does not create, replace, restore, or stop vscode-R plot,
data, help, browser, httpgd, or addin sessions.

### 3.5 Completion And Language Server

Implementation files:

- [`src/Terminal/rTerminal/lang.ts`](../src/Terminal/rTerminal/lang.ts)
- [`src/Language/completion.ts`](../src/Language/completion.ts)
- [`src/Language/consoleLspClient.ts`](../src/Language/consoleLspClient.ts)
- [`src/Language/virtualRDocument.ts`](../src/Language/virtualRDocument.ts)
- [`resources/r/console-language-server.R`](../resources/r/console-language-server.R)

Inline completion is the terminal completion frontend selected with
`r.console.completionUI = "inline"`; the default `quickPick` mode uses the
VS Code picker. F7 is inactive in inline mode. `RTermLang` supplies both
frontends with the same completion sources, query ranking, groups and insertion
rules. Argument completions are selected first in function-call contexts when
available; an explicit user selection remains active while results refresh.

The `r.console.inlineCompletion.trigger` setting chooses automatic
debounced suggestions or Tab activation. In Tab mode, editing refreshes an open
list without opening a closed one. Tab or Enter accepts the selected suggestion,
Escape dismisses it, and clearing the input dismisses the list and invalidates
outstanding requests. Backspace resets the suggestion selection and viewport.

The terminal renderer draws a bordered transient suggestion panel below the
active input caret line. It anchors the panel horizontally to the preceding
display cell, clamps it to the terminal width, and reserves rows for the panel
inside the input viewport. Terminal Unicode display-cell widths determine
suggestion alignment, input row counts and cursor positioning. Suggestion rows
are excluded from saved replay and restored terminal history.

Each row can display the completion icon, label, match highlighting,
description and detail. Group labels share the terminal background with
unselected suggestions. The active row has a continuous selection background.
Colors use the `workbench.colorCustomizations`
`editorSuggestWidget.highlightForeground` and
`editorSuggestWidget.selectedBackground` settings when defined, otherwise
light/dark terminal-compatible defaults. Module icons use `{}`; other symbols
use colored terminal glyphs. The pseudoterminal inherits the configured
terminal font and cannot access resolved editor widget theme colors.

The completion controller manages a bounded, scrollable viewport with an
in-box scrollbar. Up/Down and Page Up/Down navigate completion choices, moving
the viewport when the selected item reaches a visible edge. Temporary SGR mouse
reporting permits wheel navigation within the panel and clicks on suggestions
or their detail rows. Scrollbar clicks navigate the suggestion list without
accepting an item; group headings and frame borders are not selectable.
Wheel reports outside the box invoke VS Code terminal scrollback commands.
Cursor-position reports establish the panel's screen coordinates for mouse
hit-testing. Mouse reporting is disabled when the panel closes.

`RTermLang` owns the console completion flow. It detects the completion
context, builds fast runtime suggestions from cached session data and the
current input, then merges the full completion result when language-server and
fresh session data are available.

Completion data comes from one shared flow:

- runtime/global-environment symbols come from the selected session integration's
  cached workspace data
- `$` and `@` member completion uses the selected session integration:
  `sess` JSON-RPC for vscode-R 3.x or the deprecated legacy session server for
  pre-3.0 vscode-R
- data-aware bracket and pipe-placeholder contexts use cached session metadata
  and current input for the first suggestion pass
- language-server symbols come from the console-owned `languageserver` process

The console starts and owns a separate `languageserver` process through
`ConsoleLspClient`. The client manually sends open/change/close notifications
for in-memory `r-console://` documents so completion requests observe the
latest console input. Attached packages and loaded namespaces are synced
through `rConsole/syncSessionState`; unchanged state is not resent on every
completion request. The console starts the language server when the console
opens and sends one silent completion request to warm the first language-server
completion path. Runtime start and attach events reuse that same client rather
than replacing it. Each client owns a unique temporary working directory and
removes it only after its R process has stopped. The language-server child also
inherits the normalized R environment used by the console runtime. Diagnostics
are disabled because the virtual console document exists only to provide
completion context and must not be linted as a source file.

The contributed `F7` keybinding is limited to an active R Console and invokes
its internal forced-completion handler when VS Code handles the keybinding. If
VS Code instead forwards F7 to the pseudoterminal, `KeyProcessor` maps the
standard xterm `ESC [ 18 ~` sequence to the same forced-completion handler.
This fallback keeps completion available when
`terminal.integrated.sendKeybindingsToShell` is enabled without changing the
separate Tab action used for indentation and contextual completion. Forced
completion shows the Quick Pick before full workspace and language-server
results arrive, then fills the open window asynchronously.

Console syntax highlighting is separate from language-server completion. It is
implemented locally by `src/Terminal/consoleSyntax.ts` and
`src/Terminal/syntaxTheme.ts`, mapping local token types to the active VS Code
theme's semantic-token colors.

## 4. Self-managed Console

Self-managed console implementation is split between:

- [`src/extension.ts`](../src/extension.ts)
- [`src/Terminal/rTerminal.ts`](../src/Terminal/rTerminal.ts)
- [`src/Runtime/runtimeBackend.ts`](../src/Runtime/runtimeBackend.ts)

The self-managed console is the extension's own embedded backend session. It is
separate from the `vscode-R` session watcher.

### 4.1 Runtime Session Handles

`runtimeBackend.ts` exposes:

- `start(args, options)`
- `reconnect(info)`
- `attach(session, handlers)`
- `detach(session)`
- `sendSessionCommand(session, command)`
- `requestParseStatus(session, code)`
- `close(session)`
- `isAlive(session)`
- `getPid(session)`
- `getReconnectInfo(session)`

`RTerminal` stores the returned `RuntimeSessionHandle` as its backend session.
The handle is used for all protocol commands and for exporting reconnect state.

### 4.2 Persisted Console Records

The extension stores self-managed console records in:

- `persistent-sessions.json`

The file is stored under extension storage:

- `context.storageUri` when available
- otherwise `context.globalStorageUri`

Each record contains:

- runtime reconnect info: session id, port, pid
- persisted terminal options: R path, R args, watcher settings, bracketed paste,
  cwd
- UI replay state: replay buffer, dimensions, mode, prompt state, input text,
  cursor position, backend pid
- terminal location: panel or editor column

The persisted data belongs to R Console. It is not a `vscode-R` session
snapshot.

### 4.3 Registry Loading And Pruning

On activation, `extension.ts` loads `persistent-sessions.json`.

Records are validated before use. A record is kept only when:

- its runtime reconnect info is structurally valid
- its terminal options are structurally valid
- its UI replay state is structurally valid
- its recorded backend pid is either absent or still alive

Dead records are removed from the in-memory registry and the persisted file is
rewritten.

### 4.4 Creating A Console

Creating a console follows this implementation path:

1. `createRTerminal(...)` resolves `RTerminalOptions`
2. `new RTerminal(...)` creates the terminal controller
3. `attachTerminal(...)` creates a VS Code pseudoterminal
4. `RTerminal` calls the runtime backend to start a session
5. `runtimeBackend.ts` starts `R_CONSOLE_HOST`
6. the backend writes the bootstrap file
7. TypeScript connects to the loopback server
8. backend events update terminal state
9. the extension schedules persistence of the session record

### 4.5 Attaching A Detached Console

Attaching a detached console follows this implementation path:

1. the session manager reads the persisted record
2. `buildPersistentTerminalOptions(...)` combines current resolved options with
   persisted options
3. `new RTerminal(options, extensionPath, persistedState)` rebuilds the frontend
4. the persisted runtime reconnect info is passed to `runtimeBackend.reconnect`
5. TypeScript connects to the existing backend socket
6. the terminal replay state is used to rebuild the visible terminal

No new embedded R backend is started for a reconnect.

### 4.6 Detaching Or Closing A Managed Console

Attached console detach persists the latest reconnect/UI state, disconnects the
frontend socket, disposes the VS Code terminal UI, and leaves the backend session
running for the next session-manager attach.

Attached console close uses the active `RTerminal` and active runtime session.

Detached console close uses the persisted reconnect info:

1. create a runtime backend object
2. call `reconnect(...)` with the persisted runtime info
3. call `close(...)`
4. remove the persistent registry record

The close command targets the R Console backend socket. It does not send any
command to `vscode-R`.

### 4.7 Persistence Updates

The extension persists console records:

- after console creation
- after attach/detach state changes
- after terminal title/pid updates
- on a debounce timer
- on a heartbeat timer
- during extension shutdown

`RTerminal.exportPersistentState()` is the source of the persisted runtime and
UI state. If the runtime backend cannot provide reconnect info, the terminal is
not persisted.

### 4.8 Command History

`src/Terminal/history.ts` keeps command history in memory for console input,
search, and navigation. One shared background worker handles file access,
workspace-path resolution, parsing, and compaction through `historyStore.ts`.
Console startup and command submission do not wait for history storage.
Each submitted command has a stable record ID and an explicit completion marker;
the foreground retains unconfirmed submissions until a durable acknowledgement.
If the worker fails, it is restarted and replays unconfirmed records idempotently.
Worker-instance lock tokens allow the replacement to reclaim an orphaned lock
without treating other live workers as stale. Partial tagged records can be
removed atomically while preserving completed records appended by other consoles.
New commands are available locally immediately; saved commands and changes
from other consoles arrive in the background. Updates carry only changed
entries when possible. The foreground retains a recent history window, while the background worker
keeps the bounded durable history store. F8 searches and fetches results through
paged worker requests, initially returning up to 50 matches and loading further
matches on demand. Up/Down navigation requests older/newer windows when reaching
a loaded boundary. An older picker selection loads its surrounding commands
before restoring the navigation cursor. Deleting individual or checked entries
operates on persisted occurrence IDs; collapsed duplicates are matched within
the chosen history scope. Deletion rewrites under the history file lock. Durable deletion metadata
records occurrence IDs or hashes of deleted command text, never the deleted
plaintext, together with a submission-time boundary. This prevents stale
pending writes in another window or restarted worker from recreating deleted
records while allowing genuinely new submissions after deletion.
The Command Palette exposes Delete All Command History for the active scope.

The worker manages plaintext command history separately
from persistent terminal replay. Each console selects its scope at creation or
reattachment using `r.console.historyScope`: the default `workspace` scope
shares commands between consoles whose initial working directory belongs to the
same workspace folder, while `global` (and consoles without a workspace
folder) uses one shared history. Files are stored under
`context.globalStorageUri/history/`, named `global.history` or
`workspace-<SHA256>.history`. The old `~/.r_console_history` is not used.

Each history file is limited to 20,000 commands; compaction retains the newest
19,000 before subsequent appends. Entries preserve multiline text and timestamps.
The `# r-console-history-base:` marker tracks removed entries so concurrent
consoles maintain stable navigation positions even across duplicate commands.
Normal appends reconcile only bytes added since the last known disk offset
under the per-file lock; file replacement or compaction triggers a full
reload. Pending local commands are excluded during reconciliation and
restored if persistence fails. Each new record carries a stable command ID
and completion marker; the worker acknowledges only saved IDs. On a failed
partial append, rollback removes bytes written by that attempt when safe.
If rollback fails, recovery discards incomplete tagged records using an
atomic rewrite under the per-file lock while preserving other consoles'
completed records. Unacknowledged entries are replayed using their stable
IDs so repeated identical commands remain distinct without duplicating
retries. If compaction succeeds but a subsequent append fails, the in-memory
view retains the compacted entries alongside pending commands instead of
reviving entries already pruned from disk. A failed non-compacting append
restores its previous disk cursor and count so retries reread concurrent
writes correctly. Invalid or empty lock owners are reclaimed after the
stale-lock timeout, while recent locks stay protected. A replacement worker
can also reclaim a lock identified as belonging to a terminated worker.
F8 keeps the current in-memory history positions stable while the picker is
open by deferring visible foreground cache updates. Worker snapshots and
persistence acknowledgements are processed immediately, so additional
submissions can be sent to disk even while the picker remains open. The
visible cache is reconciled when the picker closes, preserving navigation
positions. Background worker file access is never suspended.
Readers and writers coordinate through a per-file lock; queued submissions
are retried after lock contention or write failures. The terminal disposal
path queues remaining writes and releases the console immediately. The worker
finishes pending writes after the console closes. Extension shutdown allows
a bounded asynchronous drain before stopping the worker. If
storage remains unavailable when VS Code exits, persistence cannot be
guaranteed. If a write fails after
synchronizing the disk snapshot, the console restores its in-memory history
and navigation cursor so unsaved commands remain available in F8 and Up/Down
until a subsequent retry succeeds. Newly created history directories and
files request Unix permissions `0700` and `0600`; existing permissions
remain unchanged, and Windows relies on inherited filesystem permissions.

Up/Down and Ctrl+P/Ctrl+N skip consecutive identical entries without removing
them. Ctrl+R searches backward for the current line's trimmed text anywhere
in a saved command; repeated Ctrl+R uses the original term to find older
matches. F8 (`r-console.searchHistory`) uses native VS Code Quick Pick
multiple-selection checkboxes and the built-in Select All control.
Selection uses VS Code's native checked state without rerendering items on checkbox changes; the public Quick Pick API does not permit custom row backgrounds.
Search changes clear selections to avoid deleting hidden commands. An empty history leaves F8 open with the empty-history hint in the search box only, not in the title or a notification. The title shows the number of loaded history entries when nonempty. The
toolbar trash action deletes checked entries currently loaded into the
picker. The separate **Delete All Command History** command clears the
entire history scope, including entries not yet loaded. Accept restores the checked commands in chronological order into one editable multiline console input without executing them. Neither an unchecked highlighted command nor an empty selection is accepted. VS Code's Quick Pick API does not expose separate Enter and OK events.
The initial picker page contains the newest 50 matching records; approaching the last active row automatically fetches another page (the toolbar
Load More action remains available for mouse-wheel scrolling, which the public Quick Pick API cannot observe). Pages follow stable occurrence IDs with recovery for deleted cursors without adding a selectable
pseudo-entry. Searches are handled by the background worker across the
retained history, with exact-duplicate collapse governed by the persisted
global-state preference. Each entry has a stable occurrence ID.
After deletion the picker refreshes its existing loaded range without
discarding the search query. A single checked entry restores its exact
historical navigation position, fetching the surrounding history on demand
if needed. Multiple checked entries create a combined draft without a
history position: Up starts from the newest saved command and Down past
that entry restores the combined draft without executing it. Editing
the combined input expands the collapsed history-navigation mode.
Up/Down navigation keeps at most 400 rows in a sliding foreground window,
fetching adjacent 200-row batches with worker-side location hints if a boundary
occurrence was deleted in another VS Code window. The worker remains the source
of all retained history records.
New submissions continue to be persisted while the picker is open.
Deletion tombstones cannot be discarded on a time-only basis: independent
windows can replay delayed submissions with their original timestamps, so
metadata must remain until a newer rule provably subsumes it.

## 5. Files To Read First

1. [`src/extension.ts`](../src/extension.ts)
2. [`src/Runtime/runtimeBackend.ts`](../src/Runtime/runtimeBackend.ts)
3. [`src/Runtime/backendProtocol.ts`](../src/Runtime/backendProtocol.ts)
4. [`src/Terminal/rTerminal.ts`](../src/Terminal/rTerminal.ts)
5. [`src/Terminal/rTerminal/runtime.ts`](../src/Terminal/rTerminal/runtime.ts)
6. [`src/Terminal/options.ts`](../src/Terminal/options.ts)
7. [`src/Runtime/VSCR/index.ts`](../src/Runtime/VSCR/index.ts)
8. [`src/Runtime/VSCR/legacy/integration.ts`](../src/Runtime/VSCR/legacy/integration.ts)
9. [`src/Runtime/VSCR/sess/integration.ts`](../src/Runtime/VSCR/sess/integration.ts)
10. [`resources/r/console-profile.R`](../resources/r/console-profile.R)
11. [`sidecar/pty-host/src/host.rs`](../sidecar/pty-host/src/host.rs)
12. [`sidecar/pty-host/src/protocol.rs`](../sidecar/pty-host/src/protocol.rs)
13. [`sidecar/pty-host/src/main.rs`](../sidecar/pty-host/src/main.rs)
14. [`src/Terminal/rTerminal/lang.ts`](../src/Terminal/rTerminal/lang.ts)
15. [`src/Language/completion.ts`](../src/Language/completion.ts)
16. [`src/Language/consoleLspClient.ts`](../src/Language/consoleLspClient.ts)
17. [`src/Language/virtualRDocument.ts`](../src/Language/virtualRDocument.ts)
18. [`resources/r/console-language-server.R`](../resources/r/console-language-server.R)

