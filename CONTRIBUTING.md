# Contributing

This document covers local development, build, packaging, and implementation notes for R Console contributors.

Implementation details are documented in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## Requirements

- VS Code 1.85.0 or later.
- Node.js 24.x for the extension build and packaging scripts.
- A local R installation. R Console resolves it in this order: [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) `r.rpath.*`, ambient `R_HOME`, then `PATH`.
- [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r). R Console declares `REditorSupport.r` in `extensionDependencies` and depends on [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) session bootstrap/configuration.
- The R package `languageserver` for completion, signature help, and semantic highlighting during local testing.
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

- [Implementation notes](docs/IMPLEMENTATION.md)
- [Manual test checklist](docs/MANUALTEST.Rmd)
