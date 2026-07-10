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
| [`vscode-R`](https://github.com/REditorSupport/vscode-R) | Used directly for R executable settings, `R/session/init.R`, watcher files, attach/session metadata, and optional session-server member completion. | `src/Terminal/options.ts`, `resources/r/console-profile.R`, `src/Runtime/sessionWatcher.ts` |
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
- [`resources/r/console-profile.R`](../resources/r/console-profile.R)
- [`src/Runtime/sessionWatcher.ts`](../src/Runtime/sessionWatcher.ts)

### 3.1 Startup Settings From `vscode-R`

R executable selection reads the `vscode-R` settings:

- `r.rpath.windows`
- `r.rpath.mac`
- `r.rpath.linux`

If those are unset, the console falls back to ambient `R_HOME`, then `R` on
`PATH`.

The selected executable is used to derive:

- `R_HOME`
- `R_SHARE_DIR`
- `R_INCLUDE_DIR`
- `R_DOC_DIR`
- platform loader paths

The same selected R executable is used for:

- the embedded backend
- the console-owned `languageserver` process

### 3.2 Startup Bootstrap From `vscode-R`

The console requires:

- `REditorSupport.r/R/session/init.R`

`options.ts` resolves the installed `REditorSupport.r` extension path through
the VS Code extension API. Startup is rejected if `init.R` is missing.

The backend launch environment includes:

- `VSCODE_INIT_R`
- `VSCODE_WATCHER_DIR`
- `R_PROFILE_USER_OLD`
- `VSC_R_EXECUTABLE`

At launch time, `rTerminal/runtime.ts` also sets:

- `R_PROFILE_USER` to this extension's `console-profile.R`
- `VSC_R_COLS`
- `VSC_R_ROWS`
- `VSC_R_SESSION_CWD`
- `VSC_R_EXT`

`console-profile.R` then:

1. restores and sources the user's original profile through
   `R_PROFILE_USER_OLD`
2. sources `VSCODE_INIT_R`
3. for R 4.6 compatibility, bridges vscode-R's legacy global `.First.sys`
   deferred attach hook through `.First` when `VSCODE_INIT_R` installs it,
   preserving user `.First()` startup logic before vscode-R attach
4. installs the console pager
5. locks the prompt options used by the embedded console contract

### 3.3 Session Watcher Metadata

`SessionWatcher` reads files produced by `vscode-R` under
`VSCODE_WATCHER_DIR`.

It watches:

- root `request.lock`
- root `request.log`
- session `workspace.lock`
- session `workspace.json`
- the attached session directory until workspace state appears

From `request.log`, it reads:

- attach/detach commands
- R session tempdir
- R session pid
- optional session server host/port/token

From `workspace.json`, it reads:

- search path
- loaded namespaces
- global environment summary

The watcher can auto-pin to the first fresh attach event when the backend pid is
not known yet. Once pinned, it ignores attach events from other R sessions.

### 3.4 Metadata Consumers

The console consumes watcher metadata for:

- display pid selection
- search-path aware completion
- global-environment completion
- `$` and `@` member completion through the `vscode-R` session server when
  available
- attached package and namespace sync into the console-owned language server

This integration is read-only with respect to `vscode-R` sessions. The console
does not create, replace, restore, or stop `vscode-R` sessions.

### 3.5 Completion And Language Server

Implementation files:

- [`src/Terminal/rTerminal/lang.ts`](../src/Terminal/rTerminal/lang.ts)
- [`src/Language/completion.ts`](../src/Language/completion.ts)
- [`src/Language/consoleLspClient.ts`](../src/Language/consoleLspClient.ts)
- [`src/Language/virtualRDocument.ts`](../src/Language/virtualRDocument.ts)
- [`resources/r/console-language-server.R`](../resources/r/console-language-server.R)

`RTermLang` owns the console completion flow. It detects the completion
context, builds fast runtime suggestions from cached session data and the
current input, then merges the full completion result when language-server and
fresh session data are available.

Completion data comes from one shared flow:

- runtime/global-environment symbols come from `SessionWatcher` workspace data
- `$` and `@` member completion uses the session-server completion endpoint
  when available
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
completion path.

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

## 5. Files To Read First

1. [`src/extension.ts`](../src/extension.ts)
2. [`src/Runtime/runtimeBackend.ts`](../src/Runtime/runtimeBackend.ts)
3. [`src/Runtime/backendProtocol.ts`](../src/Runtime/backendProtocol.ts)
4. [`src/Terminal/rTerminal.ts`](../src/Terminal/rTerminal.ts)
5. [`src/Terminal/rTerminal/runtime.ts`](../src/Terminal/rTerminal/runtime.ts)
6. [`src/Terminal/options.ts`](../src/Terminal/options.ts)
7. [`src/Runtime/sessionWatcher.ts`](../src/Runtime/sessionWatcher.ts)
8. [`resources/r/console-profile.R`](../resources/r/console-profile.R)
9. [`sidecar/pty-host/src/host.rs`](../sidecar/pty-host/src/host.rs)
10. [`sidecar/pty-host/src/protocol.rs`](../sidecar/pty-host/src/protocol.rs)
11. [`sidecar/pty-host/src/main.rs`](../sidecar/pty-host/src/main.rs)
12. [`src/Terminal/rTerminal/lang.ts`](../src/Terminal/rTerminal/lang.ts)
13. [`src/Language/completion.ts`](../src/Language/completion.ts)
14. [`src/Language/consoleLspClient.ts`](../src/Language/consoleLspClient.ts)
15. [`src/Language/virtualRDocument.ts`](../src/Language/virtualRDocument.ts)
16. [`resources/r/console-language-server.R`](../resources/r/console-language-server.R)
