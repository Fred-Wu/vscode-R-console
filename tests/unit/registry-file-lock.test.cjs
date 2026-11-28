const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork, spawn } = require("node:child_process");
const { once } = require("node:events");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { session } = require("../helpers/persistent-session.cjs");
const { PersistentSessionRegistry } = loadSource("src/Runtime/persistentSessionRegistry.ts");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-registry-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const file = path.join(root, "sessions.json");
  const registry = new PersistentSessionRegistry(file, async () => Buffer.alloc(32, 7));
  t.after(() => registry.dispose());
  return { root, file, registry };
}
function waitMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`No ${type} message`)), 10000);
    const message = value => {
      if (value.type === "error") finish(new Error(value.error));
      else if (value.type === type) finish(undefined, value);
    };
    const exit = () => finish(new Error("Writer exited before replying"));
    function finish(error, value) {
      clearTimeout(timer); child.off("message", message); child.off("exit", exit);
      if (error) reject(error); else resolve(value);
    }
    child.on("message", message); child.once("exit", exit);
  });
}
function worker(t, file, gate = "") {
  const child = fork(path.resolve(__dirname, "../helpers/registry-writer.cjs"), [file, gate],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill(); await exited;
  });
  return child;
}

test("simultaneous registry writers cannot pass verification and overwrite each other", async t => {
  const { file, root, registry } = fixture(t);
  const base = session(), first = session(), second = session();
  await registry.load(); assert.equal(await registry.save([base]), true);
  const gate = path.join(root, "release");
  const a = worker(t, file, gate), b = worker(t, file);
  for (const child of [a, b]) {
    const loaded = waitMessage(child, "loaded"); child.send({ type: "load" }); await loaded;
  }
  const locked = waitMessage(a, "locked"), savedA = waitMessage(a, "saved");
  a.send({ type: "save", record: first }); await locked;
  const savedB = waitMessage(b, "saved"); b.send({ type: "save", record: second });
  const attempted = await savedB;
  fs.writeFileSync(gate, "");
  assert.equal((await savedA).saved, true);
  assert.equal(attempted.saved, false, "the competing writer must fail while the first owns the critical section");
  assert.deepEqual(await registry.load(), [base, first]);
  const reloaded = waitMessage(b, "loaded"); b.send({ type: "load" }); await reloaded;
  const retried = waitMessage(b, "saved"); b.send({ type: "save", record: second });
  assert.equal((await retried).saved, true);
  assert.deepEqual(await registry.load(), [base, first, second]);
});

for (const release of ["parent exit", "helper exit"]) {
  test(`registry lock recovers after abrupt ${release}`, async t => {
    const { file, root, registry } = fixture(t);
    const base = session(); await registry.load(); await registry.save([base]);
    let child;
    if (release === "parent exit") {
      child = worker(t, file, path.join(root, "unreleased"));
      const loaded = waitMessage(child, "loaded"); child.send({ type: "load" }); await loaded;
      const locked = waitMessage(child, "locked"); child.send({ type: "save", record: session() }); await locked;
    } else {
      const helper = path.resolve(__dirname, "../../bundled/bin", process.platform === "win32" ? "R_CONSOLE_HOST.exe" : "R_CONSOLE_HOST");
      child = spawn(helper, ["--lock-session-registry", file + ".lock"], { stdio: ["pipe", "pipe", "ignore"] });
      t.after(() => child.kill());
      await once(child.stdout, "data");
    }
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const deadline = Date.now() + 3000;
    while (!await registry.save([base])) {
      assert.ok(Date.now() < deadline, "the OS must release the abandoned lock");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(await registry.load(), [base]);
  });
}
