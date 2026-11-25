const { createDecipheriv, createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Emulate the runtime-owned keys and its one-time plaintext migration policy.
function registryKeys() {
  const runtimes = new Map();
  const readKey = async ({ sessionId, pid }, migration) => {
    const id = `${sessionId}:${pid}`;
    let runtime = runtimes.get(id);
    if (!runtime) {
      runtime = { key: randomBytes(32), encrypted: false, migration: undefined };
      runtimes.set(id, runtime);
    }
    if (runtime.unavailable) throw new Error("Runtime unavailable");
    if (migration !== undefined) {
      if (runtime.encrypted || (runtime.migration !== undefined && runtime.migration !== migration)) {
        throw Object.assign(new Error("Plaintext replacement rejected"), { code: "PLAINTEXT_REJECTED" });
      }
      runtime.migration = migration;
    } else runtime.encrypted = true;
    return Buffer.from(runtime.key);
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
  return { readKey, read, runtimes };
}
module.exports = { registryKeys };
