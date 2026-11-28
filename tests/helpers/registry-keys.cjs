const { createCipheriv, createDecipheriv, createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Simulate the runtime's memory-owned key. Seed encrypted fixtures directly:
// no production implementation accepts plaintext migration requests.
function registryKeys() {
  const runtimes = new Map();
  function runtimeFor({ sessionId, pid }) {
    const id = `${sessionId}:${pid}`;
    let runtime = runtimes.get(id);
    if (!runtime) {
      runtime = { key: randomBytes(32) };
      runtimes.set(id, runtime);
    }
    if (runtime.unavailable) throw new Error("Runtime unavailable");
    return runtime;
  }
  const readKey = async identity => Buffer.from(runtimeFor(identity).key);
  const seed = (file, { sessions, ...metadata }) => {
    const format = "r-console-session-records";
    const scope = createHash("sha256").update(path.resolve(file)).digest("hex");
    const rows = sessions.map(record => {
      const { sessionId, pid } = record.terminal.runtime;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", runtimeFor({ sessionId, pid }).key, iv);
      cipher.setAAD(Buffer.from(`${format}:1:${scope}:${sessionId}:${pid}`));
      const plaintext = Buffer.from(JSON.stringify({ record, metadata }));
      let ciphertext;
      try { ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); }
      finally { plaintext.fill(0); }
      return { sessionId, pid, iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
    });
    fs.writeFileSync(file, JSON.stringify({ format, version: 1, sessions: rows }), { mode: 0o600 });
  };
  const read = file => {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.format !== "r-console-session-records") return value;
    const scope = createHash("sha256").update(path.resolve(file)).digest("hex");
    const sessions = value.sessions.map(row => {
      const id = `${row.sessionId}:${row.pid}`;
      const cipher = createDecipheriv("aes-256-gcm", runtimes.get(id).key, Buffer.from(row.iv, "base64"));
      cipher.setAAD(Buffer.from(`${value.format}:1:${scope}:${id}`));
      cipher.setAuthTag(Buffer.from(row.tag, "base64"));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(row.ciphertext, "base64")), cipher.final()]));
    });
    return { ...sessions[0]?.metadata, sessions: sessions.map(value => value.record) };
  };
  return { readKey, seed, read, runtimes };
}
module.exports = { registryKeys };
