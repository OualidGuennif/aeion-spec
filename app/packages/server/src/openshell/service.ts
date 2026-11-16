// Spec: knowledge/components/openshell.md

import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  MAX_UPLOAD_BYTES,
  type OpenShellScanSummary,
  type SessionMode,
} from "@aeion-spec/shared";
import { inviteWorkspaceExists } from "../db/repository.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
const PYTHON_BIN = resolve(REPO_ROOT, ".venv/bin/python");
const QUARANTINE_PY = resolve(REPO_ROOT, "app/openshell/quarantine.py");
const SANDBOX_PY = resolve(REPO_ROOT, "app/openshell/sandbox.py");
const PERSISTENT_WORKSPACES = resolve(
  REPO_ROOT,
  "app/.aeion/openshell/workspaces",
);

interface QuarantineResult {
  totalBytes: number;
  fileCount: number;
  quarantinedCount: number;
  redactedSecretsCount: number;
  rejectedEntries: string[];
  rootDigest: string;
  files: Record<string, string>;
}

interface ProbeResult {
  mode: "openshell" | "docker-hardened" | "quarantine-readonly";
  openshellGatewayReady: boolean;
  dockerReady: boolean;
  networkMode: "none";
  landlockActive: boolean;
}

// Volatile in-memory workspace storage keyed by projectId.
// Used for invite sessions (never persisted to disk) and fast read-only slice queries.
const snapshotRegistry = new Map<
  string,
  {
    sessionMode: SessionMode;
    ownerSessionId: string;
    files: Record<string, string>;
    summary: OpenShellScanSummary;
  }
>();

// The GitHub clone alone may take 90 s; the walk and the scrub get the rest.
const HELPER_TIMEOUT_MS = 180_000;

async function runPythonScript<T>(
  script: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const proc = Bun.spawn([PYTHON_BIN, script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  // A hostile archive can keep the helper decompressing; past the deadline it is killed, never awaited.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, HELPER_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(deadline));
  if (timedOut) {
    throw new Error(`OpenShell helper stopped after ${HELPER_TIMEOUT_MS / 1000} s.`);
  }
  if (code !== 0 && !stdout.trim()) {
    throw new Error(`OpenShell helper failed (${code}): ${stderr}`);
  }
  const parsed = JSON.parse(stdout) as T & { error?: string };
  if (parsed && typeof parsed === "object" && "error" in parsed && parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed;
}

// The runtime does not change between requests; probing spawns Python, so reuse a recent answer.
const PROBE_TTL_MS = 30_000;
let probeCache: { at: number; result: Promise<ProbeResult> } | null = null;

export async function probeOpenShellRuntime(): Promise<ProbeResult> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.result;
  const result = runPythonScript<ProbeResult>(SANDBOX_PY, { action: "probe" });
  probeCache = { at: Date.now(), result };
  // A failed probe is not cached, so the next call retries.
  result.catch(() => {
    if (probeCache?.result === result) probeCache = null;
  });
  return result;
}

export async function readBoundedUploadBytes(
  file: Blob,
): Promise<Uint8Array> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new PayloadTooLargeError(
      `Upload size (${file.size} bytes) exceeds strict 100 MiB ceiling (${MAX_UPLOAD_BYTES} bytes).`,
    );
  }
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPLOAD_BYTES) {
        await reader.cancel("Exceeded 100 MiB upload ceiling");
        throw new PayloadTooLargeError(
          `Upload aborted at byte ${total}: exceeds strict 100 MiB ceiling.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function ingestUploadedArchive(params: {
  projectId: string;
  sessionMode: SessionMode;
  ownerSessionId: string;
  filename: string;
  archiveBytes: Uint8Array;
}): Promise<OpenShellScanSummary> {
  if (params.archiveBytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new PayloadTooLargeError("Archive exceeds strict 100 MiB ceiling.");
  }
  const tempDir = mkdtempSync(join(tmpdir(), "aeion-quarantine-"));
  try {
    const safeName = basename(params.filename).replace(/[^a-zA-Z0-9._-]/g, "_") || "upload.zip";
    const tempArchive = join(tempDir, safeName);
    writeFileSync(tempArchive, params.archiveBytes, { mode: 0o600 });
    const q = await runPythonScript<QuarantineResult>(QUARANTINE_PY, {
      action: "quarantine_archive",
      archivePath: tempArchive,
      filename: safeName,
    });
    return registerQuarantinedSource({
      projectId: params.projectId,
      sessionMode: params.sessionMode,
      ownerSessionId: params.ownerSessionId,
      sourceKind: "upload",
      quarantine: q,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function ingestGithubSource(params: {
  projectId: string;
  sessionMode: SessionMode;
  ownerSessionId: string;
  sourceKind: "github_public" | "github_private";
  repoUrl: string;
  githubToken?: string;
}): Promise<OpenShellScanSummary> {
  if (params.githubToken) {
    await verifyGithubTokenScope(params.repoUrl, params.githubToken);
  }
  const q = await runPythonScript<QuarantineResult>(QUARANTINE_PY, {
    action: "quarantine_github",
    repoUrl: params.repoUrl,
    token: params.githubToken ?? null,
  });
  return registerQuarantinedSource({
    projectId: params.projectId,
    sessionMode: params.sessionMode,
    ownerSessionId: params.ownerSessionId,
    sourceKind: params.sourceKind,
    quarantine: q,
  });
}

async function verifyGithubTokenScope(
  repoUrl: string,
  token: string,
): Promise<void> {
  const match = repoUrl
    .trim()
    .match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match) {
    throw new Error("Invalid GitHub URL format.");
  }
  if (process.env.AEION_SKIP_GITHUB_API === "1") return;
  const owner = match[1]!;
  const repo = match[2]!;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "aeion-spec-vault-check/0.3",
    },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub token could not read ${owner}/${repo} (HTTP ${res.status}). Ensure at least read-only Contents permission.`,
    );
  }
}

