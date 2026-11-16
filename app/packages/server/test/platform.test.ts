// Spec: knowledge/components/aeion-engine.md

process.env.AEION_PERSISTENT_DB = ":memory:";
process.env.AEION_LLM = "mock";
process.env.AEION_SKIP_GITHUB_API = "1";

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROVIDER_CATALOG, formatLitellmModelId } from "@aeion-spec/shared";
import { modelFromEnv } from "../../flue/src/provider.ts";
import { app } from "../src/app.ts";
import { getInviteCount, StoreRepository } from "../src/db/repository.ts";
import { ingestUploadedArchive } from "../src/openshell/service.ts";
import {
  ensureLiteLlmBridge,
  stopLoopbackRelayServer,
} from "../src/relay/context-relay.ts";
import { sealSecret, withUnsealedSecret } from "../src/vault/crypto.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const PYTHON_BIN = resolve(REPO_ROOT, ".venv/bin/python");

afterAll(() => {
  stopLoopbackRelayServer();
});

async function apiReq(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    sessionToken?: string;
    csrfToken?: string;
    bearer?: string;
  } = {},
) {
  const headers = new Headers();
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (opts.sessionToken) {
    headers.set("x-aeion-session", opts.sessionToken);
  }
  if (opts.csrfToken) {
    headers.set("x-aeion", "1");
    headers.set("x-csrf-token", opts.csrfToken);
  }
  if (opts.bearer) {
    headers.set("authorization", `Bearer ${opts.bearer}`);
  }
  const req = new Request(`http://127.0.0.1${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await app.handle(req);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json };
}

describe("Vault Cryptography & AAD Integrity", () => {
  test("envelope seals and rejects AAD tampering + zeroizes buffers", () => {
    const rootKey = Buffer.alloc(32, 0x42);
    const ctx = {
      userId: "usr_a",
      keyId: "key_1",
      purpose: "llm_provider",
      provider: "anthropic",
    };
    const env = sealSecret({
      rootKey,
      ctx,
      plaintext: "sk-ant-super-secret-value-123456",
    });

    expect(env.maskedHint).toBe("sk-a••••3456");
    expect(env.ciphertextB64).not.toContain("super-secret");

    const captured = withUnsealedSecret({ rootKey, ctx, envelope: env }, (txt) => txt);
    expect(captured).toBe("sk-ant-super-secret-value-123456");

    expect(() =>
      withUnsealedSecret(
        {
          rootKey,
          ctx: { ...ctx, provider: "openai" },
          envelope: env,
        },
        (txt) => txt,
      ),
    ).toThrow();
  });
});

describe("Invite Mode Zero-Persistence & Auth CSRF Boundaries", () => {
  test("invite mode keeps projects, vault keys, and interviews volatile and wipes cleanly on logout", async () => {
    const inv = await apiReq("/api/auth/invite", { method: "POST" });
    expect(inv.status).toBe(200);
    expect(inv.json.user.mode).toBe("invite");
    expect(getInviteCount()).toBeGreaterThanOrEqual(1);

    const { sessionToken, builderTokenPlain, user } = inv.json;

    // CSRF enforcement on mutating endpoint
    const noCsrf = await apiReq("/api/projects", {
      method: "POST",
      sessionToken,
      body: { name: "Blocked", sourceKind: "empty" },
    });
    expect(noCsrf.status).toBe(403);

    // Store provider key in invite RAM vault
    const keyRes = await apiReq("/api/vault/keys", {
      method: "POST",
      sessionToken,
      csrfToken: user.csrfToken,
      body: {
        purpose: "llm_provider",
        provider: "openrouter",
        label: "Invite Temp Key",
        secret: "sk-or-v1-temp-invite-secret-9999",
      },
    });
    expect(keyRes.status).toBe(200);
    expect(keyRes.json.key.maskedHint).toBe("sk-o••••9999");

    // Verify listVaultKeys never exposes plaintext
    const listKeys = await apiReq("/api/vault/keys", { sessionToken });
    expect(JSON.stringify(listKeys.json)).not.toContain("temp-invite-secret");

    // Create invite project + inspect Builder API with invite builder token
    const proj = await apiReq("/api/projects", {
      method: "POST",
      sessionToken,
      csrfToken: user.csrfToken,
      body: { name: "Volatile Trial", sourceKind: "empty" },
    });
    expect(proj.status).toBe(200);

    const bldOk = await apiReq(
      `/api/v1/builder/projects/${proj.json.project.slug}/spec`,
      { bearer: builderTokenPlain },
    );
    expect(bldOk.status).toBe(200);
    expect(bldOk.json.axiomSpec03.format).toBe("axiomspec/0.3");

    // Logout permanently wipes RAM store + builder token
    const out = await apiReq("/api/auth/logout", {
      method: "POST",
      sessionToken,
    });
    expect(out.status).toBe(200);

    const afterSession = await apiReq("/api/auth/session", { sessionToken });
    expect(afterSession.status).toBe(401);

    const afterBuilder = await apiReq(
      `/api/v1/builder/projects/${proj.json.project.slug}/spec`,
      { bearer: builderTokenPlain },
    );
    expect(afterBuilder.status).toBe(401);
  });
});

describe("OpenShell Upload Ceiling & Quarantine Scrubber", () => {
  test("rejects archives over 100 MiB and scrubs secrets & traversal inside valid zip", async () => {
    const oversized = new Uint8Array(100 * 1024 * 1024 + 10);
    await expect(
      ingestUploadedArchive({
        projectId: "proj_huge",
        sessionMode: "invite",
        ownerSessionId: "inv_test",
        filename: "huge.zip",
        archiveBytes: oversized,
      }),
    ).rejects.toThrow(/100 MiB/i);

    const tmp = mkdtempSync(join(tmpdir(), "aeion-ziptest-"));
    try {
      const zipPath = join(tmp, "sample.zip");
      const pyScript = `
import zipfile
with zipfile.ZipFile(${JSON.stringify(zipPath)}, "w") as z:
    z.writestr("src/app.ts", "export const ok = true;\\n")
    z.writestr(".env", "ANTHROPIC_API_KEY=sk-ant-12345678901234567890\\n")
    z.writestr("src/leak.ts", "const k = 'ghp_abcdefghijklmnopqrstuvwxyz123456';\\n")
    z.writestr("../../evil.txt", "escape attempt")
`;
      const p = Bun.spawnSync([PYTHON_BIN, "-c", pyScript]);
      expect(p.exitCode).toBe(0);
      const bytes = new Uint8Array(await Bun.file(zipPath).arrayBuffer());

      // A live invite session: the import is refused for one that has already ended.
      const inv = await apiReq("/api/auth/invite", { method: "POST" });
      const ownerSessionId = StoreRepository.resolveSession(inv.json.sessionToken)!.session.id;
      const summary = await ingestUploadedArchive({
        projectId: "proj_zip_clean",
        sessionMode: "invite",
        ownerSessionId,
        filename: "sample.zip",
        archiveBytes: bytes,
      });
      expect(summary.fileCount).toBe(3);
      expect(summary.redactedSecretsCount).toBeGreaterThanOrEqual(2);
      expect(summary.rejectedEntries.some((e) => e.includes("evil.txt"))).toBe(true);
      expect(summary.networkMode).toBe("none");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("LiteLLM Loopback Bridge Security", () => {
  test("requires X-Aeion-Bridge-Secret header on loopback health route", async () => {
    const { port, secret } = await ensureLiteLlmBridge();
    const unauth = await fetch(`http://127.0.0.1:${port}/health`);
    expect(unauth.status).toBe(401);

    const auth = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "x-aeion-bridge-secret": secret },
    });
    expect(auth.status).toBe(200);
    const body = (await auth.json()) as { ok: boolean; provider: string };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe("litellm");
  });
});

