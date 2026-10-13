import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { SecretStorage } from "vscode";

const SECRET_NAME = "r-console.encrypted-storage-key.v1";

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
  secrets: Pick<SecretStorage, "get" | "store">,
  storageFolder: string,
  persistedSessionsFile: string
): Promise<EncryptedStorage> {
  let encodedKey = await secrets.get(SECRET_NAME);
  if (!encodedKey) {
    const historyFolder = path.join(storageFolder, "history");
    const encryptedHistoryExists = fs.existsSync(historyFolder) &&
      fs.readdirSync(historyFolder).some((file) => file.endsWith(".enc"));
    const encryptedReplayExists = fs.existsSync(persistedSessionsFile) &&
      fs.readFileSync(persistedSessionsFile, "utf8").includes('"encryptedUi"');
    if (encryptedHistoryExists || encryptedReplayExists) {
      throw new StorageEncryptionError(
        "R Console encryption key is unavailable. Existing encrypted history and replay files have been preserved."
      );
    }
    encodedKey = randomBytes(32).toString("base64");
    await secrets.store(SECRET_NAME, encodedKey);
  }
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new StorageEncryptionError("Invalid stored R Console encryption key.");
  }
  return new EncryptedStorage(key);
}
