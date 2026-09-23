# Contributing

This document covers local development, build, packaging, and implementation notes for R Console contributors.

Implementation details are documented in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## Requirements

- VS Code 1.85.0 or later.
- Node.js 24.x for the extension build and packaging scripts.
- A local R installation. R Console first reuses vscode-R's resolved help/background R path when available; otherwise it resolves `r.executablePath`, legacy `r.rpath.*`, `PATH`, then the Windows registry on Windows.
- [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r). R Console declares `REditorSupport.r` in `extensionDependencies` and depends on [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) session bootstrap/configuration.
- The R package `languageserver` for language-server completion during local testing.
- Rust/Cargo if you are building the sidecar binaries from source.

## Local Build

```bash
npm install
npm run compile
npm run build:sidecar
npm run stage:sidecar
```

`compile` type-checks the extension and bundles the extension host entrypoint into `dist/extension.js`.

`stage:sidecar` copies the current platform's `R_CONSOLE_HOST` into `bundled/bin/`.

`dist/`, `bundled/`, and `sidecar/pty-host/target/` are generated build outputs and are intentionally not committed.

## Packaging

```bash
npm run package
```

This produces a target-specific VSIX for the current host platform, for example `vsc-r-console-0.3.0-win32-x64.vsix`.

`vscode:prepublish` prepares the production bundle and stages the current platform binary into `bundled/bin/`.

Each target-specific VSIX contains exactly one platform-matching `R_CONSOLE_HOST` binary in `bundled/bin/`.

## Implementation and Testing

Run the fast unit tests with `npm test`. They use Node's built-in test runner and
the existing esbuild dependency; VS Code and R are not required.

For the same checks as CI, with Node.js 24, Rust, and R on `PATH`:

```bash
npm ci
npm run package:extension
npm test
cargo test --locked --manifest-path sidecar/pty-host/Cargo.toml
npm run build:sidecar
npm run stage:sidecar
npm run test:runtime
npm run package:vsix
npm run test:package
```

The runtime smoke test starts an isolated R session using a temporary profile,
checks evaluation, nested input, interruption, persistence, and shutdown, then
cleans up. Set `R_TEST_EXECUTABLE` to choose the R executable used to locate R.
The package test inspects the generated VSIX for the current platform.

CI runs on every pull request and pushes to `main` and `dev` on Linux, Windows,
and macOS. Releases must pass the same workflow before packaging or publishing.
The separate runtime build workflow retains checks for all six target platforms.
Native graphics, VS Code UI behavior, and external package integrations remain
covered by the manual checklist.

- [Implementation notes](docs/IMPLEMENTATION.md)
- [Manual test checklist](docs/MANUALTEST.Rmd)
