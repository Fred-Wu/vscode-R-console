# Design and Implementation

`vscode-R-console` runs an embedded R session through a Rust backend and presents
it in a VS Code pseudoterminal. The extension manages console input, output,
completion, command history, and persistent sessions.

The architecture has four main parts:

1. the embedded R backend
2. the transport model between the backend and the VS Code UI
3. the `vscode-R` integration layer
4. the self-managed console session layer

## Implementation References

The following projects inform the extension's design. The table identifies
runtime dependencies and the local components associated with each reference.

| Project | What is referenced or used | Where it appears here |
| --- | --- | --- |
| [`vscode-R`](https://github.com/REditorSupport/vscode-R) | Used for R executable settings, the vscode-R 3.x `sess` JSON-RPC 2.0 protocol, and deprecated pre-3.0 session-watcher compatibility. | `src/Terminal/options.ts`, `src/Runtime/VSCR/`, `resources/r/VSCR/` |
| [`arf`](https://github.com/eitsupi/arf) | Reference for Rust embedded-R host structure, dynamic R loading, platform-specific R initialization, callback wiring, generic event/input-handler pumping, and interrupt state handling. | `sidecar/pty-host/src/host.rs` |
| [Ark](https://github.com/posit-dev/ark) | Reference for native R frontend concepts, `ReadConsole` recovery after interrupts/nested input, nested-input separation, and generic R event/finalizer pumping while waiting for input. | `sidecar/pty-host/src/host.rs` |
| [`rchitect`](https://github.com/randy3k/rchitect) | Reference for embedding R from a non-R host process, R home/shared-library discovery, and callback/FFI boundary patterns. | `sidecar/pty-host/src/host.rs`, `src/Terminal/options.ts` |
| [`radian`](https://github.com/randy3k/radian) | Reference for terminal-first console interaction, prompt-centric editing, multiline editing, history, reverse search, and bracketed paste expectations. | `src/Terminal/rTerminal.ts` and supporting terminal modules |
| [`languageserver`](https://github.com/REditorSupport/languageserver) | R package dependency for console completion. | `src/Language/consoleLspClient.ts`, `resources/r/console-language-server.R` |

The embedded backend, protocol, and terminal frontend are implemented in this
repository, drawing on the host and terminal interaction patterns above.

## 1. Embedded Backend

The embedded backend is the Rust sidecar binary:

- Unix: `bundled/bin/R_CONSOLE_HOST`
- Windows: `bundled/bin/R_CONSOLE_HOST.exe`

Source files:

- [`sidecar/pty-host/src/main.rs`](../sidecar/pty-host/src/main.rs)
- [`sidecar/pty-host/src/host.rs`](../sidecar/pty-host/src/host.rs)
- [`sidecar/pty-host/src/protocol.rs`](../sidecar/pty-host/src/protocol.rs)

`R_CONSOLE_HOST` loads the R runtime into its own process and connects R's
callbacks to the extension's input and output protocol.

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

These settings route embedded R console IO through the registered callbacks.

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

The preload order resolves R and its support DLLs from the selected installation.

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

Windows initialization configures the runtime through `Rstart`:

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

The backend pumps R's event handlers and the platform event queue while waiting
for input. R packages participate through the handlers registered with R.

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
step is implemented in the shared backend state.

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
5. generates a session secret and passes it through `VSC_R_BACKEND_AUTH_TOKEN`
6. passes initial connect and reconnect grace values
7. detaches/unrefs the process from the VS Code extension host

The Rust host reads `VSC_R_BACKEND_SESSION_FILE`, binds a TCP listener on
`127.0.0.1:0`, then writes JSON to the bootstrap file:

```json
{"port":12345,"pid":67890,"protocolVersion":2}
```

The TypeScript side polls that file, requires protocol version 2, reads the port and pid, then connects to
the loopback server. Before exchanging session traffic, both peers prove
possession of the session secret using HMAC-SHA256 and fresh nonces. The
authentication implementation is in
[`src/Runtime/backendAuthentication.ts`](../src/Runtime/backendAuthentication.ts).

The authenticated backend uses protocol version 2; v0.5.4 used version 1 without
authentication. The extension also checks the live `backend-ready` version.
This version is independent of vscode-R's `sess` integration protocol.

### 2.2 Reconnect Transport

Reconnect uses `RuntimeSessionReconnectInfo`:

- `sessionId`
- `port`
- `authToken`
- `pid`

`RustSidecarRuntimeBackend.reconnect(...)` creates a new
`RuntimeSessionHandle` around that information and authenticates a connection
to the existing backend's loopback TCP server.

The runtime checks process liveness before reconnecting:

- if the recorded backend pid is dead, the reconnect info is discarded
- if the Windows launcher process has exited but the detached real host pid is
  alive, reconnect continues

### 2.3 Active Client Model

The Rust backend accepts one active control client at a time.

Implementation details:

- each active connection has a client id
- `current_client` stores the currently active id
- a successfully authenticated connection replaces the previous active socket
- command-reader threads exit when their client id is no longer current
- output is attached to the active client writer
- when the active client disconnects, output is detached and the reconnect
  grace timer is applied

This connection model supports detaching a console tab and attaching another UI
instance to the same embedded R backend.

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
Console output is streamed in 8 KiB chunks, including output received directly
from R callbacks. The frontend accepts frames up to 16 MiB. Each output stream
has its own UTF-8 decoder in the frontend, so characters split between frames
are preserved.
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

### 2.7 Transport Bounds And Deadlines

Transport limits bound message sizes, connection admission, and request waits.
Authentication deadlines apply during the handshake; the native parse deadline
begins after a request is sent to a ready R session.

| Boundary | Bound or timing | Purpose and behavior |
| --- | --- | --- |
| Backend and console language-server authentication | 3 seconds; fixed-size challenge/proof messages; bounded pending clients | Bounds incomplete authentication. Backend read/write deadlines are cleared after authentication. |
| Backend frames | 16 MiB per payload | Rejects excessive allocation before reading a payload. Oversized submitted commands are rejected before sending; output is streamed across frames. |
| Detached backend output | 1,000,000 bytes or 4,096 frames | Retains a rolling backlog until a frontend connects. |
| Session proxy admission | 8 pending clients; 3 seconds to send attach | Bounds incomplete attachments. Active sessions are replaced only after an attach message, independently of these resource guards. |
| Session proxy messages | 16 MiB per JSON line | Bounds a complete message. Forwarding follows writable stream backpressure. |
| Optional session data requests | 1.2 seconds waiting for an R socket; 2 seconds for a response | Resolves unavailable workspace/completion data when the request expires. |
| Legacy HTTP session data | 1.2 seconds of inactivity; 16 MiB response | Progressing responses may take longer. Response abort/error/close events settle the request directly. |
| Native parse query | 150 milliseconds after sending | Falls back to the local parser; submission readiness is checked before sending. |
| Backend startup and reconnect | 5 seconds for the bootstrap file; 60-second initial connection grace; unlimited persistent reconnect grace | The 40/100 ms poll/retry intervals schedule connection checks. Detached shutdown uses a 2-second socket inactivity timeout. |
| Manual session recovery | 1.5 seconds after R returns to its main prompt | Waits for attachment confirmation after the recovery command finishes. |

Terminal rendering and completion use debounces to schedule UI work. Native
event polling drives R callbacks. Persistence heartbeats, history refreshes,
lock retries, and close waits coordinate storage and shutdown.

## 3. `vscode-R` Integration

R Console uses vscode-R's public session APIs to attach its embedded R session,
obtain workspace metadata, and request runtime completions. vscode-R manages
the shared session services, including plots, data viewers, help, and addins.

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

The deprecated pre-3.0 integration is contained in the legacy directories, its
configuration variant, and the factory selection branch. Terminal, language,
and persistence components access session services through the shared interface.

### 3.1 Startup Settings From `vscode-R`

R Console resolves the R executable in this order:

1. `r.executablePath`
2. deprecated `r.rpath.windows`, `r.rpath.mac`, or `r.rpath.linux`
3. `R` on `PATH`
4. the Windows R registry entry on Windows

R Console derives `R_HOME` from the selected executable, anchoring the embedded
runtime to that R installation.

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
policy. R Console selects the integration through vscode-R's public session API.
The transport is a Unix socket on macOS/Linux or a Windows named pipe. Messages
are JSON-RPC 2.0 objects framed as newline-delimited JSON.

The `SessProxy` is a transparent IPC proxy. The embedded R session connects to
the console-owned proxy endpoint, and the proxy connects to vscode-R's endpoint.
Raw newline-delimited JSON-RPC messages are forwarded in both directions. R
Console observes workspace responses and injects its own `workspace` and
`completion` requests when the console needs session data. It uses vscode-R's
public API for connection discovery, attachment preparation, terminal
registration, connection references, and session activation.

Before replacing an active R connection, the proxy waits for a newline-delimited
`attach` message with a nonempty session id. Upstream connections and session
requests begin after that message arrives. The proxy admits at most eight
pending connections, each with a three-second deadline and a 16 MiB line limit.
vscode-R validates the forwarded attachment handshake.

On Windows, the bundled host's `--secure-session-pipe` command applies a protected
DACL that grants access only to the current user and denies network logons. All
instances of the named pipe share that descriptor. The proxy publishes its
endpoint only after permission setup succeeds; setup failure closes the server.
Connections accepted during setup are closed before the endpoint is returned.
On Unix the socket resides in a private directory with owner-only permissions.

Forwarding follows Node's [stream backpressure contract](https://nodejs.org/api/stream.html#event-drain):
after a write returns false, the proxy pauses the source and retains the
unprocessed remainder of the current batch. On drain, it forwards that remainder
before resuming reads. Optional local workspace/completion requests resolve as
unavailable while the destination is blocked. Each JSON line is limited to
16 MiB, and stream drain events govern forwarding to slow receivers.

The proxy is scoped to the embedded backend runtime session and is indexed by
the backend session id while connected. The managed bootstrap connects `sess`
through the proxy endpoint and forwards the versioned attach handshake to
vscode-R. R Console validates attachment and connection references before
binding the corresponding pseudoterminal. Background consoles are registered
with their session references; terminal focus selects the matching session
through vscode-R's public `session.activate()` API.

The console passes its proxy endpoint to `prepareAttachment()`. The
`SESS_PLOT_BACKEND` and `SESS_RSTUDIOAPI` environment variables expose vscode-R's
resolved plot-backend preference and `r.session.emulateRStudioAPI` setting,
respectively; vscode-R's managed bootstrap configures the corresponding sess options.
Reconnection refreshes both variables from the current configuration before
sourcing the newly prepared managed bootstrap.
Inherited `SESS_DISCOVERY_FILE` values are cleared during environment preparation.
After a window reload, the console obtains a new endpoint and reconnects when
the restored console reaches an empty main prompt.
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

vscode-R prepares the `sess` bootstrap. The legacy implementation sources
`resources/r/VSCR/legacy.R`, which runs vscode-R's legacy `init.R`.

### 3.3 Session Metadata

In `legacy` mode, `SessionWatcher` reads the file-based `request.log`,
`workspace.lock`, and `workspace.json` files.
Its loopback HTTP requests use a 1.2-second inactivity timeout and a 16 MiB
response limit. Responses can take longer while data continues to arrive.
Truncated, aborted, failed, or oversized responses close the request and resolve
as unavailable data.

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

The `completion` response provides runtime `$` and `@` members for an expression.
Console data-frame bracket completion obtains column names through a completion
request for the data object expression. The proxy also queries `.libPaths()`
through a completion expression and includes the resulting package folders in
the cached workspace data.

In `sess` mode, a restored console obtains the current endpoint through vscode-R's
public session API and reconnects at an empty main prompt. A console detached
within the same window reuses its existing proxy connection.

### 3.4 Metadata Consumers

In `legacy` mode, the console consumes watcher metadata for:

- display pid selection
- search-path aware completion
- global-environment completion
- `$` and `@` member completion through the `vscode-R` session server when
  available
- attached-package synchronization with the console-owned language server

In `sess` mode, R Console caches metadata passing through its proxy and routes
completion requests to its embedded session. Runtime `$`, `@`, and data-frame
bracket completion are requested from the current embedded R session through
the `sess` JSON-RPC `completion` method.
Workspace snapshots are cached from forwarded or console-injected `workspace`
responses and are used for search-path/package synchronization and top-level
workspace completions.

vscode-R manages plot, data, help, browser, httpgd, and addin session lifecycles.

### 3.5 Completion And Language Server

Implementation files:

- [`src/Terminal/rTerminal/lang.ts`](../src/Terminal/rTerminal/lang.ts)
- [`src/Language/completion.ts`](../src/Language/completion.ts)
- [`src/Language/consoleLspClient.ts`](../src/Language/consoleLspClient.ts)
- [`src/Language/virtualRDocument.ts`](../src/Language/virtualRDocument.ts)
- [`resources/r/console-language-server.R`](../resources/r/console-language-server.R)

#### Completion Frontends

Inline completion is the terminal completion frontend selected with
`r.console.completionUI = "inline"`; the default `quickPick` mode uses the
VS Code picker. F7 is inactive in inline mode. `RTermLang` supplies both
frontends with the same completion sources, query ranking, groups and insertion
rules. In function-call contexts, the list is published after the LSP parameter
results arrive. Parameter entries take selection priority over runtime symbols;
an explicit selection is retained on refresh.

The `r.console.inlineCompletion.trigger` setting chooses automatic
debounced suggestions or Tab activation. In Tab mode, editing refreshes an open
list without opening a closed one. Tab or Enter accepts the selected suggestion,
or requests fresh suggestions without submitting input if the visible results are stale.
Escape dismisses it, and clearing the input dismisses the list and invalidates
outstanding requests. Backspace resets the suggestion selection and viewport.

Accepting a suggestion for a partial function name replaces the partial name
and places the cursor inside the inserted empty parentheses. In inline
completion's typing mode, this schedules argument suggestions using the same
debounce as input edits.

The terminal renderer draws a bordered transient suggestion panel below the
physical terminal row containing the input caret. Within a wrapped logical
line, the remaining input is rendered below the panel. The renderer anchors
the panel horizontally to the preceding display cell, clamps it to terminal
width and fits the panel in the available viewport, reducing its height before
windowing the input. Terminal Unicode display-cell widths determine
suggestion alignment, input row counts and cursor positioning. Cursor
positions exactly at the terminal's right edge remain in its final cell
until xterm wraps on the next printable character. Suggestion rows are
excluded from saved replay and restored terminal history.

Each row can display the completion icon, label, match highlighting,
description and detail. Group labels share the terminal background with
unselected suggestions. The active row has a continuous selection background.
Colors use the `workbench.colorCustomizations`
`editorSuggestWidget.highlightForeground` and
`editorSuggestWidget.selectedBackground` settings when defined, otherwise
light/dark terminal-compatible defaults. Module icons use `{}`; other symbols
use colored terminal glyphs. The pseudoterminal inherits the configured terminal
font and reads explicit color customizations through the configuration API.

The completion controller manages a bounded, scrollable viewport with an
in-box scrollbar. Up/Down and Page Up/Down navigate completion choices, moving
the viewport when the selected item reaches a visible edge. Temporary SGR mouse
reporting permits wheel navigation within the panel. Clicks on suggestions or
their detail rows accept a completion, and scrollbar clicks move the viewport.
Wheel reports outside the box invoke VS Code terminal page-scrolling commands.
Wheel events over either the suggestion content or its scrollbar navigate
the completion list.
Cursor-position reports establish the panel's screen coordinates for mouse
hit-testing. Mouse reporting is disabled when the panel closes.

#### Completion Sources

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

#### Language Server Lifecycle

`ConsoleLspClient` owns a `languageserver` child process for each console UI.
The child inherits the console runtime's normalized R environment and runs
`resources/r/console-language-server.R` in a temporary working directory.
Opening the console starts the client and issues a silent completion request
to initialize completion caches. Known session state supplies the initial
library paths before launch. Runtime start and attach events reuse the client.

Windows uses an authenticated loopback TCP connection. On Unix,
`r.lsp.use_stdio` selects stdio or TCP. For TCP, the R server initializes its
workspaces before connecting. The peers exchange HMAC-SHA256 proofs using a
process-specific secret and fresh nonces. The socket reader begins LSP traffic
after authentication and reader registration.

The client sends open/change/close notifications for in-memory `r-console://`
documents before requesting completion. `VirtualRDocument` projects console
input into the server document and maps completion positions and ranges back
to the console. Diagnostics are disabled for these completion documents.

`rConsole/syncSessionState` synchronizes attached packages and library paths.
The client deduplicates unchanged snapshots and shares an in-flight sync request
among concurrent callers. The R server resolves the requested session paths,
configured fallback paths, and default libraries with `.libPaths()`. It compares
their effective search order with the running server's paths, then restores
those paths before replying. A changed search order requests a process restart
so namespaces load from the selected libraries.

`rConsole/checkPackageChanges` compares fingerprints for cached and explicitly
referenced packages. Fingerprints include package paths, file sizes, and
modification timestamps. The client throttles these checks to one per second;
changed packages request a restart to refresh loaded namespaces and cached data.

Package and library changes share one restart promise. Startup and completion
callers await the replacement process, and session synchronization applies the
latest snapshot. A completion interrupted by replacement reopens its document
and retries once on the replacement client. Disposal stops the child process
before removing its working directory. The `R Console Language Server` output
channel records process starts, stops, and errors.

#### Keybinding Dispatch

In Quick Pick mode, the contributed `F7` keybinding invokes the active console's
forced-completion handler. `KeyProcessor` maps the xterm `ESC [ 18 ~` sequence
to the same handler when `terminal.integrated.sendKeybindingsToShell` forwards
F7 to the pseudoterminal. Tab performs indentation or contextual completion
according to the input position. Forced completion opens Quick Pick with cached
entries and fills it asynchronously as workspace and language-server results
arrive.

#### Syntax Highlighting

`src/Terminal/consoleSyntax.ts` tokenizes console input locally.
`src/Terminal/syntaxTheme.ts` maps the token types to the active VS Code theme's
semantic-token colors.

## 4. Self-managed Console

Self-managed console implementation is split between:

- [`src/extension.ts`](../src/extension.ts)
- [`src/Terminal/rTerminal.ts`](../src/Terminal/rTerminal.ts)
- [`src/Runtime/runtimeBackend.ts`](../src/Runtime/runtimeBackend.ts)

R Console manages the embedded backend's lifetime, frontend attachment, replay
state, and persistent session records.

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

- runtime reconnect info: protocol version, session id, port, authentication token, pid
- persisted terminal options: R path, R args, watcher settings, bracketed paste,
  cwd
- UI replay state: replay buffer, dimensions, mode, prompt state, input text,
  cursor position, backend pid
- terminal location: panel or editor column

The session manager uses these records to reconnect the backend and reconstruct
its console UI.

### 4.3 Registry Loading And Pruning

On activation, `extension.ts` loads `persistent-sessions.json` through
`Runtime/persistentSessionRegistry.ts`.

Records are validated individually before reconnecting. A record can reconnect only when:

- its runtime reconnect info is structurally valid and uses the current protocol version
- its terminal options are structurally valid
- its UI replay state is structurally valid
- its recorded backend pid is either absent or still alive

Dead authenticated records are pruned when the registry is saved. Incompatible
records are retained alongside valid records; one invalid entry does not discard
the whole registry. Unreadable or malformed registry files are not overwritten.

Records are recognized as older sessions when their protocol version is lower
than the current version and their structure and credentials are valid. Records
without both a version and an `authToken` use the v0.5.4 format and are treated as
protocol 1. This fallback applies only to those historical records. Activation shows a notice once per detected old
session, tracked in workspace state. The notice explains that the protocol has
changed and old sessions must be closed and restarted. It offers only **Close Old
Session** and **Cancel**. Clicking Close confirms shutdown, with a picker by PID
and startup directory only when multiple old sessions exist. The picker supports
multiple selection with all old sessions preselected, including previously
dismissed ones. Confirming closes the selected sessions; cancelling or clearing
every selection closes none. A failure retains that session's record and does
not prevent closing the other selected sessions. There is no details
page or second confirmation. Cancel leaves the sessions untouched. The session
manager also provides this close action. It does not depend on editor focus and
does not create a new console.

`Runtime/legacySession.ts` implements this explicit cleanup path. It matches the
saved PID and port to the session bootstrap file and checks the running backend:
Windows checks its process name and start time against bootstrap creation;
Linux/macOS check its executable and session bootstrap environment. These checks
run after the user clicks Close. The connection must then report the old
backend protocol and matching PID before receiving its sole command, `shutdown`.
Protocol 2 and later authenticate with the saved token before checking the greeting
and sending shutdown. Protocol 1 alone uses unauthenticated shutdown. Later
protocol changes must retain the authentication, greeting, session PID, and shutdown
messages used by this cleanup path, or retain a compatible reader for older sessions.
No PID-based kill fallback is used. The record is removed only after the process exits; failed verification
or shutdown retains it. Ordinary reconnection still requires authentication.

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

#### Submission Queue

Enter, accepted multiline paste, and programmatic sends reserve their submission
positions synchronously. Completeness checks run in reservation order, while
completed expressions can enter execution immediately. An incomplete tail passes
to the next reservation before that reservation is checked, including when the
tail is waiting behind an executing expression. With no accepted successor, the
tail becomes editable; normal input handling includes that buffer in the next
Enter or paste snapshot. Ownership transfers between the queue and input editor
at that boundary.
Enter retains literal whitespace and applies its continuation newline at the
saved cursor only when input is incomplete. Each complete expression is recorded
in history as it is accepted, so interrupting later parsing preserves earlier
entries.

#### Readiness and Cancellation

Completeness checks combine a local TypeScript heuristic with the console's
native R parser when available. Native requests wait for a confirmed top-level
ready state; their 150 ms timeout starts after sending. A per-console notification
wakes waiting checks on readiness or cancellation. Each submission receives its
console's parser explicitly, and runtime callbacks carry the owning session
generation. Dispatch requires readiness, including after attachment to a busy R
session. Cancellation invalidates queued reservations by generation and releases
the queue for fresh input. Failed delivery restores pending source at its saved
continuation boundaries, including literal newlines and cursor positions.

### 4.5 Attaching A Detached Console

Attaching a detached console follows this implementation path:

1. the session manager reads the persisted record
2. `buildPersistentTerminalOptions(...)` combines current resolved options with
   persisted options
3. `new RTerminal(options, extensionPath, persistedState)` rebuilds the frontend
4. the persisted runtime reconnect info is passed to `runtimeBackend.reconnect`
5. TypeScript connects to the existing backend socket
6. the terminal replay state is used to rebuild the visible terminal

The frontend resumes the running embedded R session through that connection.

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

The close command sends a `shutdown` frame to the R Console backend socket.

### 4.7 Persistence Updates

The extension persists console records:

- after console creation
- after attach/detach state changes
- after terminal title/pid updates
- on a debounce timer
- on a heartbeat timer
- during extension shutdown

`RTerminal.exportPersistentState()` supplies the runtime and UI state. Persistence
requires valid reconnect information from the runtime backend.

### 4.8 Command History

`src/Terminal/history.ts` provides in-memory command history for console input,
search, and navigation. One shared background worker owns file access,
workspace-path resolution, parsing, and compaction through `historyStore.ts`.
Foreground updates are immediate; storage requests and acknowledgements run
asynchronously.

#### Storage and Scope

Each console selects a history scope at creation or reattachment through
`r.console.historyScope`. The default `workspace` scope shares commands between
consoles whose initial working directory belongs to the same workspace folder.
The `global` scope and consoles outside a workspace use a shared global history.
Files are stored under `context.globalStorageUri/history/` as `global.history`
or `workspace-<SHA256>.history`.

History records contain multiline command text, a timestamp, a stable command
ID, and a completion marker. Files hold up to 20,000 commands; compaction retains
the newest 19,000 before subsequent appends. The `# r-console-history-base:`
marker tracks removed entries so consoles can maintain stable navigation
positions across compaction and duplicate commands.

New history directories and files request Unix permissions `0700` and `0600`.
Windows uses inherited filesystem permissions.

#### Writes and Recovery

Readers and writers coordinate through a per-file lock. Normal appends reconcile
bytes added since the last disk offset; file replacement or compaction triggers
a full reload. The foreground keeps pending local commands until the worker
acknowledges their saved IDs. Stable IDs make retries idempotent while preserving
distinct occurrences of identical commands.

Lock contention and write failures leave submissions queued for retry. A failed
append rolls back its partial bytes when safe. Recovery from an incomplete
tagged record uses an atomic rewrite under the file lock, retaining completed
records from every console. Failed appends restore the disk cursor and count;
when compaction has completed, recovery retains the compacted snapshot together
with pending commands. The foreground restores its history and navigation cursor
after a failed write so unsaved input stays available.

A replacement worker replays unacknowledged records and uses worker-instance
tokens to reclaim locks owned by its terminated predecessor. Invalid or empty
lock owners are reclaimed after the stale-lock timeout.

Console disposal queues remaining writes and releases the UI. The worker drains
those writes after the console closes, and extension shutdown provides a bounded
drain interval before stopping the worker. Durable storage requires successful
acknowledgement before VS Code exits.

#### Navigation and Search

The foreground holds a sliding window of at most 400 history rows and fetches
adjacent 200-row batches on demand. The worker supplies location hints when a
boundary occurrence has been deleted in another window. Selecting an older
entry loads the surrounding records before restoring its navigation cursor.

Up/Down and Ctrl+P/Ctrl+N skip consecutive identical entries during navigation.
Ctrl+R searches backward for the current line's trimmed text anywhere in a saved
command; repeated presses use the original term to find earlier matches.

F8 (`r-console.searchHistory`) uses a VS Code Quick Pick with native checkboxes
and Select All. The worker searches the retained history and returns the newest
50 matches initially. Approaching the last active row requests another page;
the Load More toolbar action also supports explicit paging. Pages use stable
occurrence IDs and recover their position after cursor deletion. Exact-duplicate
collapse follows a preference stored in global state.

The picker defers visible foreground cache updates while processing worker
snapshots and persistence acknowledgements immediately. Its navigation positions
remain stable while additional submissions reach storage. Closing the picker
reconciles the visible cache.

An empty history displays a hint in the search box. A populated picker shows
the loaded entry count in its title. Changing the search clears checked
selections. Enter and OK use the same acceptance event to restore checked
commands in chronological order as editable input. A single selected occurrence
restores its history position. Multiple selections form a combined draft;
Up starts at the newest saved command and Down past that command restores the
draft. Editing the combined input expands collapsed history navigation.

#### Deletion

The picker trash action deletes checked occurrences from the loaded results.
Delete All Command History clears the active history scope. After deletion,
the picker refreshes its loaded range with the current query.

Deletions rewrite the file under its lock. Durable deletion metadata stores
occurrence IDs or command hashes together with a submission-time boundary.
Queued submissions are checked against those rules, allowing delayed writes
from other windows to respect deletions while accepting later commands.
Deletion rules remain until a newer rule subsumes them, since another window
may replay a delayed submission with its original timestamp.

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

