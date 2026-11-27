const assert = require("node:assert/strict");
const { createHmac, randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

const token = "a".repeat(64);
const nonce = Buffer.alloc(32, 0x5a);
const snapshot = Buffer.from("opaque-private-startup-snapshot");

function signature(context, request, clientNonce, payload) {
  return createHmac("sha256", token).update(context, "ascii")
    .update(nonce).update(request).update(clientNonce).update(payload).digest();
}

function fixture(mode) {
  const identity = { sessionId: randomUUID(), pid: process.pid };
  let acknowledgements = 0;
  let writes = 0;
  const net = {
    createConnection() {
      const socket = new EventEmitter();
      let request, clientNonce, proof, stage = "request", destroyed = false;
      socket.destroy = () => { destroyed = true; return socket; };
      const rejectPipe = () => socket.emit("error", Object.assign(new Error("read EPIPE"), { code: "EPIPE" }));
      const reply = () => {
        const put = request.subarray(0, 4).toString() === "RCP2";
        const payload = put ? socket.payload : Buffer.alloc(0);
        assert.deepEqual(proof, signature("rconsole-private-state-client-v2", request, clientNonce, payload));
        const value = put ? Buffer.from([0]) : snapshot;
        const header = Buffer.alloc(12);
        header.write("RCSR");
        header.writeUInt32LE(identity.pid, 4);
        header.writeUInt32LE(value.length, 8);
        const response = Buffer.concat([header, value]);
        const proofBytes = mode === "forged" ? Buffer.alloc(32) :
          signature("rconsole-private-state-server-v2", request, clientNonce, response);
        queueMicrotask(() => { if (!destroyed) socket.emit("data", Buffer.concat([response, proofBytes])); });
      };
      socket.write = (bytes, callback) => {
        writes++;
        const data = Buffer.from(bytes);
        if (stage === "request") {
          request = data.subarray(0, 37);
          clientNonce = data.subarray(37);
          assert.equal(clientNonce.length, 32);
          stage = "proof";
          queueMicrotask(() => {
            if (mode === "pre-auth-error") { rejectPipe(); return; }
            if (mode === "pre-auth-close") { socket.emit("close"); return; }
            const challenge = Buffer.alloc(40);
            challenge.write("RCSC");
            challenge.writeUInt32LE(identity.pid, 4);
            nonce.copy(challenge, 8);
            const brokerProof = mode === "forged-broker" ? Buffer.alloc(32) :
              signature("rconsole-private-state-broker-v2", request, clientNonce, challenge);
            socket.emit("data", Buffer.concat([challenge, brokerProof]));
          });
        } else if (stage === "proof") {
          proof = data;
          stage = "payload";
          if (request.subarray(0, 4).toString() === "RCG2") reply();
        } else {
          socket.payload = data;
          reply();
        }
        callback?.();
        return true;
      };
      socket.end = (ack, callback) => {
        acknowledgements++;
        assert.equal(Buffer.from(ack).toString("ascii"), "RCK1");
        // A real Windows broker can disconnect before Node runs the local
        // writable-finish callback, even after a complete authenticated reply.
        queueMicrotask(() => {
          if (mode === "after-proof-close") socket.emit("close");
          else rejectPipe();
          // Even if the local finish callback runs late after a pipe error,
          // the previously authenticated response must remain intact.
          if (mode === "late-ack") queueMicrotask(() => callback?.());
        });
        return socket;
      };
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  };
  const client = loadSource("src/Runtime/privateStartupState.ts", {
    net,
    "./sessionRegistryKey": {
      isSessionRegistryIdentity: () => true,
      sessionRegistryKeyEndpoint: () => "\\\\.\\pipe\\r-console-test",
    },
  }, { "process.platform": JSON.stringify("win32") });
  return { client, identity, observations: () => ({ acknowledgements, writes }) };
}

for (const mode of ["after-proof-epipe", "after-proof-close", "late-ack"]) {
  test("Windows " + mode + " preserves an authenticated private startup reply", async () => {
    const { client, identity, observations } = fixture(mode);
    const loaded = await client.loadPrivateStartupState(identity, token);
    assert.deepEqual(loaded, snapshot);
    loaded.fill(0);
    await client.savePrivateStartupState(identity, token, Buffer.from("new-startup-state"));
    assert.equal(observations().acknowledgements, 2);
  });
}

test("Windows pre-auth EPIPE remains a rejected private startup transfer", async () => {
  const { client, identity, observations } = fixture("pre-auth-error");
  await assert.rejects(client.loadPrivateStartupState(identity, token), /EPIPE/);
  assert.equal(observations().acknowledgements, 0);
});

test("Windows forged response MAC remains fatal without an acknowledgement", async () => {
  const { client, identity, observations } = fixture("forged");
  await assert.rejects(client.loadPrivateStartupState(identity, token), /authentication failed/);
  assert.equal(observations().acknowledgements, 0);
});

for (const [mode, error] of [["forged-broker", /broker authentication failed/],
  ["pre-auth-error", /EPIPE/], ["pre-auth-close", /connection closed/]]) {
  test(`Windows ${mode} releases no startup snapshot`, async () => {
    const { client, identity, observations } = fixture(mode);
    await assert.rejects(client.savePrivateStartupState(identity, token, snapshot), error);
    assert.deepEqual(observations(), { acknowledgements: 0, writes: 1 });
  });
}
