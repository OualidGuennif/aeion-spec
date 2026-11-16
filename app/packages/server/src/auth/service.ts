// Spec: knowledge/components/aeion-engine.md

import type { SessionUser } from "@aeion-spec/shared";
import {
  createInviteWorkspace,
  destroyInviteWorkspace,
  StoreRepository,
} from "../db/repository.ts";

export const SESSION_COOKIE_NAME = "aeion_session";

export function parseCookieHeader(
  header: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    // A malformed escape in someone else's cookie must not turn every request into an error.
    let val: string;
    try {
      val = decodeURIComponent(raw);
    } catch {
      continue;
    }
    if (key) out[key] = val;
  }
  return out;
}

export function extractSessionToken(headers: Headers): string | null {
  const cookies = parseCookieHeader(headers.get("cookie"));
  if (cookies[SESSION_COOKIE_NAME]) {
    return cookies[SESSION_COOKIE_NAME]!;
  }
  const custom = headers.get("x-aeion-session");
  if (custom && custom.trim().length > 0) return custom.trim();
  return null;
}

export function buildSessionCookieHeader(
  rawToken: string,
  maxAgeSeconds: number,
): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(
    rawToken,
  )}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

const PASSWORD_HASH_OPTIONS = { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 } as const;

// An unknown email still pays for one verification, so response time does not reveal which emails exist.
let dummyHashPromise: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= Bun.password.hash(crypto.randomUUID(), PASSWORD_HASH_OPTIONS);
  return dummyHashPromise;
}

export async function registerUser(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<{
  rawToken: string;
  user: SessionUser;
  builderTokenPlain: string;
}> {
  const existing = StoreRepository.findPersistentUserByEmail(input.email);
  if (existing) {
    throw new AuthConflictError("An account with this email already exists.");
  }
  const passwordHash = await Bun.password.hash(input.password, PASSWORD_HASH_OPTIONS);
  const { user, builderTokenPlain } = StoreRepository.createPersistentUser({
    email: input.email,
    displayName: input.displayName,
    passwordHash,
  });
  const { rawToken, session } = StoreRepository.createPersistentSession(user.id);
  return {
    rawToken,
    builderTokenPlain,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      mode: "authenticated",
      expiresAt: session.expiresAt,
      csrfToken: session.csrfToken,
      builderTokenPreview: user.builderTokenPreview,
    },
  };
}

export async function loginUser(input: {
  email: string;
  password: string;
}): Promise<{ rawToken: string; user: SessionUser }> {
  const existing = StoreRepository.findPersistentUserByEmail(input.email);
  const valid = await Bun.password.verify(
    input.password,
    existing?.passwordHash ?? (await dummyPasswordHash()),
  );
  if (!existing || !valid) {
    throw new UnauthorizedError("Invalid email or password.");
  }
  const { rawToken, session } = StoreRepository.createPersistentSession(
    existing.id,
  );
  return {
    rawToken,
    user: {
      id: existing.id,
      email: existing.email,
      displayName: existing.displayName,
      mode: "authenticated",
      expiresAt: session.expiresAt,
      csrfToken: session.csrfToken,
      builderTokenPreview: existing.builderTokenPreview,
    },
  };
}

export function startInviteSession(): {
  rawToken: string;
  user: SessionUser;
  builderTokenPlain: string;
} {
  const { rawSessionToken, builderTokenPlain, session, user } =
    createInviteWorkspace();
  return {
    rawToken: rawSessionToken,
    builderTokenPlain,
    user: {
      id: user.id,
      email: null,
      displayName: user.displayName,
      mode: "invite",
      expiresAt: session.expiresAt,
      csrfToken: session.csrfToken,
      builderTokenPreview: user.builderTokenPreview,
    },
  };
}

export function revokeSession(headers: Headers): void {
  const tok = extractSessionToken(headers);
  if (tok) StoreRepository.revokeSessionByRawToken(tok);
}

export function requireAuthContext(
  headers: Headers,
  options: { requireCsrf?: boolean } = {},
) {
  const tok = extractSessionToken(headers);
  if (!tok) {
    throw new UnauthorizedError("Authentication required.");
  }
  const ctx = StoreRepository.resolveSession(tok);
  if (!ctx) {
    throw new UnauthorizedError("Session expired or invalid.");
  }
  if (options.requireCsrf) {
    const aeionHdr = headers.get("x-aeion");
    const csrfHdr = headers.get("x-csrf-token");
    if (aeionHdr !== "1" || csrfHdr !== ctx.session.csrfToken) {
      throw new ForbiddenError(
        "Missing or invalid CSRF headers (X-Aeion: 1 and X-CSRF-Token).",
      );
    }
  }
  return ctx;
}

export function destroyInviteIfPresent(sessionId: string): boolean {
  return destroyInviteWorkspace(sessionId);
}

export class AuthConflictError extends Error {
  readonly status = 409;
}

export class UnauthorizedError extends Error {
  readonly status = 401;
}

export class ForbiddenError extends Error {
  readonly status = 403;
}
