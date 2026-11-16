// Spec: knowledge/components/aeion-engine.md

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import {
  formatLitellmModelId,
  PROVIDER_CATALOG,
  type AgentRoleId,
  type LlmProviderId,
} from "@aeion-spec/shared";
import { StoreRepository, type StoredUserRecord } from "../db/repository.ts";
import {
  listSandboxFiles,
  readSandboxSlice,
  searchSandboxFiles,
} from "../openshell/service.ts";
import type { Database } from "bun:sqlite";

const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
const PYTHON_BIN = resolve(REPO_ROOT, ".venv/bin/python");
const LITELLM_BRIDGE_PY = resolve(
  REPO_ROOT,
  "app/packages/server/src/relay/litellm_bridge.py",
);

const MAX_RELAY_BODY_BYTES = 240_000;
const MAX_TURNS_PER_RUN = 16;

export interface ActiveRelayRun {
  runId: string;
  token: string;
  userId: string;
  projectId: string;
  role: AgentRoleId;
  provider: LlmProviderId;
  modelId: string;
  turns: number;
  recentHashes: string[];
  submissions: Map<string, unknown>;
  submissionsValidator?: (name: string, payload: unknown) => { ok: boolean; error?: string };
  createdAtMs: number;
  ctx: {
    db: Database;
    rootKey: Buffer;
    user: StoredUserRecord;
  };
}

const activeRuns = new Map<string, ActiveRelayRun>();
let bridgePort: number | null = null;
let bridgeSecret: string | null = null;
let bridgeProc: ReturnType<typeof Bun.spawn> | null = null;
let bridgeBootPromise: Promise<{ port: number; secret: string }> | null = null;

// The bridge gets the upstream key per request; ambient provider keys must never reach it.
const BRIDGE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
];

function bridgeEnv(secret: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BRIDGE_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  env.AEION_LITELLM_BRIDGE_SECRET = secret;
  env.LITELLM_LOG = "ERROR";
  return env;
}

// A pipe nobody reads fills up and stalls the child; keep only a short tail for diagnostics.
let bridgeStderrTail = "";
async function drainStream(stream: ReadableStream<Uint8Array>, keepTail: boolean): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (keepTail) bridgeStderrTail = (bridgeStderrTail + decoder.decode(value, { stream: true })).slice(-2000);
    }
  } catch {
    // The child exited; nothing left to read.
  }
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
  const remaining = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("LiteLLM bridge gave no ready signal in time.")), remaining);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function constantTimeMatch(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function ensureLiteLlmBridge(): Promise<{
  port: number;
  secret: string;
}> {
  if (bridgePort !== null && bridgeSecret !== null) {
    return { port: bridgePort, secret: bridgeSecret };
  }
  if (bridgeBootPromise) return bridgeBootPromise;

  bridgeBootPromise = (async () => {
    const secret = randomBytes(32).toString("hex");
    const proc = Bun.spawn([PYTHON_BIN, LITELLM_BRIDGE_PY], {
      env: bridgeEnv(secret),
      stdout: "pipe",
      stderr: "pipe",
    });
    bridgeProc = proc;
    void drainStream(proc.stderr, true);

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 12_000;
    let port: number | null = null;
    // Wait for the one JSON ready line; libraries may print other lines first.
    while (port === null) {
      const { done, value } = await readWithDeadline(reader, deadline);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1 && port === null) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        try {
          const meta = JSON.parse(line) as { ready?: boolean; port?: number };
          if (meta.ready && meta.port) port = meta.port;
        } catch {
          // Not the ready line.
        }
        nl = buffer.indexOf("\n");
      }
    }
    reader.releaseLock();
    if (port === null) {
      throw new Error(`LiteLLM bridge exited before it was ready. ${bridgeStderrTail.slice(-300)}`.trim());
    }
    void drainStream(proc.stdout, false);

    // Poll /health until uvicorn listens, pausing between attempts either way.
    for (let i = 0; i < 40; i++) {
      try {
        const h = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { "x-aeion-bridge-secret": secret },
        });
        if (h.ok) {
          bridgePort = port;
          bridgeSecret = secret;
          return { port, secret };
        }
      } catch {
        // Not listening yet.
      }
      await Bun.sleep(100);
    }
    throw new Error("LiteLLM loopback bridge did not become healthy in time.");
  })();

  try {
    return await bridgeBootPromise;
  } catch (err) {
    stopLiteLlmBridge();
    throw err;
  }
}

export function stopLiteLlmBridge(): void {
  if (bridgeProc) {
    try {
      bridgeProc.kill();
    } catch {
      // Ignore cleanup errors
    }
    bridgeProc = null;
  }
  bridgePort = null;
  bridgeSecret = null;
  bridgeBootPromise = null;
}

export function registerRelayRun(params: {
  userId: string;
  projectId: string;
  role: AgentRoleId;
  provider: LlmProviderId;
  modelId: string;
  ctx: { db: Database; rootKey: Buffer; user: StoredUserRecord };
  submissionsValidator?: (name: string, payload: unknown) => { ok: boolean; error?: string };
}): ActiveRelayRun {
  const runId = `run_${randomBytes(12).toString("hex")}`;
  const token = randomBytes(24).toString("hex");
  const run: ActiveRelayRun = {
    runId,
    token,
    userId: params.userId,
    projectId: params.projectId,
    role: params.role,
    provider: params.provider,
    modelId: params.modelId,
    turns: 0,
    recentHashes: [],
    submissions: new Map(),
    submissionsValidator: params.submissionsValidator,
    createdAtMs: Date.now(),
    ctx: params.ctx,
  };
  activeRuns.set(runId, run);
  return run;
}