async function registerQuarantinedSource(params: {
  projectId: string;
  sessionMode: SessionMode;
  ownerSessionId: string;
  sourceKind: "upload" | "github_public" | "github_private";
  quarantine: QuarantineResult;
}): Promise<OpenShellScanSummary> {
  const { projectId, sessionMode, ownerSessionId, sourceKind, quarantine } = params;
  const probe =
    sessionMode === "invite"
      ? await probeOpenShellRuntime()
      : await runPythonScript<ProbeResult>(SANDBOX_PY, {
          action: "materialize",
          projectId,
          files: quarantine.files,
          rootDigest: quarantine.rootDigest,
        });

  const summary: OpenShellScanSummary = {
    sandboxName: `aeion-spec-${projectId.slice(0, 12)}`,
    mode: probe.mode,
    networkMode: "none",
    landlockActive: probe.landlockActive,
    sourceKind,
    totalBytes: quarantine.totalBytes,
    fileCount: quarantine.fileCount,
    quarantinedCount: quarantine.quarantinedCount,
    redactedSecretsCount: quarantine.redactedSecretsCount,
    rejectedEntries: quarantine.rejectedEntries,
    rootDigest: quarantine.rootDigest,
    qualifiedAt: new Date().toISOString(),
  };

  // Invite files live only in RAM; an authenticated workspace was just written to disk by materialize.
  if (sessionMode === "invite") {
    // The session may have ended while the quarantine ran; its teardown already cleared this registry.
    if (!inviteWorkspaceExists(ownerSessionId)) {
      throw new Error("The invite session ended during the import; nothing was kept.");
    }
    snapshotRegistry.set(projectId, {
      sessionMode,
      ownerSessionId,
      files: quarantine.files,
      summary,
    });
  } else {
    snapshotRegistry.delete(projectId);
  }
  return summary;
}

export function clearInviteSandboxes(ownerSessionId: string): void {
  for (const [projectId, entry] of snapshotRegistry.entries()) {
    if (entry.ownerSessionId === ownerSessionId) snapshotRegistry.delete(projectId);
  }
}

export function inviteSandboxCount(): number {
  return snapshotRegistry.size;
}

function memoryFile(projectId: string, relPath: string): string | undefined {
  const mem = snapshotRegistry.get(projectId);
  // Own keys only: a path like "constructor" must not resolve to an inherited property.
  return mem && Object.hasOwn(mem.files, relPath) ? mem.files[relPath] : undefined;
}

function diskFile(projectId: string, relPath: string): string | undefined {
  const baseDir = resolve(PERSISTENT_WORKSPACES, projectId);
  const wsPath = resolve(baseDir, relPath);
  if (wsPath.startsWith(`${baseDir}/`) && existsSync(wsPath) && lstatSync(wsPath).isFile()) {
    return readFileSync(wsPath, "utf8");
  }
  return undefined;
}

function walkPersistentWorkspace(projectId: string): string[] {
  const baseDir = resolve(PERSISTENT_WORKSPACES, projectId);
  if (!existsSync(baseDir)) return [];
  const results: string[] = [];
  const visit = (dir: string, relPrefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      if (st.isDirectory()) {
        visit(full, rel);
      } else if (st.isFile()) {
        results.push(rel);
      }
    }
  };
  visit(baseDir, "");
  return results;
}

export function listSandboxFiles(projectId: string): string[] {
  const mem = snapshotRegistry.get(projectId);
  if (mem) return Object.keys(mem.files).sort();
  return walkPersistentWorkspace(projectId);
}

export function readSandboxSlice(
  projectId: string,
  relPath: string,
  startLine = 1,
  endLine = 120,
): { path: string; content: string; totalLines: number } | null {
  const text = snapshotRegistry.has(projectId)
    ? memoryFile(projectId, relPath)
    : diskFile(projectId, relPath);
  if (text === undefined) return null;
  const lines = text.split("\n");
  const from = Math.max(1, startLine) - 1;
  const to = Math.min(lines.length, Math.max(from + 1, endLine));
  return {
    path: relPath,
    totalLines: lines.length,
    content: lines
      .slice(from, to)
      .map((l, i) => `${from + i + 1}: ${l}`)
      .join("\n"),
  };
}

export function searchSandboxFiles(
  projectId: string,
  pattern: string,
): Array<{ path: string; line: number; text: string }> {
  if (!pattern.trim()) return [];
  const q = pattern.toLowerCase();
  const hits: Array<{ path: string; line: number; text: string }> = [];
  const mem = snapshotRegistry.get(projectId);
  const paths = mem ? Object.keys(mem.files).sort() : walkPersistentWorkspace(projectId);
  for (const path of paths) {
    const text = mem ? memoryFile(projectId, path) : diskFile(projectId, path);
    if (text === undefined) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(q)) {
        hits.push({ path, line: i + 1, text: lines[i]!.slice(0, 160) });
        if (hits.length >= 40) return hits;
      }
    }
  }
  return hits;
}

export class PayloadTooLargeError extends Error {
  readonly status = 413;
}
