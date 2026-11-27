// A disposable extension-host process. Configuration and credentials arrive
// through Node's inherited IPC channel, never command-line arguments or files.
const loadSource = require("./load-source.cjs");
const { createConsoleLsp } = require("./console-lsp.cjs");
const { RustSidecarRuntimeBackend } = loadSource("src/Runtime/runtimeBackend.ts");

process.once("message", async ({ runtime, cwd, profile, sidecar }) => {
  const backend = new RustSidecarRuntimeBackend(sidecar);
  const session = backend.reconnect(runtime);
  const controls = [];
  const { client, complete, logs } = createConsoleLsp({ after() {} }, {
    cwd, args: [], env: { ...process.env, R_PROFILE_USER: profile },
  });
  const metadata = new Promise((resolve, reject) => {
    backend.attach(session, { onError: reject, onControl: event => {
      controls.push(event.type);
      if (event.type === "library-paths") { client.updateRuntimeLibraryPaths(event.paths); resolve(); }
    } });
  });
  const stop = async () => {
    await client.dispose();
    backend.detach(session);
  };
  try {
    await metadata;
    await client.start();
    const items = await complete("stats::");
    process.send({
      ready: true, lspPid: client.spawnedServer.pid, workspace: client.workingDirectory,
      runtimePid: backend.getPid(session), count: items.length,
      captured: Object.hasOwn(client, "startupState"),
      libraries: await client.client.sendRequest("rConsole/libraryPaths", {}),
      leaked: controls.some(type => type.startsWith("lsp-startup-")) || logs.some(line => line.includes("synthetic-persistent-profile-secret")),
    });
    process.once("message", async () => { await stop(); process.exit(0); });
  } catch (error) {
    await stop();
    process.send({ error: error.message });
    process.exitCode = 1;
    process.disconnect();
  }
});
