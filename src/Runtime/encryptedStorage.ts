import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { setTimeout as delay } from "timers/promises";
import type { SecretStorage } from "vscode";

const SECRET_NAME = "r-console.encrypted-storage-key.v1";
const KEY_LOOKUP_TIMEOUT_MS = 10000;
const RECOVERY_KEY_COUNT = 5;
type StorageSecrets = Pick<SecretStorage, "get" | "store" | "delete">;
type KeyEnvelope = { version: 1; keys: { name: string; encryptedKey: string }[] };

export class StorageEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageEncryptionError";
  }
}

export class EncryptedStorage {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new StorageEncryptionError("Invalid R Console encryption key.");
    }
  }

  encrypt(plaintext: string, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const bytes = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [
      "v1", nonce.toString("base64url"),
      cipher.getAuthTag().toString("base64url"), bytes.toString("base64url"),
    ].join(".");
  }

  decrypt(envelope: string, context: string): string {
    try {
      const parts = envelope.split(".");
      if (parts.length !== 4 || parts[0] !== "v1") {
        throw new Error("Unrecognized ciphertext version.");
      }
      const nonce = Buffer.from(parts[1], "base64url");
      const tag = Buffer.from(parts[2], "base64url");
      if (nonce.length !== 12 || tag.length !== 16) {
        throw new Error("Invalid ciphertext header.");
      }
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3], "base64url")), decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new StorageEncryptionError(
        "Could not decrypt R Console data. The encryption key may be missing or the data may be damaged."
      );
    }
  }
}

export function encryptSessionUi<T extends { runtime: { sessionId: string }; ui: unknown }>(
  terminal: T, encryption: EncryptedStorage
): Omit<T, "ui"> & { encryptedUi: string } {
  const { ui, ...rest } = terminal;
  return {
    ...rest,
    encryptedUi: encryption.encrypt(JSON.stringify(ui), "replay:" + terminal.runtime.sessionId),
  };
}

export function decryptSessionUi(
  terminal: Record<string, unknown>,
  encryption: EncryptedStorage
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(terminal, "encryptedUi")) {
    // Migration from the legacy plaintext persisted-sessions.json.
    return terminal;
  }
  const runtime = terminal.runtime;
  if (!runtime || typeof runtime !== "object" ||
      typeof (runtime as { sessionId?: unknown }).sessionId !== "string" ||
      typeof terminal.encryptedUi !== "string") {
    throw new StorageEncryptionError("Invalid encrypted R Console session record.");
  }
  let ui: unknown;
  try {
    ui = JSON.parse(encryption.decrypt(
      terminal.encryptedUi,
      "replay:" + (runtime as { sessionId: string }).sessionId
    ));
  } catch {
    throw new StorageEncryptionError("Could not restore encrypted R Console terminal replay.");
  }
  const { encryptedUi: unused, ...rest } = terminal;
  return { ...rest, ui };
}