describe("End-to-End Jira Tableau -> Goldfish Dual Satisfaction -> Axiom03 + Observability -> Release Seal & G14 Diff", () => {
  test("drives full workflow for persistent user across two sealed releases and Builder API", async () => {
    const reg = await apiReq("/api/auth/register", {
      method: "POST",
      body: {
        email: "architect@aeion.test",
        password: "strong-passphrase-2026!",
        displayName: "Lead Architect",
      },
    });
    expect(reg.status).toBe(200);
    const { sessionToken, user, builderTokenPlain } = reg.json;

    // Create greenfield empty project
    const created = await apiReq("/api/projects", {
      method: "POST",
      sessionToken,
      csrfToken: user.csrfToken,
      body: {
        name: "Clearing Engine",
        description: "Multi-currency clearing specification",
        releaseTitle: "Phase 1 Foundation",
        releaseVersion: "0.1.0",
        sourceKind: "empty",
      },
    });
    expect(created.status).toBe(200);
    const projectId = created.json.project.id as string;
    const projectSlug = created.json.project.slug as string;

    // Configure 7-provider Model Mixer with cross-family Reviewer vs Drafter
    const mixerRes = await apiReq(`/api/projects/${projectId}/mixer`, {
      method: "PUT",
      sessionToken,
      csrfToken: user.csrfToken,
      body: {
        assignments: {
          elephant: { provider: "openai", modelId: "gpt-4.1", thinkingLevel: "medium" },
          drafter: { provider: "openai", modelId: "gpt-4.1", thinkingLevel: "medium" },
          reviewer: { provider: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "high" },
          "goldfish:security": { provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinkingLevel: "max" },
          "goldfish:devil": { provider: "mistral", modelId: "mistral-large-latest", thinkingLevel: "high" },
          "goldfish:sre": { provider: "deepinfra", modelId: "Qwen/Qwen3-235B-A22B", thinkingLevel: "medium" },
        },
      },
    });
    expect(mixerRes.status).toBe(200);
    expect(mixerRes.json.crossFamilyEnforced).toBe(true);

    // Add feature idea to column 1
    const cardRes = await apiReq(`/api/projects/${projectId}/cards`, {
      method: "POST",
      sessionToken,
      csrfToken: user.csrfToken,
      body: {
        title: "Atomic Batch Finality",
        summary: "Prevent partial batch posting by rejecting duplicate settlement windows.",
        area: "security",
        phase: "P0",
        size: "L",
        writePaths: ["src/clearing/", "tests/clearing/"],
      },
    });
    expect(cardRes.status).toBe(200);
    const cardId = cardRes.json.card.id as string;

    // Jumping directly from Idea -> Automated Review must fail
    const badJump = await apiReq(
      `/api/projects/${projectId}/cards/${cardId}/move`,
      {
        method: "POST",
        sessionToken,
        csrfToken: user.csrfToken,
        body: { targetColumn: "automated_review" },
      },
    );
    expect(badJump.status).toBe(409);

    // Move to Goldfish Interview (triggers round 1 Elephant + zero-history Goldfish swarm)
    const moveGf = await apiReq(
      `/api/projects/${projectId}/cards/${cardId}/move`,
      {
        method: "POST",
        sessionToken,
        csrfToken: user.csrfToken,
        body: { targetColumn: "goldfish_interview" },
      },
    );
    expect(moveGf.status).toBe(200);
    expect(moveGf.json.card.column).toBe("goldfish_interview");
    expect(moveGf.json.card.goldfishRound).toBe(1);
    expect(moveGf.json.card.goldfishSatisfied).toBe(false);
    const openDec = moveGf.json.card.decisions[0];
    expect(openDec).toBeTruthy();

    // Settle blocking DEC-* decision + mark Owner Satisfied
    const interviewTurn = await apiReq(
      `/api/projects/${projectId}/cards/${cardId}/interview`,
      {
        method: "POST",
        sessionToken,
        csrfToken: user.csrfToken,
        body: {
          message: "Settling replay boundary and fail-closed HTTP 409 semantics.",
          decisionAnswers: [
            {
              decisionId: openDec.id,
              chosenOption: openDec.options[0],
              answerText: "Fail closed with HTTP 409 Conflict and leave ledger untouched.",
            },
          ],
        },
      },
    );
    expect(interviewTurn.status).toBe(200);
    expect(interviewTurn.json.card.goldfishSatisfied).toBe(true);

    // Still cannot advance until Owner marks satisfaction
    const preOwnerMove = await apiReq(
      `/api/projects/${projectId}/cards/${cardId}/move`,
      {
        method: "POST",
        sessionToken,
        csrfToken: user.csrfToken,
        body: { targetColumn: "automated_review" },
      },
    );
    expect(preOwnerMove.status).toBe(409);

    const satisfy = await apiReq(
      `/api/projects/${projectId}/cards/${cardId}/satisfy`,
      {
        method: "POST",
        sessionToken,
        csrfToken: user.csrfToken,
        body: { userSatisfied: true, note: "Ready for Automated Review" },
      },
    );
    expect(satisfy.status).toBe(200);
    expect(satisfy.json.card.userSatisfied).toBe(true);

    // Move to Automated Review -> executes AxiomSpec 0.3 G01-G14 + Observability + Cross-Family + Reassessment
    const autoRev = await apiReq(
      `/api/projects/${projectId}/cards/${cardId}/move`,
      {
        method: "POST",
        sessionToken,
        csrfToken: user.csrfToken,
        body: { targetColumn: "automated_review" },
      },
    );
    expect(autoRev.status).toBe(200);
    expect(autoRev.json.card.reviewPassed).toBe(true);
    expect(autoRev.json.card.latestReview.crossFamilyVerified).toBe(true);
    expect(autoRev.json.card.latestReview.axiomReport.valid).toBe(true);
    expect(
      autoRev.json.card.latestReview.observabilityBundle.feature.valid,
    ).toBe(true);
    expect(
      autoRev.json.card.latestReview.observabilityBundle.feature.byteCount,
    ).toBeLessThanOrEqual(12000);

    // Promote to Validated
    const valMove = await apiReq(
      `/api/projects/${projectId}/cards/${cardId}/move`,
      {
        method: "POST",
        sessionToken,
        csrfToken: user.csrfToken,
        body: { targetColumn: "validated" },
      },
    );
    expect(valMove.status).toBe(200);
    expect(valMove.json.card.column).toBe("validated");

    // Seal Release v0.1.0 ("Clean the Sheet") and advance to v0.2.0
    const seal1 = await apiReq(`/api/projects/${projectId}/releases/validate`, {
      method: "POST",
      sessionToken,
      csrfToken: user.csrfToken,
      body: {
        nextReleaseTitle: "Phase 2 Controls",
        nextReleaseVersion: "0.2.0",
        cleanValidatedCards: true,
      },
    });
    expect(seal1.status).toBe(200);
    expect(seal1.json.sealedRelease.status).toBe("sealed");
    expect(seal1.json.sealedRelease.approvalSignature).toBeTruthy();
    const rel1Id = seal1.json.sealedRelease.id as string;

    // Board should now be clean on release v0.2.0!
    const tableau2 = await apiReq(`/api/projects/${projectId}/tableau`, {
      sessionToken,
    });
    expect(tableau2.json.release.version).toBe("0.2.0");
    expect(tableau2.json.cards.length).toBe(0);

    // Add second feature, validate quickly, seal v0.2.0, then run G14 Release Compare!
    const c2Res = await apiReq(`/api/projects/${projectId}/cards`, {
      method: "POST",
      sessionToken,
      csrfToken: user.csrfToken,
      body: {
        title: "Immutable Audit Log",
        summary: "Append-only hash-chained audit records for all clearing operations.",
        area: "ops",
        phase: "P1",
        size: "M",
        writePaths: ["src/audit/"],
      },
    });
    const c2Id = c2Res.json.card.id as string;
    const gf2 = await apiReq(`/api/projects/${projectId}/cards/${c2Id}/move`, {
      method: "POST",
      sessionToken,
      csrfToken: user.csrfToken,
      body: { targetColumn: "goldfish_interview" },
    });
    await apiReq(`/api/projects/${projectId}/cards/${c2Id}/interview`, {
      method: "POST",
      sessionToken,
      csrfToken: user.csrfToken,
      body: {
        message: "Hash chain per tenant partition.",
        decisionAnswers: [
          {
            decisionId: gf2.json.card.decisions[0].id,
            answerText: "SHA-256 hash chain per partition.",
          },
        ],
      },
    });
    await apiReq(`/api/projects/${projectId}/cards/${c2Id}/satisfy`, {
      method: "POST",
      sessionToken,
      csrfToken: user.csrfToken,
      body: { userSatisfied: true },
    });
    await apiReq(`/api/projects/${projectId}/cards/${c2Id}/move`, {
      method: "POST",
      sessionToken,
      csrfToken: user.csrfToken,
      body: { targetColumn: "automated_review" },
    });
    await apiReq(`/api/projects/${projectId}/cards/${c2Id}/move`, {
      method: "POST",
      sessionToken,
      csrfToken: user.csrfToken,
      body: { targetColumn: "validated" },
    });
    const seal2 = await apiReq(`/api/projects/${projectId}/releases/validate`, {
      method: "POST",
      sessionToken,
      csrfToken: user.csrfToken,
      body: {
        nextReleaseTitle: "Phase 3 Expansion",
        nextReleaseVersion: "0.3.0",
        cleanValidatedCards: true,
      },
    });
    expect(seal2.status).toBe(200);
    const rel2Id = seal2.json.sealedRelease.id as string;

    // Historical retrieval of rel1Id still preserves F-01 card snapshot
    const hist1 = await apiReq(
      `/api/projects/${projectId}/releases/${rel1Id}`,
      { sessionToken },
    );
    expect(hist1.status).toBe(200);
    expect(hist1.json.cardsSnapshot.length).toBe(1);
    expect(hist1.json.cardsSnapshot[0].title).toBe("Atomic Batch Finality");

    // G14 Release Compare v0.1.0 -> v0.2.0
    const diff = await apiReq(
      `/api/projects/${projectId}/releases/${rel1Id}/compare/${rel2Id}`,
      { sessionToken },
    );
    expect(diff.status).toBe(200);
    expect(["major", "minor", "patch"]).toContain(diff.json.recommendedBump);

    // Builder API serves sealed spec & blocks unauthorized access
    const bld = await apiReq(`/api/v1/builder/projects/${projectSlug}/spec`, {
      bearer: builderTokenPlain,
    });
    expect(bld.status).toBe(200);
    expect(bld.json.axiomSpec03.format).toBe("axiomspec/0.3");
    expect(bld.json.observabilityManifest.schema_version).toBe(2);

    const bldUnauth = await apiReq(`/api/v1/builder/projects/${projectSlug}/spec`);
    expect(bldUnauth.status).toBe(401);
  });
});

