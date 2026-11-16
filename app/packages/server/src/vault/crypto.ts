// Spec: knowledge/components/aeion-engine.md

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { dirname, resolve } from "node:path";

export interface EncryptedEnvelope {
  version: 1;
  userSaltB64: string;
  wrappedDekB64: string;
  dekIvB64: string;
  dekTagB64: string;
  ciphertextB64: string;
  dataIvB64: string;
  dataTagB64: string;
  keyFingerprint: string;
  maskedHint: string;
}

export interface SecretAadContext {
  userId: string;
  keyId: string;
  purpose: string;
  provider: string;
}

const APP_STATE_DIR = resolve(import.meta.dir, "../../../../.aeion");
const GCM_TAG_BYTES = 16;
const DEFAULT_MASTER_KEY_FILE = resolve(APP_STATE_DIR, "master.key");

let cachedPersistentMasterKey: Buffer | null = null;

function parseKeyMaterial(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) {
    return decoded;
  }
  throw new Error("Master key must be 32 bytes (64 hex chars or 44-char base64).");
}

export function getPersistentMasterKey(): Buffer {
  if (cachedPersistentMasterKey) return cachedPersistentMasterKey;
  const envKey = process.env.AEION_MASTER_KEY;
  if (envKey) {
    cachedPersistentMasterKey = parseKeyMaterial(envKey);
    return cachedPersistentMasterKey;
  }
  if (process.env.AEION_PERSISTENT_DB === ":memory:") {
    cachedPersistentMasterKey = randomBytes(32);
    return cachedPersistentMasterKey;
  }
  const keyFile = process.env.AEION_MASTER_KEY_FILE || DEFAULT_MASTER_KEY_FILE;
  if (existsSync(keyFile)) {
    const mode = statSync(keyFile).mode & 0o077;
    if (mode !== 0) {
      throw new Error(
        `Refusing insecure master key permissions on ${keyFile}; expected 0600.`,
      );
    }
    cachedPersistentMasterKey = parseKeyMaterial(readFileSync(keyFile, "utf8"));
    return cachedPersistentMasterKey;
  }
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const generated = randomBytes(32);
  writeFileSync(keyFile, `${generated.toString("hex")}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  cachedPersistentMasterKey = generated;
  return cachedPersistentMasterKey;
}

export function zeroBuffer(buf: Buffer | Uint8Array | null | undefined): void {
  if (!buf) return;
  buf.fill(0);
}

export function formatMaskedHint(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 10) return "••••••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function computeSecretFingerprint(
  rootKey: Buffer,
  userId: string,
  secret: Buffer,
): string {
  const mac = createHmac("sha256", rootKey);
  mac.update(userId);
  mac.update(":");
  mac.update(secret);
  return mac.digest("hex").slice(0, 24);
}

function buildAad(ctx: SecretAadContext): Buffer {
  return Buffer.from(
    `aeion-spec:vault:v1:${ctx.userId}:${ctx.keyId}:${ctx.purpose}:${ctx.provider}`,
    "utf8",
  );
}

function deriveUserKek(rootKey: Buffer, userSalt: Buffer, userId: string): Buffer {
  const derived = hkdfSync(
    "sha256",
    rootKey,
    userSalt,
    Buffer.from(`aeion-spec:kek:v1:${userId}`, "utf8"),
    32,
  );
  return Buffer.from(derived);
}

export function sealSecret(params: {
  rootKey: Buffer;
  userSaltB64?: string;
  ctx: SecretAadContext;
  plaintext: string;
}): EncryptedEnvelope {
  const { rootKey, ctx, plaintext } = params;
  const userSalt = params.userSaltB64
    ? Buffer.from(params.userSaltB64, "base64")
    : randomBytes(32);
  const kek = deriveUserKek(rootKey, userSalt, ctx.userId);
  const dek = randomBytes(32);
  const plainBuf = Buffer.from(plaintext, "utf8");
  const aad = buildAad(ctx);

  try {
    const dataIv = randomBytes(12);
    const dataCipher = createCipheriv("aes-256-gcm", dek, dataIv, { authTagLength: GCM_TAG_BYTES });
    dataCipher.setAAD(aad);
    const encryptedData = Buffer.concat([
      dataCipher.update(plainBuf),
      dataCipher.final(),
    ]);
    const dataTag = dataCipher.getAuthTag();

    const dekIv = randomBytes(12);
    const dekCipher = createCipheriv("aes-256-gcm", kek, dekIv, { authTagLength: GCM_TAG_BYTES });
    dekCipher.setAAD(aad);
    const wrappedDek = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
    const dekTag = dekCipher.getAuthTag();

    const keyFingerprint = computeSecretFingerprint(rootKey, ctx.userId, plainBuf);
    const maskedHint = formatMaskedHint(plaintext);

    return {
      version: 1,
      userSaltB64: userSalt.toString("base64"),
      wrappedDekB64: wrappedDek.toString("base64"),
      dekIvB64: dekIv.toString("base64"),
      dekTagB64: dekTag.toString("base64"),
      ciphertextB64: encryptedData.toString("base64"),
      dataIvB64: dataIv.toString("base64"),
      dataTagB64: dataTag.toString("base64"),
      keyFingerprint,
      maskedHint,
    };
  } finally {
    zeroBuffer(kek);
    zeroBuffer(dek);
    zeroBuffer(plainBuf);
  }
}

export function withUnsealedSecret<T>(
  params: {
    rootKey: Buffer;
    ctx: SecretAadContext;
    envelope: EncryptedEnvelope;
  },
  fn: (secretUtf8: string, secretBuf: Buffer) => T,
): T {
  const { rootKey, ctx, envelope } = params;
  if (envelope.version !== 1) {
    throw new Error(`Unsupported vault envelope version: ${String(envelope.version)}`);
  }
  const userSalt = Buffer.from(envelope.userSaltB64, "base64");
  const kek = deriveUserKek(rootKey, userSalt, ctx.userId);
  const aad = buildAad(ctx);
  let dek: Buffer | null = null;
  let plainBuf: Buffer | null = null;

  try {
    // A fixed 16-byte tag: without it GCM accepts a truncated tag an attacker can forge more easily.
    const dekDecipher = createDecipheriv(
      "aes-256-gcm",
      kek,
      Buffer.from(envelope.dekIvB64, "base64"),
      { authTagLength: GCM_TAG_BYTES },
    );
    dekDecipher.setAAD(aad);
    dekDecipher.setAuthTag(Buffer.from(envelope.dekTagB64, "base64"));
    dek = Buffer.concat([
      dekDecipher.update(Buffer.from(envelope.wrappedDekB64, "base64")),
      dekDecipher.final(),
    ]);

    const dataDecipher = createDecipheriv(
      "aes-256-gcm",
      dek,
      Buffer.from(envelope.dataIvB64, "base64"),
      { authTagLength: GCM_TAG_BYTES },
    );
    dataDecipher.setAAD(aad);
    dataDecipher.setAuthTag(Buffer.from(envelope.dataTagB64, "base64"));
    plainBuf = Buffer.concat([
      dataDecipher.update(Buffer.from(envelope.ciphertextB64, "base64")),
      dataDecipher.final(),
    ]);

    return fn(plainBuf.toString("utf8"), plainBuf);
  } finally {
    zeroBuffer(kek);
    zeroBuffer(dek);
    zeroBuffer(plainBuf);
  }
}