export async function loadEncryptedStorage(
  secrets: StorageSecrets,
  storageFolder: string,
  persistedSessionsFile: string
): Promise<EncryptedStorage> {
  const envelopeFile = path.join(storageFolder, "encrypted-storage-keys.json");
  let envelope = readKeyEnvelope(envelopeFile);
  if (envelope) return recoverDataKey(secrets, envelope);

  const keyFile = path.join(storageFolder, "encrypted-storage-key-id");
  const legacyName = readStorageKeyName(keyFile) ?? SECRET_NAME;
  let encodedKey = await secrets.get(legacyName);
  const deadline = Date.now() + KEY_LOOKUP_TIMEOUT_MS;
  while (!encodedKey) {
    envelope = readKeyEnvelope(envelopeFile);
    if (envelope) return recoverDataKey(secrets, envelope);
    if (legacyName === SECRET_NAME) break;
    if (Date.now() >= deadline) throw unavailableKey();
    await delay(50);
    encodedKey = await secrets.get(legacyName);
  }
  envelope = readKeyEnvelope(envelopeFile);
  if (envelope) return recoverDataKey(secrets, envelope);
  if (!encodedKey) {
    const historyFolder = path.join(storageFolder, "history");
    const encryptedHistoryExists = fs.existsSync(historyFolder) &&
      fs.readdirSync(historyFolder).some((file) => file.endsWith(".enc"));
    const encryptedReplayExists = fs.existsSync(persistedSessionsFile) &&
      fs.readFileSync(persistedSessionsFile, "utf8").includes('"encryptedUi"');
    envelope = readKeyEnvelope(envelopeFile);
    if (envelope) return recoverDataKey(secrets, envelope);
    if (encryptedHistoryExists || encryptedReplayExists) throw unavailableKey();
  }

  const dataKey = encodedKey ? decodeKey(encodedKey) : randomBytes(32);
  const candidateId = randomBytes(16).toString("hex");
  const candidate: KeyEnvelope = {
    version: 1,
    keys: Array.from({ length: RECOVERY_KEY_COUNT }, (_, i) => ({
      name: SECRET_NAME + "." + candidateId + "." + i, encryptedKey: "",
    })),
  };
  const temporary = envelopeFile + "." + candidateId + ".tmp";
  let published = false;
  fs.mkdirSync(storageFolder, { recursive: true, mode: 0o700 });
  try {
    for (const slot of candidate.keys) {
      const wrappingKey = randomBytes(32);
      await secrets.store(slot.name, wrappingKey.toString("base64"));
      slot.encryptedKey = new EncryptedStorage(wrappingKey)
        .encrypt(dataKey.toString("base64"), "data-key:" + slot.name);
    }
    fs.writeFileSync(temporary, JSON.stringify(candidate), { flag: "wx", mode: 0o600 });
    // Publish the complete envelope without replacing another window's choice.
    try {
      fs.linkSync(temporary, envelopeFile);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
    if (!published) {
      await Promise.all(candidate.keys.map((slot) => secrets.delete(slot.name)));
    }
  }
  if (published) {
    // The original fixed-name secret may still be needed by another storage location.
    if (encodedKey && legacyName !== SECRET_NAME) {
      await secrets.delete(legacyName);
      fs.rmSync(keyFile, { force: true });
    }
    return new EncryptedStorage(dataKey);
  }
  envelope = readKeyEnvelope(envelopeFile);
  if (!envelope) throw unavailableKey();
  return recoverDataKey(secrets, envelope);
}

async function recoverDataKey(secrets: StorageSecrets, envelope: KeyEnvelope): Promise<EncryptedStorage> {
  const start = randomInt(envelope.keys.length);
  const slots = [...envelope.keys.slice(start), ...envelope.keys.slice(0, start)];
  const deadline = Date.now() + KEY_LOOKUP_TIMEOUT_MS;
  do {
    let unavailable = false;
    for (const slot of slots) {
      let encodedKey: string | undefined;
      try {
        encodedKey = await secrets.get(slot.name);
      } catch {
        unavailable = true;
        continue;
      }
      if (!encodedKey) {
        unavailable = true;
        continue;
      }
      try {
        const wrapping = new EncryptedStorage(decodeKey(encodedKey));
        return new EncryptedStorage(decodeKey(wrapping.decrypt(
          slot.encryptedKey, "data-key:" + slot.name
        )));
      } catch {
        // A damaged slot must not prevent recovery through another key.
      }
    }
    if (!unavailable || Date.now() >= deadline) throw unavailableKey();
    // Other windows may receive the SecretStorage updates after the envelope.
    await delay(50);
  } while (true);
}

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new StorageEncryptionError("Invalid stored R Console encryption key.");
  }
  return key;
}

function unavailableKey(): StorageEncryptionError {
  return new StorageEncryptionError(
    "R Console encryption key is unavailable. Existing encrypted history and replay files have been preserved."
  );
}

function readKeyEnvelope(file: string): KeyEnvelope | undefined {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const envelope = JSON.parse(content) as KeyEnvelope;
    if (envelope?.version !== 1 || !Array.isArray(envelope.keys) ||
        envelope.keys.length < 1 || envelope.keys.length > RECOVERY_KEY_COUNT ||
        envelope.keys.some((slot) => !slot || typeof slot.name !== "string" ||
          !slot.name.startsWith(SECRET_NAME + ".") ||
          !/^[a-f0-9]{32}\.[0-4]$/.test(slot.name.slice(SECRET_NAME.length + 1)) ||
          typeof slot.encryptedKey !== "string") ||
        new Set(envelope.keys.map((slot) => slot.name)).size !== envelope.keys.length) {
      throw new Error("Invalid key envelope.");
    }
    return envelope;
  } catch {
    throw new StorageEncryptionError("Invalid stored R Console data-key envelope.");
  }
}

function readStorageKeyName(keyFile: string): string | undefined {
  let name: string;
  try {
    name = fs.readFileSync(keyFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!name.startsWith(SECRET_NAME + ".") ||
      !/^[a-f0-9]{32}$/.test(name.slice(SECRET_NAME.length + 1))) {
    throw new StorageEncryptionError("Invalid stored R Console encryption key name.");
  }
  return name;
}
