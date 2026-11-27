const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { createHmac, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { sessionRegistryKeyEndpoint } = loadSource("src/Runtime/sessionRegistryKey.ts");
const { loadPrivateStartupState, savePrivateStartupState, MAX_PRIVATE_STARTUP_STATE_BYTES } =
  loadSource("src/Runtime/privateStartupState.ts");
const token = "a".repeat(64);

function mac(label, nonce, header, clientNonce, payload = Buffer.alloc(0), key = token) {
  return createHmac("sha256", key).update(label, "ascii")
    .update(nonce).update(header).update(clientNonce).update(payload).digest();
}

async function broker(t, { serverKey = token, invalidPid = false, forgeReply = false, challengeTransform = value => value, closeAfterChallenge = false } = {}) {
  const identity = { sessionId: randomUUID(), pid: process.pid };
  const endpoint = sessionRegistryKeyEndpoint(identity);
  fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  let stored, disclosed = 0, accepted = 0, failed = 0, receivedAfterHello = 0;
  const clientNonces = [], closed = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    closed.push(new Promise(resolve => socket.once("close", resolve)));
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    const nonce = randomBytes(32);
    let stage = "header", buffer = Buffer.alloc(0), request, clientNonce, stateLength;
    socket.on("data", chunk => {
      if (stage !== "header") receivedAfterHello += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "header") {
        if (buffer.length < 69) return;
        request = Buffer.from(buffer.subarray(0, 37));
        clientNonce = Buffer.from(buffer.subarray(37, 69));
        clientNonces.push(clientNonce);
        buffer = Buffer.from(buffer.subarray(69));
        receivedAfterHello += buffer.length;
        stateLength = request.subarray(0, 4).toString("ascii") === "RCP2" ? request.readUInt32LE(4) : 0;
        stage = "proof";
        let challenge = Buffer.alloc(40);
        challenge.write("RCSC");
        challenge.writeUInt32LE(identity.pid + (invalidPid ? 1 : 0), 4);
        nonce.copy(challenge, 8);
        challenge = challengeTransform(Buffer.concat([challenge,
          mac("rconsole-private-state-broker-v2", nonce, request, clientNonce, challenge, serverKey)]), { nonce, request, clientNonce });
        socket.write(challenge.subarray(0, 8));
        setImmediate(() => {
          if (closeAfterChallenge) socket.end(challenge.subarray(8));
          else socket.write(challenge.subarray(8));
        });
      }
      if (stage === "proof") {
        if (buffer.length < 32 + stateLength) return;
        stage = "done";
        const received = buffer.subarray(0, 32), payload = buffer.subarray(32, 32 + stateLength);
        const expected = mac("rconsole-private-state-client-v2", nonce, request, clientNonce, payload, serverKey);
        if (!timingSafeEqual(received, expected)) {
          failed++;
          socket.destroy();
          return;
        }
        accepted++;
        const command = request.subarray(0, 4).toString("ascii");
        let value;
        if (command === "RCP2") {
          const ok = !stored || stored.equals(payload);
          if (ok) stored = Buffer.from(payload);
          value = Buffer.from([ok ? 0 : 1]);
        } else {
          disclosed++;
          value = stored ? Buffer.from(stored) : Buffer.alloc(0);
        }
        const header = Buffer.alloc(12);
        header.write("RCSR");
        header.writeUInt32LE(identity.pid, 4);
        header.writeUInt32LE(value.length, 8);
        const response = Buffer.concat([header, value]);
        const signature = mac("rconsole-private-state-server-v2", nonce, request, clientNonce, response,
          forgeReply ? "b".repeat(64) : serverKey);
        socket.write(response.subarray(0, 7));
        setImmediate(() => socket.end(Buffer.concat([response.subarray(7), signature])));
      }
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
  });
  return { identity, waitClosed: () => Promise.all(closed), received: () => receivedAfterHello, clientNonces, stats: () => ({ accepted, disclosed, failed }) };
}

test("session HMAC authenticates private GET and PUT without exposing data over TCP",
  { skip: process.platform === "win32" }, async t => {
  const { identity, stats } = await broker(t);
  assert.equal(await loadPrivateStartupState(identity, token), undefined);
  const state = Buffer.from("synthetic-credential\\0\\xff", "latin1");
  await savePrivateStartupState(identity, token, state);
  await savePrivateStartupState(identity, token, state);
  const retrieved = await loadPrivateStartupState(identity, token);
  assert.deepEqual(retrieved, state);
  retrieved.fill(0);
  await assert.rejects(savePrivateStartupState(identity, token, Buffer.from("wrong")), /different startup snapshot/);
  assert.deepEqual(stats(), { accepted: 5, disclosed: 2, failed: 0 });
});

test("wrong session token cannot retrieve credential-bearing startup state",
  { skip: process.platform === "win32" }, async t => {
  const { identity, stats } = await broker(t);
  await assert.rejects(loadPrivateStartupState(identity, "b".repeat(64)), /broker authentication failed/);
  assert.deepEqual(stats(), { accepted: 0, disclosed: 0, failed: 0 });
});