export function releaseRelayRun(runId: string): void {
  activeRuns.delete(runId);
}

export function getRelayRun(runId: string, bearerToken: string | null): ActiveRelayRun {
  const run = activeRuns.get(runId);
  if (!run) {
    throw new RelayAuthError(404, "Unknown relay run id.");
  }
  const token = bearerToken?.replace(/^Bearer\s+/i, "").trim() || "";
  if (!constantTimeMatch(token, run.token)) {
    throw new RelayAuthError(401, "Invalid ephemeral relay token.");
  }
  return run;
}

export async function handleRelayChatCompletion(params: {
  run: ActiveRelayRun;
  rawBody: Uint8Array;
  endpoint: "/v1/chat/completions" | "/v1/messages";
}): Promise<Response> {
  const { run, rawBody, endpoint } = params;
  if (rawBody.byteLength > MAX_RELAY_BODY_BYTES) {
    return Response.json(
      { error: `Relay payload exceeds ${MAX_RELAY_BODY_BYTES} byte safety bound.` },
      { status: 413 },
    );
  }
  run.turns += 1;
  if (run.turns > MAX_TURNS_PER_RUN) {
    return Response.json(
      { error: `Relay turn cap (${MAX_TURNS_PER_RUN}) exceeded.` },
      { status: 429 },
    );
  }
  const digest = createHash("sha256").update(rawBody).digest("hex");
  if (run.recentHashes.slice(-2).filter((h) => h === digest).length >= 2) {
    return Response.json(
      { error: "Duplicate-request loop guard tripped by ContextRelay." },
      { status: 429 },
    );
  }
  run.recentHashes.push(digest);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8")) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Relay body is not valid JSON." }, { status: 400 });
  }
  // Force server-assigned provider + model so untrusted prompts cannot redirect billing or models
  const litellmModel = formatLitellmModelId(run.provider, run.modelId);
  parsed.model = litellmModel;

  const { port, secret } = await ensureLiteLlmBridge();

  const upstreamReq = StoreRepository.withProviderSecret(
    run.ctx,
    { purpose: "llm_provider", provider: run.provider },
    (upstreamKey) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-aeion-bridge-secret": secret,
        "x-aeion-upstream-key": upstreamKey,
        "x-aeion-session-id": run.runId,
      };
      return fetch(`http://127.0.0.1:${port}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(parsed),
      });
    },
  );
  const upstreamResp = await upstreamReq;
  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: {
      "content-type":
        upstreamResp.headers.get("content-type") || "application/json",
    },
  });
}

let loopbackServer: ReturnType<typeof Bun.serve> | null = null;

export function ensureLoopbackRelayServer(): number {
  if (loopbackServer) return loopbackServer.port!;
  loopbackServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/relay\/([^/]+)(\/v1\/chat\/completions|\/v1\/messages|\/bridge\/tool)$/);
      if (!match) {
        return new Response("Not Found", { status: 404 });
      }
      const runId = match[1]!;
      const subpath = match[2]!;
      try {
        const run = getRelayRun(runId, req.headers.get("authorization"));
        if (subpath === "/bridge/tool") {
          const payload = (await req.json()) as { name?: string; input?: Record<string, unknown> };
          const res = await handleRelayToolCall({
            run,
            toolName: String(payload.name || ""),
            input: payload.input || {},
          });
          return Response.json(res, { status: res.error ? 400 : 200 });
        }
        const rawBody = new Uint8Array(await req.arrayBuffer());
        return await handleRelayChatCompletion({
          run,
          rawBody,
          endpoint: subpath as "/v1/chat/completions" | "/v1/messages",
        });
      } catch (err) {
        if (err instanceof RelayAuthError) {
          return Response.json({ error: err.message }, { status: err.status });
        }
        return Response.json(
          { error: err instanceof Error ? err.message : "Relay error" },
          { status: 500 },
        );
      }
    },
  });
  return loopbackServer.port!;
}

export function stopLoopbackRelayServer(): void {
  if (loopbackServer) {
    loopbackServer.stop(true);
    loopbackServer = null;
  }
  stopLiteLlmBridge();
}

export async function handleRelayToolCall(params: {
  run: ActiveRelayRun;
  toolName: string;
  input: Record<string, unknown>;
}): Promise<{ output: unknown; terminate?: boolean; error?: string }> {
  const { run, toolName, input } = params;

  if (toolName === "list_sandbox_files") {
    const prefix = typeof input.prefix === "string" ? input.prefix : "";
    const all = listSandboxFiles(run.projectId);
    const filtered = prefix ? all.filter((p) => p.startsWith(prefix)) : all;
    return { output: filtered.slice(0, 200) };
  }
  if (toolName === "read_sandbox_slice") {
    const path = String(input.path || "");
    const slice = readSandboxSlice(
      run.projectId,
      path,
      Number(input.startLine ?? 1),
      Math.min(Number(input.startLine ?? 1) + 119, Number(input.endLine ?? 120)),
    );
    if (!slice) return { error: `File not accessible in sandbox: ${path}`, output: null };
    return { output: slice };
  }
  if (toolName === "search_sandbox_files") {
    return { output: searchSandboxFiles(run.projectId, String(input.query || "")) };
  }

  // A submission is stored only after the server's own check of its declared schema.
  if (run.submissionsValidator) {
    const verdict = run.submissionsValidator(toolName, input);
    if (!verdict.ok) {
      return { output: null, error: verdict.error || "Submission rejected by validator." };
    }
  }
  run.submissions.set(toolName, input);
  const shouldTerminate = toolName.startsWith("submit_") || toolName === "ask_owner";
  return {
    output: { accepted: true, tool: toolName },
    terminate: shouldTerminate,
  };
}

export class RelayAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
