# Contributing

This document covers local development, build, packaging, and implementation notes for R Console contributors.

Implementation details are documented in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md), including the current vscode-R integration and R executable resolution.

## Requirements

- VS Code 1.101.0 or later.
- Node.js 24.x for the extension build and packaging scripts.
- A local R installation. R Console resolves `r.executablePath`, then deprecated `r.rpath.*`, then `PATH`, with the Windows registry as the final Windows fallback.
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

`compile` type-checks the extension and bundles the extension host and background history worker into `dist/extension.js` and `dist/historyWorker.js`.

The extension uses VS Code's bundled Node.js runtime. Its Node.js 22 bundle target
and type definitions align with the runtime in VS Code 1.101. Node.js 24 is used
separately for build and packaging tools and CI.

`stage:sidecar` copies the current platform's `R_CONSOLE_HOST` into `bundled/bin/`.

`dist/`, `bundled/`, and `sidecar/pty-host/target/` are generated build outputs and are intentionally not committed.

## Packaging

```bash
npm run package
```

This produces a target-specific VSIX for the current host platform, for example `vsc-r-console-<version>-win32-x64.vsix`.

`vscode:prepublish` prepares the production bundle and stages the current platform binary into `bundled/bin/`.

Each target-specific VSIX contains exactly one platform-matching `R_CONSOLE_HOST` binary in `bundled/bin/`.

## Implementation and Testing

Run the fast unit tests with `npm test`. They use Node's built-in test runner and
the existing esbuild dependency; VS Code and R are not required.

For the same checks as CI, with Node.js 24, Rust, and R on `PATH`:

```bash
npm ci
npm run audit:dependencies
npm run package:extension
npm test
npm run test:lsp
npm run test:extension-host
cargo test --locked --manifest-path sidecar/pty-host/Cargo.toml
npm run build:sidecar
npm run stage:sidecar
npm run test:runtime
npm run package:vsix
npm run test:package
```

The extension host tests run on VS Code 1.101.0 and current stable, install
declared extension dependencies, activate R Console, and check its core commands
and completion results through the real VS Code API.
The language server and extension host completion tests require R's
`languageserver`, `magrittr`, and `data.table` packages. The language server tests
exercise startup, authenticated connections, and completion during session updates
and server restarts, using the production R server with a simulated VS Code host.
Set `R_TEST_EXECUTABLE` to choose the R executable for these lifecycle tests;
the authentication and protocol tests also require `Rscript` on `PATH`.
The runtime smoke test starts an isolated R session using a temporary profile,
checks evaluation, nested input, interruption, persistence, and shutdown, then
cleans up. Set `R_TEST_EXECUTABLE` to choose the R executable used to locate R.
The package test inspects the generated VSIX for the current platform.

CI runs on every pull request and pushes to `main` and `dev` on Linux, Windows,
and macOS. Releases must pass the same workflow before packaging or publishing.
The runtime build workflow checks all six target platforms when relevant files change in pull requests or pushes to `main` and `dev`.
Native graphics, interactive VS Code UI behavior, and external package integrations
remain covered by the manual checklist.

### Temporary dependency audit exception

`npm run audit:dependencies` checks all dependencies and fails on findings at any
severity, except the reviewed development-only VSCE dependency chain for
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).
As of 2026-11-18, picomatch has no patched release. npm's suggested downgrade to
VSCE 3.9.2 would remove the `--oidc` support used for Marketplace publishing.

The advisory concerns denial of service from malicious repeated extglob patterns.
VSCE's file collector uses fixed `**` and `node_modules/**` patterns during
packaging. This dependency is not part of the extension's runtime dependency tree.
The exception is restricted to the reviewed package versions, installation paths,
and development-only lockfile entries, including findings inherited from this
single advisory. Other advisories, production dependencies, changed versions or
paths, and audit errors still fail CI. Each use of the exception emits a warning.

When an upstream fix is available, update the dependency lockfile and remove the
exception from `scripts/audit-dependencies.js` (or restore the direct
`npm audit --audit-level=low` check). Do not extend the exception to other findings.

- [Implementation notes](docs/IMPLEMENTATION.md)
- [Manual test checklist](docs/MANUALTEST.Rmd)