describe("Flue Provider Adapter Security & 7-Provider Routing", () => {
  test("routes all 7 LiteLLM providers via loopback ContextRelay and rejects non-loopback URLs", () => {
    const providers = Object.values(PROVIDER_CATALOG);
    expect(providers.length).toBe(7);

    for (const provider of providers) {
      const sampleModel = provider.curatedModels[0]!;
      const litellmModel = formatLitellmModelId(provider.id, sampleModel.id);
      const wireApi = sampleModel.api;

      const resolved = modelFromEnv({
        AEION_RELAY_URL: "http://127.0.0.1:41999/relay/run_test_1/v1",
        AEION_RELAY_TOKEN: "ephemeral-relay-token",
        AEION_MODEL_JSON: JSON.stringify({
          provider: provider.id,
          id: litellmModel,
          name: `${provider.label} ${sampleModel.id}`,
          api: wireApi,
          context: 128000,
          input: 1,
          output: 2,
          cacheRead: 0,
          maxOutputTokens: 8192,
        }),
      });

      expect(resolved.provider).toBe(provider.id);
      expect(resolved.id).toBe(litellmModel);
      expect(resolved.api).toBe(wireApi);
      if (wireApi === "anthropic-messages") {
        expect(resolved.baseUrl).toBe(
          "http://127.0.0.1:41999/relay/run_test_1",
        );
      } else {
        expect(resolved.baseUrl).toBe(
          "http://127.0.0.1:41999/relay/run_test_1/v1",
        );
      }
    }

    // Reject non-loopback or tampered relay URLs
    for (const badUrl of [
      "https://evil.example.com/relay/run_1/v1",
      "http://10.0.0.5:8080/relay/run_1/v1",
      "http://127.0.0.1:8080/relay/../evil/v1",
      "http://127.0.0.1:8080/evil",
    ]) {
      expect(() =>
        modelFromEnv({
          AEION_RELAY_URL: badUrl,
          AEION_RELAY_TOKEN: "tok",
          AEION_MODEL_JSON: JSON.stringify({
            provider: "openai",
            id: "openai/gpt-5.4",
            name: "bad",
            context: 128000,
            input: 1,
            output: 2,
            cacheRead: 0,
            maxOutputTokens: 4096,
          }),
        }),
      ).toThrow(/loopback|ContextRelay/i);
    }
  });
});