test("client rejects forged server proof or a challenge from another PID",
  { skip: process.platform === "win32" }, async t => {
  const mismatchedPid = await broker(t, { invalidPid: true });
  await assert.rejects(loadPrivateStartupState(mismatchedPid.identity, token), /different runtime/);
  assert.equal(mismatchedPid.stats().accepted, 0);
  const forgedReply = await broker(t, { forgeReply: true });
  await assert.rejects(loadPrivateStartupState(forgedReply.identity, token), /authentication failed/);
  assert.equal(forgedReply.stats().disclosed, 1);
});


for (const [name, options, error] of [
  ["tokenless broker", { serverKey: "b".repeat(64) }, /broker authentication failed/],
  ["wrong runtime", { invalidPid: true }, /different runtime/],
  ["modified nonce", { challengeTransform: bytes => { bytes[8] ^= 1; return bytes; } }, /authentication failed/],
  ["oversized challenge", { challengeTransform: bytes => Buffer.concat([bytes, Buffer.from([0])]) }, /framing/],
  ["truncated proof", { challengeTransform: bytes => bytes.subarray(0, 71), closeAfterChallenge: true }, /connection closed/],
  ["legacy unsigned challenge", { challengeTransform: bytes => bytes.subarray(0, 40), closeAfterChallenge: true }, /connection closed/],
  ["proof for another operation", { challengeTransform: (bytes, { nonce, request, clientNonce }) => {
    const other = Buffer.from(request);
    other.write("RCG2"); other.fill(0, 4);
    mac("rconsole-private-state-broker-v2", nonce, other, clientNonce, bytes.subarray(0, 40)).copy(bytes, 40);
    return bytes;
  } }, /authentication failed/],
  ["proof for another length", { challengeTransform: (bytes, { nonce, request, clientNonce }) => {
    const other = Buffer.from(request);
    other.writeUInt32LE(request.readUInt32LE(4) + 1, 4);
    mac("rconsole-private-state-broker-v2", nonce, other, clientNonce, bytes.subarray(0, 40)).copy(bytes, 40);
    return bytes;
  } }, /authentication failed/],
  ["reflected client proof", { challengeTransform: (bytes, { nonce, request, clientNonce }) => {
    mac("rconsole-private-state-client-v2", nonce, request, clientNonce, bytes.subarray(0, 40)).copy(bytes, 40);
    return bytes;
  } }, /authentication failed/],
]) {
  test(`${name} receives no startup snapshot or client proof`, { skip: process.platform === "win32" }, async t => {
    const fake = await broker(t, options);
    const snapshot = Buffer.from("SYNTHETIC_SECRET=credential; startupOption=private");
    await assert.rejects(savePrivateStartupState(fake.identity, token, snapshot), error);
    await fake.waitClosed();
    assert.equal(fake.received(), 0, "nothing beyond the public request and client nonce may be sent");
    assert.equal(snapshot.toString(), "SYNTHETIC_SECRET=credential; startupOption=private");
    assert.equal(fake.stats().accepted, 0);
  });
}

test("replayed broker authentication cannot release a snapshot on a new connection",
  { skip: process.platform === "win32" }, async t => {
  let recorded;
  const fake = await broker(t, { challengeTransform: bytes => {
    recorded ??= Buffer.from(bytes);
    return recorded;
  } });
  const snapshot = Buffer.from("synthetic-secret");
  await savePrivateStartupState(fake.identity, token, snapshot);
  const before = fake.received();
  await assert.rejects(savePrivateStartupState(fake.identity, token, snapshot), /broker authentication failed/);
  await fake.waitClosed();
  assert.notDeepEqual(fake.clientNonces[0], fake.clientNonces[1]);
  assert.equal(fake.received(), before, "replaying a valid broker proof must disclose no new bytes");
});

test("rejects invalid identity, missing token and oversized startup writes", async () => {
  const identity = { sessionId: randomUUID(), pid: process.pid };
  await assert.rejects(savePrivateStartupState(identity, token, Buffer.alloc(0)), /size/);
  await assert.rejects(savePrivateStartupState(identity, token, Buffer.alloc(MAX_PRIVATE_STARTUP_STATE_BYTES + 1)), /size/);
  await assert.rejects(loadPrivateStartupState(identity, "bad"), /authentication unavailable/);
  await assert.rejects(loadPrivateStartupState({ ...identity, sessionId: "../elsewhere" }, token), /identity/);
});

test("backend rejects retired TCP startup-state frames", () => {
  const { parseBackendFrames, encodeLspStartupStateFrame } = loadSource("src/Runtime/backendProtocol.ts");
  assert.equal(encodeLspStartupStateFrame, undefined);
  for (const kind of [27, 28, 29, 30]) {
    const packet = Buffer.alloc(12);
    packet.writeUInt16LE(kind, 4);
    assert.match(parseBackendFrames(packet).error, /Unknown backend frame/);
  }
});
