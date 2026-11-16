// Spec: knowledge/components/aeion-engine.md
// Regression tests for the 2026-11-16 review: each test names the defect it pins down.

process.env.AEION_PERSISTENT_DB = ":memory:";
process.env.AEION_LLM = "mock";
process.env.AEION_SKIP_GITHUB_API = "1";

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDefaultMixer, inferVendorFamily, type TableauCard } from "@aeion-spec/shared";
import { app } from "../src/app.ts";
import { parseCookieHeader } from "../src/auth/service.ts";
import { listSandboxFiles } from "../src/openshell/service.ts";
import { checkSubmission, readReviewVerdict } from "../src/relay/flue-runner.ts";
import { invalidateReview } from "../src/tableau/orchestrator.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const PYTHON_BIN = resolve(REPO_ROOT, ".venv/bin/python");

async function call(
  path: string,
  opts: { method?: string; body?: unknown; session?: string; csrf?: string; bearer?: string; cookie?: string } = {},
) {
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.session) headers.set("x-aeion-session", opts.session);
  if (opts.csrf) {
    headers.set("x-aeion", "1");
    headers.set("x-csrf-token", opts.csrf);
  }
  if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  const res = await app.handle(
    new Request(`http://127.0.0.1${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    // Plain text body.
  }
  return { status: res.status, json };
}

async function newUser(tag: string) {
  const reg = await call("/api/auth/register", {
    method: "POST",
    body: { email: `${tag}-${crypto.randomUUID()}@aeion.test`, password: "strong-passphrase-2026!", displayName: tag },
  });
  expect(reg.status).toBe(200);
  return {
    session: reg.json.sessionToken as string,
    csrf: reg.json.user.csrfToken as string,
    builder: reg.json.builderTokenPlain as string,
  };
}

async function newProject(u: { session: string; csrf: string }, name: string) {
  const res = await call("/api/projects", {
    method: "POST",
    session: u.session,
    csrf: u.csrf,
    body: { name, sourceKind: "empty", releaseVersion: "0.1.0" },
  });
  expect(res.status).toBe(200);
  return res.json.project as { id: string; slug: string };
}

describe("Automated reviewer fails closed", () => {
  test("no submission, a bad verdict or a non-object never approves", () => {
    expect(readReviewVerdict(undefined, "looks fine").verdict).toBe("revise");
    expect(readReviewVerdict({ verdict: "lgtm", summary: "ok" }, "").verdict).toBe("revise");
    expect(readReviewVerdict("approve", "").verdict).toBe("revise");
    expect(readReviewVerdict({ verdict: "approve", summary: "clean" }, "").verdict).toBe("approve");
    expect(readReviewVerdict({ verdict: "block" }, "x").verdict).toBe("block");
  });

  test("the relay re-checks submissions against the declared schema", () => {
    const schemas = {
      submit_review: {
        type: "object",
        required: ["verdict", "summary"],
        properties: { verdict: { type: "string", enum: ["approve", "revise", "block"] }, summary: { type: "string" } },
      },
    };
    expect(checkSubmission(schemas, "submit_review", { verdict: "approve", summary: "s" }).ok).toBe(true);
    expect(checkSubmission(schemas, "submit_review", { verdict: "maybe", summary: "s" }).ok).toBe(false);
    expect(checkSubmission(schemas, "submit_review", { verdict: "approve" }).ok).toBe(false);
    expect(checkSubmission(schemas, "submit_review", ["approve"]).ok).toBe(false);
    expect(checkSubmission(schemas, "submit_other", {}).ok).toBe(false);
    expect(checkSubmission({}, "ask_owner", { question: "?" }).ok).toBe(true);
  });
});

describe("HTTP error mapping", () => {
  test("unknown route is 404, a schema violation is a short 422", async () => {
    expect((await call("/api/does-not-exist")).status).toBe(404);
    const u = await newUser("errors");
    const bad = await call("/api/projects", {
      method: "POST",
      session: u.session,
      csrf: u.csrf,
      body: { name: "x", sourceKind: "nope" },
    });
    expect(bad.status).toBe(422);
    expect(String(bad.json.error).length).toBeLessThan(300);
  });

  test("a malformed cookie escape is ignored instead of failing the request", async () => {
    expect(parseCookieHeader("a=%E0%A4%A; b=ok")).toEqual({ b: "ok" });
    const res = await call("/api/auth/session", { cookie: "aeion_session=%E0%A4%A" });
    expect(res.status).toBe(401);
  });
});

describe("Projects and the builder API", () => {
  test("slugs are unique per owner and ?version accepts a leading v", async () => {
    const u = await newUser("slugs");
    const a = await newProject(u, "Clearing Engine");
    const b = await newProject(u, "Clearing Engine");
    expect(a.slug).toBe("clearing-engine");
    expect(b.slug).toBe("clearing-engine-2");

    const spec = await call(`/api/v1/builder/projects/${b.slug}/spec?version=v0.1.0`, { bearer: u.builder });
    expect(spec.status).toBe(200);
    expect(spec.json.release.version).toBe("0.1.0");
  });

  test("a key stored for another purpose is never sent, and the failed project is rolled back", async () => {
    const u = await newUser("vault");
    const key = await call("/api/vault/keys", {
      method: "POST",
      session: u.session,
      csrf: u.csrf,
      body: { purpose: "llm_provider", provider: "openai", label: "LLM", secret: "sk-test-not-a-github-token-0000" },
    });
    expect(key.status).toBe(200);
    const res = await call("/api/projects", {
      method: "POST",
      session: u.session,
      csrf: u.csrf,
      body: {
        name: "Private Repo",
        sourceKind: "github_private",
        sourceRef: "https://github.com/example/private-repo",
        githubVaultKeyId: key.json.key.id,
      },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("not a github_readonly key");
    const list = await call("/api/projects", { session: u.session });
    expect(list.json.projects).toHaveLength(0);
  });
});

describe("Model mixer defaults", () => {
  test("an OpenCode-only owner gets a cross-family mixer from that one key", () => {
    const mixer = buildDefaultMixer(["opencode-go"]);
    expect(mixer.elephant?.modelId).toBe("deepseek-v4.1-flash");
    expect(mixer.reviewer?.provider).toBe("opencode-go");
    expect(mixer.reviewer?.modelId).toBe("claude-haiku-5-5");
    expect(mixer.reviewer?.api).toBe("anthropic-messages");
    expect(inferVendorFamily("opencode-go", mixer.reviewer!.modelId)).not.toBe(
      inferVendorFamily("opencode-go", mixer.drafter!.modelId),
    );
  });

  test("without keys OpenAI drafts and current Claude reviews; every role is resolved", async () => {
    const mixer = buildDefaultMixer([]);
    expect(mixer.drafter?.provider).toBe("openai");
    expect(mixer.reviewer?.modelId).toBe("claude-sonnet-5-5");

    const u = await newUser("mixer");
    const p = await newProject(u, "Mixer Check");
    const cfg = await call(`/api/projects/${p.id}/mixer`, { session: u.session });
    expect(cfg.status).toBe(200);
    expect(Object.keys(cfg.json.effectiveAssignments)).toHaveLength(11);
    expect(cfg.json.crossFamilyEnforced).toBe(true);
  });
});

describe("Card lifecycle gates", () => {
  test("archived cards are read-only until restored to Idea", async () => {
    const u = await newUser("archive");
    const p = await newProject(u, "Archive Flow");
    const card = await call(`/api/projects/${p.id}/cards`, {
      method: "POST",
      session: u.session,
      csrf: u.csrf,
      body: { title: "Parked idea", summary: "A feature that is parked for a later release." },
    });
    const cardId = card.json.card.id as string;
    const move = (targetColumn: string) =>
      call(`/api/projects/${p.id}/cards/${cardId}/move`, {
        method: "POST",
        session: u.session,
        csrf: u.csrf,
        body: { targetColumn },
      });

    expect((await move("archived")).json.card.column).toBe("archived");
    const tableau = await call(`/api/projects/${p.id}/tableau`, { session: u.session });
    expect(tableau.json.cards).toHaveLength(0);
    expect(tableau.json.archivedCards).toHaveLength(1);

    const patch = await call(`/api/projects/${p.id}/cards/${cardId}`, {
      method: "PATCH",
      session: u.session,
      csrf: u.csrf,
      body: { title: "Edited while archived" },
    });
    expect(patch.status).toBe(409);
    expect((await move("goldfish_interview")).status).toBe(409);
    expect((await move("idea")).json.card.column).toBe("idea");
  });

  test("a direct review request is refused until the swarm and the owner are satisfied", async () => {
    const u = await newUser("review-gate");
    const p = await newProject(u, "Review Gate");
    const card = await call(`/api/projects/${p.id}/cards`, {
      method: "POST",
      session: u.session,
      csrf: u.csrf,
      body: { title: "Unapproved idea", summary: "A feature nobody has questioned or approved yet." },
    });
    const review = await call(`/api/projects/${p.id}/cards/${card.json.card.id}/review`, {
      method: "POST",
      session: u.session,
      csrf: u.csrf,
    });
    expect(review.status).toBe(409);
    expect(String(review.json.error)).toContain("satisfied");
  });

  test("changed content sends a reviewed or validated card back to the interview", () => {
    const card = { column: "validated", reviewPassed: true } as TableauCard;
    invalidateReview(card);
    expect(card.column).toBe("goldfish_interview");
    expect(card.reviewPassed).toBe(false);

    const idea = { column: "idea", reviewPassed: false } as TableauCard;
    invalidateReview(idea);
    expect(idea.column).toBe("idea");
  });

  test("a seal must move the version forward", async () => {
    const u = await newUser("seal");
    const p = await newProject(u, "Seal Order");
    const same = await call(`/api/projects/${p.id}/releases/validate`, {
      method: "POST",
      session: u.session,
      csrf: u.csrf,
      body: { nextReleaseTitle: "Again", nextReleaseVersion: "v0.1.0" },
    });
    expect(same.status).toBe(409);
    expect(same.json.error).toContain("must be greater");

    const forward = await call(`/api/projects/${p.id}/releases/validate`, {
      method: "POST",
      session: u.session,
      csrf: u.csrf,
      body: { nextReleaseTitle: "Next", nextReleaseVersion: "0.2.0" },
    });
    expect(forward.status).toBe(409);
    expect(forward.json.error).toContain("Validated column");
  });
});

describe("Invite sandboxes", () => {
  test("ending an invite session erases its quarantined files from RAM", async () => {
    const inv = await call("/api/auth/invite", { method: "POST" });
    const session = inv.json.sessionToken as string;
    const csrf = inv.json.user.csrfToken as string;
    const p = await newProject({ session, csrf }, "Invite Upload");

    const tmp = mkdtempSync(join(tmpdir(), "aeion-invite-zip-"));
    try {
      const zipPath = join(tmp, "src.zip");
      const made = Bun.spawnSync([
        PYTHON_BIN,
        "-c",
        `import zipfile\nwith zipfile.ZipFile(${JSON.stringify(zipPath)}, "w") as z:\n    z.writestr("src/a.ts", "export const a = 1;\\n")\n`,
      ]);
      expect(made.exitCode).toBe(0);
      const form = new FormData();
      form.set("archive", new File([await Bun.file(zipPath).arrayBuffer()], "src.zip"));
      const upload = await app.handle(
        new Request(`http://127.0.0.1/api/projects/${p.id}/source/upload`, {
          method: "POST",
          headers: { "x-aeion-session": session, "x-aeion": "1", "x-csrf-token": csrf },
          body: form,
        }),
      );
      expect(upload.status).toBe(200);
      expect(listSandboxFiles(p.id)).toContain("src/a.ts");

      await call("/api/auth/logout", { method: "POST", session });
      expect(listSandboxFiles(p.id)).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
