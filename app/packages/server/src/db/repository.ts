// Spec: knowledge/components/aeion-engine.md

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type {
  AgentRoleId,
  AutomatedReviewReport,
  GoldfishPersonaId,
  LlmProviderId,
  ModelAssignment,
  OpenShellScanSummary,
  ProjectRecord,
  ReleaseRecord,
  SessionMode,
  SourceKind,
  TableauCard,
  TableauColumn,
  VaultKeySummary,
  VaultSecretPurpose,
} from "@aeion-spec/shared";
import { buildDefaultMixer } from "@aeion-spec/shared";
import {
  getPersistentMasterKey,
  sealSecret,
  withUnsealedSecret,
  zeroBuffer,
  type EncryptedEnvelope,
} from "../vault/crypto.ts";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  vault_salt_b64 TEXT NOT NULL,
  builder_token_hash TEXT NOT NULL,
  builder_token_preview TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  masked_hint TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  active_release_id TEXT,
  active_release_version TEXT NOT NULL,
  active_release_title TEXT NOT NULL,
  github_vault_key_id TEXT,
  openshell_summary_json TEXT,
  mixer_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL,
  status TEXT NOT NULL,
  bump_kind TEXT,
  risk_score INTEGER,
  sealed_digest TEXT,
  approval_signature TEXT,
  axiom_snapshot_json TEXT,
  observability_manifest_json TEXT,
  cards_snapshot_json TEXT,
  created_at TEXT NOT NULL,
  sealed_at TEXT
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  feature_code TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  area TEXT NOT NULL,
  phase TEXT NOT NULL,
  size TEXT NOT NULL,
  write_paths_json TEXT NOT NULL,
  depends_on_json TEXT NOT NULL,
  column_name TEXT NOT NULL,
  position INTEGER NOT NULL,
  goldfish_round INTEGER NOT NULL,
  goldfish_satisfied INTEGER NOT NULL,
  user_satisfied INTEGER NOT NULL,
  review_passed INTEGER NOT NULL,
  active_personas_json TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  assumptions_json TEXT NOT NULL,
  draft_markdown TEXT NOT NULL,
  latest_review_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS builder_feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  feature_code TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL,
  artifact_digest TEXT,
  created_at TEXT NOT NULL
);
`;

export interface StoredUserRecord {
  id: string;
  email: string | null;
  displayName: string;
  passwordHash: string;
  vaultSaltB64: string;
  builderTokenHash: string;
  builderTokenPreview: string;
  mode: SessionMode;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  mode: SessionMode;
  csrfToken: string;
  expiresAt: string;
}

interface InviteWorkspace {
  sessionId: string;
  user: StoredUserRecord;
  session: SessionRecord;
  builderTokenPlain: string;
  ramDb: Database;
  ramRootKey: Buffer;
  expiresAtMs: number;
}

const APP_STATE_DIR = resolve(import.meta.dir, "../../../../.aeion");
const DEFAULT_DB_FILE = resolve(APP_STATE_DIR, "aeion-spec.db");
const INVITE_TTL_MS = 2 * 60 * 60 * 1000;

let persistentDb: Database | null = null;
const inviteWorkspaces = new Map<string, InviteWorkspace>();
const inviteTokenIndex = new Map<string, string>();
const inviteBuilderTokenIndex = new Map<string, string>();

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function getPersistentDb(): Database {
  if (persistentDb) return persistentDb;
  const dbPath = process.env.AEION_PERSISTENT_DB || DEFAULT_DB_FILE;
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  }
  const db = new Database(dbPath);
  if (dbPath !== ":memory:" && existsSync(dbPath)) {
    chmodSync(dbPath, 0o600);
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  persistentDb = db;
  return db;
}

function purgeExpiredInvites(nowMs = Date.now()): void {
  for (const [sessionId, ws] of inviteWorkspaces.entries()) {
    if (ws.expiresAtMs <= nowMs) {
      destroyInviteWorkspace(sessionId);
    }
  }
}

// Other RAM-only stores (the OpenShell snapshots) register here, so an expired invite erases them too.
const inviteTeardownHooks: Array<(sessionId: string) => void> = [];
export function onInviteWorkspaceDestroyed(hook: (sessionId: string) => void): void {
  inviteTeardownHooks.push(hook);
}

export function destroyInviteWorkspace(sessionId: string): boolean {
  const ws = inviteWorkspaces.get(sessionId);
  if (!ws) return false;
  for (const hook of inviteTeardownHooks) hook(sessionId);
  for (const [tokHash, sid] of inviteTokenIndex.entries()) {
    if (sid === sessionId) inviteTokenIndex.delete(tokHash);
  }
  for (const [bldHash, sid] of inviteBuilderTokenIndex.entries()) {
    if (sid === sessionId) inviteBuilderTokenIndex.delete(bldHash);
  }
  try {
    ws.ramDb.close(false);
  } catch {
    // Ignore close errors during teardown
  }
  zeroBuffer(ws.ramRootKey);
  inviteWorkspaces.delete(sessionId);
  return true;
}

export function createInviteWorkspace(): {
  rawSessionToken: string;
  builderTokenPlain: string;
  session: SessionRecord;
  user: StoredUserRecord;
} {
  purgeExpiredInvites();
  const sessionId = `inv_sess_${randomUUID()}`;
  const userId = `inv_usr_${randomUUID()}`;
  const rawSessionToken = `aeion_inv_${randomBytes(32).toString("hex")}`;
  const tokenHash = sha256Hex(rawSessionToken);
  const csrfToken = randomBytes(24).toString("hex");
  const builderTokenPlain = `aeion_bld_inv_${randomBytes(24).toString("hex")}`;
  const builderTokenHash = sha256Hex(builderTokenPlain);
  const builderTokenPreview = `${builderTokenPlain.slice(0, 14)}...`;
  const expiresAtMs = Date.now() + INVITE_TTL_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const now = new Date().toISOString();

  const ramDb = new Database(":memory:");
  ramDb.exec(SCHEMA_SQL);
  const ramRootKey = randomBytes(32);

  const user: StoredUserRecord = {
    id: userId,
    email: null,
    displayName: "Invite Guest (RAM Only)",
    passwordHash: "",
    vaultSaltB64: randomBytes(32).toString("base64"),
    builderTokenHash,
    builderTokenPreview,
    mode: "invite",
    createdAt: now,
  };
  const session: SessionRecord = {
    id: sessionId,
    userId,
    mode: "invite",
    csrfToken,
    expiresAt,
  };

  inviteWorkspaces.set(sessionId, {
    sessionId,
    user,
    session,
    builderTokenPlain,
    ramDb,
    ramRootKey,
    expiresAtMs,
  });
  inviteTokenIndex.set(tokenHash, sessionId);
  inviteBuilderTokenIndex.set(builderTokenHash, sessionId);

  return { rawSessionToken, builderTokenPlain, session, user };
}

export function getInviteCount(): number {
  purgeExpiredInvites();
  return inviteWorkspaces.size;
}

function getContextForSession(rawToken: string): {
  db: Database;
  rootKey: Buffer;
  user: StoredUserRecord;
  session: SessionRecord;
  builderTokenPlain: string | null;
} | null {
  purgeExpiredInvites();
  const tokenHash = sha256Hex(rawToken);

  const inviteSid = inviteTokenIndex.get(tokenHash);
  if (inviteSid) {
    const ws = inviteWorkspaces.get(inviteSid);
    if (!ws) return null;
    return {
      db: ws.ramDb,
      rootKey: ws.ramRootKey,
      user: ws.user,
      session: ws.session,
      builderTokenPlain: ws.builderTokenPlain,
    };
  }

  const db = getPersistentDb();
  const sRow = db
    .query(
      `SELECT id, user_id, mode, csrf_token, expires_at FROM sessions WHERE token_hash = ?1`,
    )
    .get(tokenHash) as
    | {
        id: string;
        user_id: string;
        mode: string;
        csrf_token: string;
        expires_at: string;
      }
    | null;
  if (!sRow) return null;
  if (Date.parse(sRow.expires_at) <= Date.now()) {
    db.query(`DELETE FROM sessions WHERE id = ?1`).run(sRow.id);
    return null;
  }
  const uRow = db
    .query(
      `SELECT id, email, display_name, password_hash, vault_salt_b64, builder_token_hash, builder_token_preview, created_at FROM users WHERE id = ?1`,
    )
    .get(sRow.user_id) as
    | {
        id: string;
        email: string;
        display_name: string;
        password_hash: string;
        vault_salt_b64: string;
        builder_token_hash: string;
        builder_token_preview: string;
        created_at: string;
      }
    | null;
  if (!uRow) return null;

  return {
    db,
    rootKey: getPersistentMasterKey(),
    user: {
      id: uRow.id,
      email: uRow.email,
      displayName: uRow.display_name,
      passwordHash: uRow.password_hash,
      vaultSaltB64: uRow.vault_salt_b64,
      builderTokenHash: uRow.builder_token_hash,
      builderTokenPreview: uRow.builder_token_preview,
      mode: "authenticated",
      createdAt: uRow.created_at,
    },
    session: {
      id: sRow.id,
      userId: sRow.user_id,
      mode: "authenticated",
      csrfToken: sRow.csrf_token,
      expiresAt: sRow.expires_at,
    },
    builderTokenPlain: null,
  };
}

export class StoreRepository {
  static createPersistentUser(params: {
    email: string;
    displayName: string;
    passwordHash: string;
  }): { user: StoredUserRecord; builderTokenPlain: string } {
    const db = getPersistentDb();
    const id = `usr_${randomUUID()}`;
    const vaultSaltB64 = randomBytes(32).toString("base64");
    const builderTokenPlain = `aeion_bld_${randomBytes(24).toString("hex")}`;
    const builderTokenHash = sha256Hex(builderTokenPlain);
    const builderTokenPreview = `${builderTokenPlain.slice(0, 14)}...`;
    const now = new Date().toISOString();
    const normEmail = params.email.trim().toLowerCase();

    db.query(
      `INSERT INTO users (id, email, display_name, password_hash, vault_salt_b64, builder_token_hash, builder_token_preview, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).run(
      id,
      normEmail,
      params.displayName.trim(),
      params.passwordHash,
      vaultSaltB64,
      builderTokenHash,
      builderTokenPreview,
      now,
    );

    return {
      user: {
        id,
        email: normEmail,
        displayName: params.displayName.trim(),
        passwordHash: params.passwordHash,
        vaultSaltB64,
        builderTokenHash,
        builderTokenPreview,
        mode: "authenticated",
        createdAt: now,
      },
      builderTokenPlain,
    };
  }

  static findPersistentUserByEmail(email: string): StoredUserRecord | null {
    const db = getPersistentDb();
    const row = db
      .query(
        `SELECT id, email, display_name, password_hash, vault_salt_b64, builder_token_hash, builder_token_preview, created_at FROM users WHERE email = ?1`,
      )
      .get(email.trim().toLowerCase()) as
      | {
          id: string;
          email: string;
          display_name: string;
          password_hash: string;
          vault_salt_b64: string;
          builder_token_hash: string;
          builder_token_preview: string;
          created_at: string;
        }
      | null;
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      vaultSaltB64: row.vault_salt_b64,
      builderTokenHash: row.builder_token_hash,
      builderTokenPreview: row.builder_token_preview,
      mode: "authenticated",
      createdAt: row.created_at,
    };
  }

  static createPersistentSession(userId: string): {
    rawToken: string;
    session: SessionRecord;
  } {
    const db = getPersistentDb();
    const id = `sess_${randomUUID()}`;
    const rawToken = `aeion_ses_${randomBytes(32).toString("hex")}`;
    const tokenHash = sha256Hex(rawToken);
    const csrfToken = randomBytes(24).toString("hex");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.query(
      `INSERT INTO sessions (id, token_hash, user_id, mode, csrf_token, expires_at, created_at)
       VALUES (?1, ?2, ?3, 'authenticated', ?4, ?5, ?6)`,
    ).run(id, tokenHash, userId, csrfToken, expiresAt, now);
    return {
      rawToken,
      session: { id, userId, mode: "authenticated", csrfToken, expiresAt },
    };
  }

  static revokeSessionByRawToken(rawToken: string): void {
    const hash = sha256Hex(rawToken);
    const inviteSid = inviteTokenIndex.get(hash);
    if (inviteSid) {
      destroyInviteWorkspace(inviteSid);
      return;
    }
    getPersistentDb().query(`DELETE FROM sessions WHERE token_hash = ?1`).run(hash);
  }

  static resolveSession(rawToken: string) {
    return getContextForSession(rawToken);
  }

  static rotateBuilderToken(ctx: {
    db: Database;
    user: StoredUserRecord;
  }): { tokenPlain: string; preview: string } {
    const tokenPlain =
      ctx.user.mode === "invite"
        ? `aeion_bld_inv_${randomBytes(24).toString("hex")}`
        : `aeion_bld_${randomBytes(24).toString("hex")}`;
    const tokenHash = sha256Hex(tokenPlain);
    const preview = `${tokenPlain.slice(0, 14)}...`;
    if (ctx.user.mode === "invite") {
      for (const ws of inviteWorkspaces.values()) {
        if (ws.user.id === ctx.user.id) {
          inviteBuilderTokenIndex.delete(ws.user.builderTokenHash);
          ws.user.builderTokenHash = tokenHash;
          ws.user.builderTokenPreview = preview;
          ws.builderTokenPlain = tokenPlain;
          inviteBuilderTokenIndex.set(tokenHash, ws.sessionId);
          break;
        }
      }
      return { tokenPlain, preview };
    }
    ctx.db
      .query(
        `UPDATE users SET builder_token_hash = ?1, builder_token_preview = ?2 WHERE id = ?3`,
      )
      .run(tokenHash, preview, ctx.user.id);
    ctx.user.builderTokenHash = tokenHash;
    ctx.user.builderTokenPreview = preview;
    return { tokenPlain, preview };
  }

  static resolveBuilderContext(rawBuilderToken: string): {
    db: Database;
    userId: string;
    mode: SessionMode;
  } | null {
    purgeExpiredInvites();
    const tokenHash = sha256Hex(rawBuilderToken);
    const inviteSid = inviteBuilderTokenIndex.get(tokenHash);
    if (inviteSid) {
      const ws = inviteWorkspaces.get(inviteSid);
      if (!ws) return null;
      return { db: ws.ramDb, userId: ws.user.id, mode: "invite" };
    }
    const db = getPersistentDb();
    const uRow = db
      .query(`SELECT id FROM users WHERE builder_token_hash = ?1`)
      .get(tokenHash) as { id: string } | null;
    if (!uRow) return null;
    return { db, userId: uRow.id, mode: "authenticated" };
  }

  static storeVaultKey(
    ctx: { db: Database; rootKey: Buffer; user: StoredUserRecord },
    input: {
      purpose: VaultSecretPurpose;
      provider: LlmProviderId | "github";
      label: string;
      secret: string;
      verifiedAt?: string | null;
    },
  ): VaultKeySummary {
    const id = `key_${randomUUID()}`;
    const now = new Date().toISOString();
    const envelope = sealSecret({
      rootKey: ctx.rootKey,
      userSaltB64: ctx.user.vaultSaltB64,
      ctx: {
        userId: ctx.user.id,
        keyId: id,
        purpose: input.purpose,
        provider: input.provider,
      },
      plaintext: input.secret,
    });

    // One active key per (user, purpose, provider): a new key replaces the old one.
    ctx.db
      .query(
        `DELETE FROM vault_keys WHERE user_id = ?1 AND purpose = ?2 AND provider = ?3`,
      )
      .run(ctx.user.id, input.purpose, input.provider);

    ctx.db
      .query(
        `INSERT INTO vault_keys (id, user_id, purpose, provider, label, envelope_json, masked_hint, key_fingerprint, verified_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .run(
        id,
        ctx.user.id,
        input.purpose,
        input.provider,
        input.label.trim(),
        JSON.stringify(envelope),
        envelope.maskedHint,
        envelope.keyFingerprint,
        input.verifiedAt ?? null,
        now,
      );

    return {
      id,
      purpose: input.purpose,
      provider: input.provider,
      label: input.label.trim(),
      maskedHint: envelope.maskedHint,
      keyFingerprint: envelope.keyFingerprint,
      verifiedAt: input.verifiedAt ?? null,
      createdAt: now,
    };
  }

  static listVaultKeys(db: Database, userId: string): VaultKeySummary[] {
    const rows = db
      .query(
        `SELECT id, purpose, provider, label, masked_hint, key_fingerprint, verified_at, created_at FROM vault_keys WHERE user_id = ?1 ORDER BY created_at DESC`,
      )
      .all(userId) as Array<{
      id: string;
      purpose: string;
      provider: string;
      label: string;
      masked_hint: string;
      key_fingerprint: string;
      verified_at: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      purpose: r.purpose as VaultSecretPurpose,
      provider: r.provider as LlmProviderId | "github",
      label: r.label,
      maskedHint: r.masked_hint,
      keyFingerprint: r.key_fingerprint,
      verifiedAt: r.verified_at,
      createdAt: r.created_at,
    }));
  }

  static deleteVaultKey(db: Database, userId: string, keyId: string): boolean {
    const res = db
      .query(`DELETE FROM vault_keys WHERE id = ?1 AND user_id = ?2`)
      .run(keyId, userId);
    return res.changes > 0;
  }

  static withProviderSecret<T>(
    ctx: { db: Database; rootKey: Buffer; user: StoredUserRecord },
    params: { purpose: VaultSecretPurpose; provider: LlmProviderId | "github"; keyId?: string | null },
    fn: (secretUtf8: string) => T,
  ): T {
    type KeyRow = { id: string; purpose: string; provider: string; envelope_json: string };
    const byId = params.keyId
      ? (ctx.db
          .query(
            `SELECT id, purpose, provider, envelope_json FROM vault_keys WHERE id = ?1 AND user_id = ?2`,
          )
          .get(params.keyId, ctx.user.id) as KeyRow | null)
      : null;
    // A key stored for another purpose or provider must never be sent to this one.
    if (byId && (byId.purpose !== params.purpose || byId.provider !== params.provider)) {
      throw new Error(
        `Key Vault entry ${params.keyId} is not a ${params.purpose} key for ${params.provider}.`,
      );
    }
    // A replaced key leaves the old id behind; the current key of the same purpose and provider takes over.
    const row =
      byId ??
      (ctx.db
        .query(
          `SELECT id, purpose, provider, envelope_json FROM vault_keys WHERE user_id = ?1 AND purpose = ?2 AND provider = ?3 LIMIT 1`,
        )
        .get(ctx.user.id, params.purpose, params.provider) as KeyRow | null);

    if (!row) {
      throw new Error(
        `Missing configured API credential in Key Vault for ${params.provider}.`,
      );
    }
    const envelope = JSON.parse(row.envelope_json) as EncryptedEnvelope;
    return withUnsealedSecret(
      {
        rootKey: ctx.rootKey,
        ctx: {
          userId: ctx.user.id,
          keyId: row.id,
          purpose: row.purpose,
          provider: row.provider,
        },
        envelope,
      },
      (secret) => fn(secret),
    );
  }

  static createProject(
    db: Database,
    userId: string,
    input: {
      name: string;
      description: string;
      releaseTitle: string;
      releaseVersion: string;
      sourceKind: SourceKind;
      sourceRef: string | null;
      githubVaultKeyId: string | null;
      openshellSummary: OpenShellScanSummary | null;
    },
  ): { project: ProjectRecord; release: ReleaseRecord } {
    const projectId = `proj_${randomUUID()}`;
    const releaseId = `rel_${randomUUID()}`;
    const now = new Date().toISOString();
    const version = input.releaseVersion.replace(/^v/i, "");
    const baseSlug =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 42) || "project";
    // The builder API addresses a project by slug, so a slug is unique per owner.
    const takenSlugs = new Set(
      (db.query(`SELECT slug FROM projects WHERE owner_id = ?1`).all(userId) as Array<{ slug: string }>).map(
        (r) => r.slug,
      ),
    );
    let slug = baseSlug;
    for (let n = 2; takenSlugs.has(slug); n++) slug = `${baseSlug}-${n}`;

    const heldProviders = StoreRepository.listVaultKeys(db, userId)
      .filter((k) => k.purpose === "llm_provider")
      .map((k) => k.provider as LlmProviderId);
    const defaultMixer = buildDefaultMixer(heldProviders);

    db.query(
      `INSERT INTO projects (id, owner_id, slug, name, description, source_kind, source_ref, active_release_id, active_release_version, active_release_title, github_vault_key_id, openshell_summary_json, mixer_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    ).run(
      projectId,
      userId,
      slug,
      input.name.trim(),
      input.description.trim(),
      input.sourceKind,
      input.sourceRef,
      releaseId,
      version,
      input.releaseTitle.trim(),
      input.githubVaultKeyId,
      input.openshellSummary ? JSON.stringify(input.openshellSummary) : null,
      JSON.stringify(defaultMixer),
      now,
      now,
    );

    db.query(
      `INSERT INTO releases (id, project_id, version, title, notes, status, bump_kind, risk_score, sealed_digest, approval_signature, axiom_snapshot_json, observability_manifest_json, cards_snapshot_json, created_at, sealed_at)
       VALUES (?1, ?2, ?3, ?4, '', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?5, NULL)`,
    ).run(releaseId, projectId, version, input.releaseTitle.trim(), now);

    return {
      project: {
        id: projectId,
        ownerId: userId,
        slug,
        name: input.name.trim(),
        description: input.description.trim(),
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        activeReleaseId: releaseId,
        activeReleaseVersion: version,
        activeReleaseTitle: input.releaseTitle.trim(),
        githubVaultKeyId: input.githubVaultKeyId,
        openshellSummary: input.openshellSummary,
        createdAt: now,
        updatedAt: now,
      },
      release: {
        id: releaseId,
        projectId,
        version,
        title: input.releaseTitle.trim(),
        notes: "",
        status: "active",
        bumpKind: null,
        riskScore: null,
        sealedDigest: null,
        approvalSignature: null,
        axiomSnapshotJson: null,
        observabilityManifestJson: null,
        cardsCount: 0,
        validatedCount: 0,
        createdAt: now,
        sealedAt: null,
      },
    };
  }

  static listProjects(db: Database, ownerId: string): ProjectRecord[] {
    const rows = db
      .query(
        `SELECT * FROM projects WHERE owner_id = ?1 ORDER BY updated_at DESC`,
      )
      .all(ownerId) as Array<Record<string, unknown>>;
    return rows.map((r) => StoreRepository.mapProjectRow(r));
  }

  // Removes a project and everything under it, in one transaction, only for its owner.
  static deleteProject(db: Database, ownerId: string, projectId: string): boolean {
    const owned = db
      .query(`SELECT id FROM projects WHERE id = ?1 AND owner_id = ?2`)
      .get(projectId, ownerId);
    if (!owned) return false;
    db.transaction(() => {
      db.query(`DELETE FROM cards WHERE project_id = ?1`).run(projectId);
      db.query(`DELETE FROM releases WHERE project_id = ?1`).run(projectId);
      db.query(`DELETE FROM builder_feedback WHERE project_id = ?1`).run(projectId);
      db.query(`DELETE FROM projects WHERE id = ?1`).run(projectId);
    })();
    return true;
  }

  static getProject(
    db: Database,
    ownerId: string,
    projectId: string,
  ): ProjectRecord | null {
    const row = db
      .query(`SELECT * FROM projects WHERE id = ?1 AND owner_id = ?2`)
      .get(projectId, ownerId) as Record<string, unknown> | null;
    return row ? StoreRepository.mapProjectRow(row) : null;
  }

  static mapProjectRow(r: Record<string, unknown>): ProjectRecord {
    return {
      id: String(r.id),
      ownerId: String(r.owner_id),
      slug: String(r.slug),
      name: String(r.name),
      description: String(r.description),
      sourceKind: String(r.source_kind) as SourceKind,
      sourceRef: r.source_ref ? String(r.source_ref) : null,
      activeReleaseId: r.active_release_id ? String(r.active_release_id) : null,
      activeReleaseVersion: String(r.active_release_version),
      activeReleaseTitle: String(r.active_release_title),
      githubVaultKeyId: r.github_vault_key_id
        ? String(r.github_vault_key_id)
        : null,
      openshellSummary: r.openshell_summary_json
        ? (JSON.parse(String(r.openshell_summary_json)) as OpenShellScanSummary)
        : null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  static updateProjectOpenShell(
    db: Database,
    projectId: string,
    summary: OpenShellScanSummary,
  ): void {
    db.query(
      `UPDATE projects SET openshell_summary_json = ?1, updated_at = ?2 WHERE id = ?3`,
    ).run(JSON.stringify(summary), new Date().toISOString(), projectId);
  }

  static getMixer(
    db: Database,
    projectId: string,
  ): Partial<Record<AgentRoleId, ModelAssignment>> {
    const row = db
      .query(`SELECT mixer_json FROM projects WHERE id = ?1`)
      .get(projectId) as { mixer_json: string } | null;
    if (!row) return {};
    return JSON.parse(row.mixer_json) as Partial<Record<AgentRoleId, ModelAssignment>>;
  }

  static saveMixer(
    db: Database,
    projectId: string,
    assignments: Partial<Record<AgentRoleId, ModelAssignment>>,
  ): void {
    db.query(
      `UPDATE projects SET mixer_json = ?1, updated_at = ?2 WHERE id = ?3`,
    ).run(JSON.stringify(assignments), new Date().toISOString(), projectId);
  }

  static createCard(
    db: Database,
    input: {
      projectId: string;
      releaseId: string;
      title: string;
      summary: string;
      area: string;
      phase: string;
      size: "S" | "M" | "L";
      writePaths: string[];
      dependsOn: string[];
    },
  ): TableauCard {
    const existing = db
      .query(`SELECT COUNT(*) as cnt FROM cards WHERE project_id = ?1`)
      .get(input.projectId) as { cnt: number };
    const codeNum = (existing?.cnt ?? 0) + 1;
    const featureCode = `F-${String(codeNum).padStart(2, "0")}`;
    const posRow = db
      .query(
        `SELECT COALESCE(MAX(position), -1) as maxp FROM cards WHERE release_id = ?1 AND column_name = 'idea'`,
      )
      .get(input.releaseId) as { maxp: number };

    const id = `card_${randomUUID()}`;
    const now = new Date().toISOString();
    const defaultPersonas: GoldfishPersonaId[] = [
      "pm",
      "security",
      "sre",
      "ux",
      "architecture",
      "finops",
      "legal",
      "devil",
    ];
    const card: TableauCard = {
      id,
      projectId: input.projectId,
      releaseId: input.releaseId,
      featureCode,
      title: input.title.trim(),
      summary: input.summary.trim(),
      area: input.area || "foundation",
      phase: input.phase || "P1",
      size: input.size || "M",
      writePaths: input.writePaths,
      dependsOn: input.dependsOn,
      column: "idea",
      position: (posRow?.maxp ?? -1) + 1,
      goldfishRound: 0,
      goldfishSatisfied: false,
      userSatisfied: false,
      reviewPassed: false,
      activePersonas: defaultPersonas,
      messages: [],
      findings: [],
      decisions: [],
      assumptions: [],
      draftMarkdown: "",
      latestReview: null,
      createdAt: now,
      updatedAt: now,
    };
    StoreRepository.saveCard(db, card, true);
    return card;
  }

  static saveCard(db: Database, card: TableauCard, insert = false): void {
    const updatedAt = new Date().toISOString();
    card.updatedAt = updatedAt;
    if (insert) {
      db.query(
        `INSERT INTO cards (id, project_id, release_id, feature_code, title, summary, area, phase, size, write_paths_json, depends_on_json, column_name, position, goldfish_round, goldfish_satisfied, user_satisfied, review_passed, active_personas_json, messages_json, findings_json, decisions_json, assumptions_json, draft_markdown, latest_review_json, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)`,
      ).run(
        card.id,
        card.projectId,
        card.releaseId,
        card.featureCode,
        card.title,
        card.summary,
        card.area,
        card.phase,
        card.size,
        JSON.stringify(card.writePaths),
        JSON.stringify(card.dependsOn),
        card.column,
        card.position,
        card.goldfishRound,
        card.goldfishSatisfied ? 1 : 0,
        card.userSatisfied ? 1 : 0,
        card.reviewPassed ? 1 : 0,
        JSON.stringify(card.activePersonas),
        JSON.stringify(card.messages),
        JSON.stringify(card.findings),
        JSON.stringify(card.decisions),
        JSON.stringify(card.assumptions),
        card.draftMarkdown,
        card.latestReview ? JSON.stringify(card.latestReview) : null,
        card.createdAt,
        updatedAt,
      );
      return;
    }

    db.query(
      `UPDATE cards SET title=?2, summary=?3, area=?4, phase=?5, size=?6, write_paths_json=?7, depends_on_json=?8, column_name=?9, position=?10, goldfish_round=?11, goldfish_satisfied=?12, user_satisfied=?13, review_passed=?14, active_personas_json=?15, messages_json=?16, findings_json=?17, decisions_json=?18, assumptions_json=?19, draft_markdown=?20, latest_review_json=?21, updated_at=?22 WHERE id=?1`,
    ).run(
      card.id,
      card.title,
      card.summary,
      card.area,
      card.phase,
      card.size,
      JSON.stringify(card.writePaths),
      JSON.stringify(card.dependsOn),
      card.column,
      card.position,
      card.goldfishRound,
      card.goldfishSatisfied ? 1 : 0,
      card.userSatisfied ? 1 : 0,
      card.reviewPassed ? 1 : 0,
      JSON.stringify(card.activePersonas),
      JSON.stringify(card.messages),
      JSON.stringify(card.findings),
      JSON.stringify(card.decisions),
      JSON.stringify(card.assumptions),
      card.draftMarkdown,
      card.latestReview ? JSON.stringify(card.latestReview) : null,
      updatedAt,
    );
  }

  static listCards(
    db: Database,
    projectId: string,
    releaseId?: string,
  ): TableauCard[] {
    const rows = (releaseId
      ? db
          .query(
            `SELECT * FROM cards WHERE project_id = ?1 AND release_id = ?2 ORDER BY position ASC, created_at ASC`,
          )
          .all(projectId, releaseId)
      : db
          .query(
            `SELECT * FROM cards WHERE project_id = ?1 ORDER BY position ASC, created_at ASC`,
          )
          .all(projectId)) as Array<Record<string, unknown>>;
    return rows.map((r) => StoreRepository.mapCardRow(r));
  }

  static getCard(
    db: Database,
    projectId: string,
    cardId: string,
  ): TableauCard | null {
    const row = db
      .query(`SELECT * FROM cards WHERE id = ?1 AND project_id = ?2`)
      .get(cardId, projectId) as Record<string, unknown> | null;
    return row ? StoreRepository.mapCardRow(row) : null;
  }

  static mapCardRow(r: Record<string, unknown>): TableauCard {
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      releaseId: String(r.release_id),
      featureCode: String(r.feature_code),
      title: String(r.title),
      summary: String(r.summary),
      area: String(r.area),
      phase: String(r.phase),
      size: String(r.size) as "S" | "M" | "L",
      writePaths: JSON.parse(String(r.write_paths_json)) as string[],
      dependsOn: JSON.parse(String(r.depends_on_json)) as string[],
      column: String(r.column_name) as TableauColumn,
      position: Number(r.position),
      goldfishRound: Number(r.goldfish_round),
      goldfishSatisfied: Boolean(r.goldfish_satisfied),
      userSatisfied: Boolean(r.user_satisfied),
      reviewPassed: Boolean(r.review_passed),
      activePersonas: JSON.parse(String(r.active_personas_json)) as GoldfishPersonaId[],
      messages: JSON.parse(String(r.messages_json)),
      findings: JSON.parse(String(r.findings_json)),
      decisions: JSON.parse(String(r.decisions_json)),
      assumptions: JSON.parse(String(r.assumptions_json)),
      draftMarkdown: String(r.draft_markdown),
      latestReview: r.latest_review_json
        ? (JSON.parse(String(r.latest_review_json)) as AutomatedReviewReport)
        : null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  static listReleases(db: Database, projectId: string): ReleaseRecord[] {
    const rows = db
      .query(
        `SELECT * FROM releases WHERE project_id = ?1 ORDER BY created_at DESC, rowid DESC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const counts = db
        .query(
          `SELECT COUNT(*) as total, SUM(CASE WHEN column_name = 'validated' THEN 1 ELSE 0 END) as valid_cnt FROM cards WHERE release_id = ?1`,
        )
        .get(String(r.id)) as { total: number; valid_cnt: number | null };
      const snapCards = r.cards_snapshot_json
        ? (JSON.parse(String(r.cards_snapshot_json)) as TableauCard[])
        : null;
      return {
        id: String(r.id),
        projectId: String(r.project_id),
        version: String(r.version),
        title: String(r.title),
        notes: String(r.notes),
        status: String(r.status) as "active" | "sealed",
        bumpKind: r.bump_kind
          ? (String(r.bump_kind) as "major" | "minor" | "patch")
          : null,
        riskScore: r.risk_score !== null ? Number(r.risk_score) : null,
        sealedDigest: r.sealed_digest ? String(r.sealed_digest) : null,
        approvalSignature: r.approval_signature
          ? String(r.approval_signature)
          : null,
        axiomSnapshotJson: r.axiom_snapshot_json
          ? (JSON.parse(String(r.axiom_snapshot_json)) as Record<string, unknown>)
          : null,
        observabilityManifestJson: r.observability_manifest_json
          ? (JSON.parse(String(r.observability_manifest_json)) as Record<
              string,
              unknown
            >)
          : null,
        cardsCount: snapCards ? snapCards.length : Number(counts?.total ?? 0),
        validatedCount: snapCards
          ? snapCards.filter((c) => c.column === "validated").length
          : Number(counts?.valid_cnt ?? 0),
        createdAt: String(r.created_at),
        sealedAt: r.sealed_at ? String(r.sealed_at) : null,
      };
    });
  }

  static getReleaseCardsSnapshot(
    db: Database,
    releaseId: string,
  ): TableauCard[] {
    const r = db
      .query(`SELECT status, cards_snapshot_json FROM releases WHERE id = ?1`)
      .get(releaseId) as {
      status: string;
      cards_snapshot_json: string | null;
    } | null;
    if (!r) return [];
    if (r.cards_snapshot_json) {
      return JSON.parse(r.cards_snapshot_json) as TableauCard[];
    }
    const rows = db
      .query(`SELECT * FROM cards WHERE release_id = ?1 ORDER BY position ASC`)
      .all(releaseId) as Array<Record<string, unknown>>;
    return rows.map((row) => StoreRepository.mapCardRow(row));
  }

  /** Collect cumulative validated feature cards across prior sealed releases (chronological). */
  static listCumulativeSealedCards(
    db: Database,
    projectId: string,
  ): TableauCard[] {
    const rows = db
      .query(
        `SELECT cards_snapshot_json FROM releases WHERE project_id = ?1 AND status = 'sealed' ORDER BY sealed_at ASC, rowid ASC`,
      )
      .all(projectId) as Array<{ cards_snapshot_json: string | null }>;
    const byFeature = new Map<string, TableauCard>();
    for (const r of rows) {
      if (!r.cards_snapshot_json) continue;
      const cards = JSON.parse(r.cards_snapshot_json) as TableauCard[];
      for (const c of cards) {
        byFeature.set(c.featureCode, c);
      }
    }
    return [...byFeature.values()];
  }

  static updateActiveReleaseMeta(
    db: Database,
    projectId: string,
    releaseId: string,
    title: string,
    version: string,
    notes: string,
  ): void {
    const cleanVer = version.replace(/^v/i, "");
    const now = new Date().toISOString();
    db.query(
      `UPDATE releases SET title = ?1, version = ?2, notes = ?3 WHERE id = ?4 AND project_id = ?5 AND status = 'active'`,
    ).run(title.trim(), cleanVer, notes.trim(), releaseId, projectId);
    db.query(
      `UPDATE projects SET active_release_title = ?1, active_release_version = ?2, updated_at = ?3 WHERE id = ?4`,
    ).run(title.trim(), cleanVer, now, projectId);
  }

  static sealReleaseAndAdvance(
    db: Database,
    params: {
      projectId: string;
      currentReleaseId: string;
      bumpKind: "major" | "minor" | "patch";
      riskScore: number;
      sealedDigest: string;
      approvalSignature: string | null;
      axiomSnapshotJson: Record<string, unknown>;
      observabilityManifestJson: Record<string, unknown>;
      cardsSnapshot: TableauCard[];
      nextTitle: string;
      nextVersion: string;
      releaseNotes?: string | null;
      cleanValidatedCards: boolean;
    },
  ): { sealedReleaseId: string; nextReleaseId: string } {
    const now = new Date().toISOString();
    const nextReleaseId = `rel_${randomUUID()}`;
    const cleanNextVer = params.nextVersion.replace(/^v/i, "");

    // Sealing and advancing is one step: a failure halfway must not leave two active sheets.
    db.transaction(() => {
      db.query(
        `UPDATE releases SET status = 'sealed', bump_kind = ?1, risk_score = ?2, sealed_digest = ?3, approval_signature = ?4, axiom_snapshot_json = ?5, observability_manifest_json = ?6, cards_snapshot_json = ?7, sealed_at = ?8, notes = COALESCE(?10, notes) WHERE id = ?9`,
      ).run(
        params.bumpKind,
        params.riskScore,
        params.sealedDigest,
        params.approvalSignature,
        JSON.stringify(params.axiomSnapshotJson),
        JSON.stringify(params.observabilityManifestJson),
        JSON.stringify(params.cardsSnapshot),
        now,
        params.currentReleaseId,
        params.releaseNotes?.trim() || null,
      );

      if (params.cleanValidatedCards) {
        db.query(
          `UPDATE cards SET column_name = 'archived', updated_at = ?1 WHERE release_id = ?2 AND column_name = 'validated'`,
        ).run(now, params.currentReleaseId);
        // Carry forward unvalidated cards (idea / in-interview / review) into next active release
        db.query(
          `UPDATE cards SET release_id = ?1, updated_at = ?2 WHERE release_id = ?3 AND column_name != 'archived'`,
        ).run(nextReleaseId, now, params.currentReleaseId);
      } else {
        db.query(
          `UPDATE cards SET release_id = ?1, updated_at = ?2 WHERE release_id = ?3`,
        ).run(nextReleaseId, now, params.currentReleaseId);
      }

      db.query(
        `INSERT INTO releases (id, project_id, version, title, notes, status, bump_kind, risk_score, sealed_digest, approval_signature, axiom_snapshot_json, observability_manifest_json, cards_snapshot_json, created_at, sealed_at)
         VALUES (?1, ?2, ?3, ?4, '', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?5, NULL)`,
      ).run(nextReleaseId, params.projectId, cleanNextVer, params.nextTitle.trim(), now);

      db.query(
        `UPDATE projects SET active_release_id = ?1, active_release_version = ?2, active_release_title = ?3, updated_at = ?4 WHERE id = ?5`,
      ).run(
        nextReleaseId,
        cleanNextVer,
        params.nextTitle.trim(),
        now,
        params.projectId,
      );
    })();

    return { sealedReleaseId: params.currentReleaseId, nextReleaseId };
  }

  static insertBuilderFeedback(
    db: Database,
    input: {
      projectId: string;
      featureCode: string;
      status: string;
      detail: string;
      artifactDigest: string | null;
    },
  ): void {
    db.query(
      `INSERT INTO builder_feedback (id, project_id, feature_code, status, detail, artifact_digest, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).run(
      `fb_${randomUUID()}`,
      input.projectId,
      input.featureCode,
      input.status,
      input.detail,
      input.artifactDigest,
      new Date().toISOString(),
    );
  }
}
