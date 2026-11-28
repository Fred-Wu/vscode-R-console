const fs = require("node:fs");
const loadSource = require("./load-source.cjs");
const [file, gate] = process.argv.slice(2);
const { PersistentSessionRegistry } = loadSource("src/Runtime/persistentSessionRegistry.ts", { fs: {
  ...fs,
  renameSync(from, to) {
    if (gate && to === file) {
      process.send({ type: "locked" });
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(gate)) Atomics.wait(wait, 0, 0, 10);
    }
    return fs.renameSync(from, to);
  },
} });
const registry = new PersistentSessionRegistry(file, async () => Buffer.alloc(32, 7));
let records;
process.on("message", async message => {
  try {
    if (message.type === "load") {
      records = await registry.load();
      process.send({ type: "loaded", count: records.length });
    } else if (message.type === "save") {
      const saved = await registry.save([...records, message.record]);
      process.send({ type: "saved", saved });
    }
  } catch (error) { process.send({ type: "error", error: String(error) }); }
});
process.on("disconnect", () => { registry.dispose(); process.exit(); });
