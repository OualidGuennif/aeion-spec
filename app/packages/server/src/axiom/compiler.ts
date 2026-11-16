// Spec: knowledge/components/aeion-engine.md

import { resolve } from "node:path";
import type {
  Axiom03Report,
  ProjectRecord,
  ReleaseRecord,
  TableauCard,
} from "@aeion-spec/shared";

const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
const PYTHON_BIN = resolve(REPO_ROOT, ".venv/bin/python");
const ENGINE_PY = resolve(REPO_ROOT, "app/axiom03/engine.py");

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function padNum(index: number): string {
  return String(index).padStart(3, "0");
}

function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

function inferRiskBand(size: "S" | "M" | "L", area: string): {
  risk: "low" | "medium" | "high" | "critical";
  weightMinor: number;
} {
  if (area === "moderation" || area === "foundation" || area === "security") {
    return { risk: "high", weightMinor: 7500 };
  }
  if (size === "L") return { risk: "high", weightMinor: 6500 };
  if (size === "M") return { risk: "medium", weightMinor: 4000 };
  return { risk: "low", weightMinor: 2000 };
}

export function buildAxiom03Document(params: {
  project: ProjectRecord;
  release: Pick<ReleaseRecord, "version" | "title" | "notes">;
  cards: TableauCard[];
  previousRelease?: Pick<ReleaseRecord, "version" | "sealedDigest"> | null;
  previousSpec?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const { project, release, cards, previousRelease, previousSpec } = params;
  const activeCards = cards.filter((c) => c.column !== "archived");
  const version = normalizeVersion(release.version || "0.1.0");
  const slugNum = padNum(1);
  const projectId = `PROJECT-${slugNum}`;

  const previous =
    previousRelease && previousRelease.sealedDigest
      ? {
          version: normalizeVersion(previousRelease.version),
          spec_sha256: previousRelease.sealedDigest,
        }
      : null;

  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  let edgeSeq = 1;
  const addEdge = (
    from: string,
    relation: string,
    to: string,
    rationale: string,
  ) => {
    edges.push({
      id: `EDGE-${padNum(edgeSeq++)}`,
      from,
      relation,
      to,
      origin: "declared",
      rationale,
    });
  };

  nodes.push({
    id: "GOAL-001",
    kind: "Goal",
    revision: 1,
    status: "active",
    title: release.title || `${project.name} Release ${version}`,
    owner: "ACTOR-001",
    created_by: "ACTOR-001",
    source_ids: ["SRC-001"],
    data: {
      description:
        project.description ||
        `Deliver verified features for ${project.name} release ${version}.`,
      success_measure:
        "All must requirements pass AxiomSpec G01-G14 gates and Goldfish adversarial review.",
    },
  });

  const exportsList: string[] = [];

  const sortedCards = [...activeCards].sort((a, b) => {
    const an = Number(a.featureCode.match(/\d+/)?.[0] ?? 0);
    const bn = Number(b.featureCode.match(/\d+/)?.[0] ?? 0);
    return an - bn;
  });

  sortedCards.forEach((card, idx) => {
    const fcDigits = card.featureCode.match(/\d+/)?.[0];
    const featureNum = fcDigits ? Number(fcDigits) : idx + 1;
    const seq = 100 + featureNum;
    const reqId = `REQ-${padNum(seq)}`;
    const conId = `CON-${padNum(seq)}`;
    const scnPosId = `SCN-${padNum(seq * 2)}`;
    const scnNegId = `SCN-${padNum(seq * 2 + 1)}`;
    const testPosId = `TEST-${padNum(seq * 2)}`;
    const testNegId = `TEST-${padNum(seq * 2 + 1)}`;
    const band = inferRiskBand(card.size, card.area);
    const category =
      card.area === "moderation" || card.area === "security"
        ? "security"
        : card.area === "ops"
          ? "quality"
          : "functional";

    nodes.push({
      id: reqId,
      kind: "Requirement",
      revision: Math.max(1, card.goldfishRound + 1),
      status: "active",
      title: `${card.featureCode}: ${card.title}`,
      owner: "ACTOR-001",
      created_by: "ACTOR-002",
      source_ids: ["SRC-001"],
      data: {
        category,
        priority: "must",
        risk: band.risk,
        verification_mode: "mixed",
        pattern: "ubiquitous",
        conditions: [],
        trigger: null,
        feature: null,
        subject: card.area || "system",
        response: card.summary.slice(0, 1200),
        weight_minor: band.weightMinor,
        flag_id: null,
      },
    });
    exportsList.push(reqId);
    addEdge(reqId, "satisfies", "GOAL-001", `${card.featureCode} delivers release goal`);

    nodes.push({
      id: conId,
      kind: "Constraint",
      revision: 1,
      status: "active",
      title: `${card.featureCode} trust & failure boundary`,
      owner: "ACTOR-001",
      created_by: "ACTOR-002",
      source_ids: ["SRC-001"],
      data: {
        classification: {
          category: "technical",
          explicitness: "elicited",
          temporality: "predefined",
          strength: "hard",
        },
        scope: "linked",
        roles: ["enforcement", "verification"],
        representation: "review_protocol",
        environment_id: null,
        expression: null,
        review_protocol:
          card.findings.length > 0
            ? `Resolve & enforce: ${card.findings[0]!.challenge.slice(0, 400)}`
            : `Enforce fail-closed validation and narrow write_paths (${card.writePaths.join(", ") || "declared scope"})`,
        enforcement_binding_id: null,
        effective_from: null,
        effective_until: null,
        predicate_role: "review",
      },
    });
    addEdge(conId, "formalizes", reqId, "Formalizes invariant for feature requirement");

    nodes.push({
      id: scnPosId,
      kind: "Scenario",
      revision: 1,
      status: "active",
      title: `${card.featureCode} happy-path witness`,
      owner: "ACTOR-001",
      created_by: "ACTOR-002",
      source_ids: ["SRC-001"],
      data: {
        intent: "witness",
        environment_id: "ENV-001",
        given: { request_bytes: 1024 },
        event: `${card.featureCode.toLowerCase()}_valid_request`,
        expected: "Operation succeeds deterministically within declared write scope.",
        constraint_expectations: [{ constraint_id: conId, expected: true }],
      },
    });
    addEdge(scnPosId, "illustrates", reqId, "Positive witness scenario");

    nodes.push({
      id: scnNegId,
      kind: "Scenario",
      revision: 1,
      status: "active",
      title: `${card.featureCode} negative-control refusal`,
      owner: "ACTOR-001",
      created_by: "ACTOR-002",
      source_ids: ["SRC-001"],
      data: {
        intent: "counterexample",
        environment_id: "ENV-001",
        given: { request_bytes: 0 },
        event: `${card.featureCode.toLowerCase()}_unauthorized_or_invalid`,
        expected: "System fails closed cleanly without mutating protected state.",
        constraint_expectations: [{ constraint_id: conId, expected: false }],
      },
    });
    addEdge(scnNegId, "illustrates", reqId, "Negative control counterexample");

    nodes.push({
      id: testPosId,
      kind: "TestCase",
      revision: 1,
      status: "active",
      title: `Verify ${card.featureCode} positive witness`,
      owner: "ACTOR-001",
      created_by: "ACTOR-002",
      source_ids: ["SRC-001"],
      data: {
        level: "integration",
        oracle: "Valid request produces expected output digest and clean state delta.",
        state: "planned",
        runner: "aeion-observability-factory",
        negative: false,
        witness_scenario_ids: [scnPosId],
        flag_states: [],
      },
    });
    addEdge(testPosId, "verifies", reqId, "Verifies positive scenario");

    nodes.push({
      id: testNegId,
      kind: "TestCase",
      revision: 1,
      status: "active",
      title: `Verify ${card.featureCode} negative control`,
      owner: "ACTOR-001",
      created_by: "ACTOR-002",
      source_ids: ["SRC-001"],
      data: {
        level: "contract",
        oracle: "Malformed or unauthorized input fails closed with explicit refusal.",
        state: "planned",
        runner: "aeion-observability-factory",
        negative: true,
        witness_scenario_ids: [scnNegId],
        flag_states: [],
      },
    });
    addEdge(testNegId, "verifies", reqId, "Verifies negative control");

    card.decisions.forEach((dec, dIdx) => {
      const decId = `DEC-${padNum(featureNum * 100 + dIdx + 1)}`;
      nodes.push({
        id: decId,
        kind: "Decision",
        revision: 1,
        status: "active",
        title: dec.id,
        owner: "ACTOR-001",
        created_by: "ACTOR-002",
        source_ids: ["SRC-001"],
        data: {
          question: dec.question,
          options: dec.options.length > 0 ? dec.options : ["accept", "revise"],
          answer: dec.resolved
            ? (dec.answerText || dec.chosenOption || "resolved")
            : null,
          blocking: dec.blocking,
          rationale: dec.rationale || "Goldfish adversarial review decision",
        },
      });
      addEdge(decId, "governs", reqId, `Decision ${dec.id} governs ${card.featureCode}`);
    });

    card.assumptions.forEach((asm, aIdx) => {
      const asmId = `ASM-${padNum(featureNum * 100 + aIdx + 1)}`;
      nodes.push({
        id: asmId,
        kind: "Assumption",
        revision: 1,
        status: "active",
        title: asm.id,
        owner: "ACTOR-001",
        created_by: "ACTOR-002",
        source_ids: ["SRC-001"],
        data: {
          claim: asm.statement,
          validation_method: asm.evidenceNote || "Verify during factory gate check",
          state:
            asm.status === "confirmed"
              ? "validated"
              : asm.status === "rejected"
                ? "rejected"
                : "unverified",
          blocking: asm.riskIfFalse === "high",
        },
      });
      addEdge(reqId, "assumes", asmId, `Requirement assumes ${asm.id}`);
    });
  });

  if (activeCards.length === 0) {
    nodes.push({
      id: "REQ-001",
      kind: "Requirement",
      revision: 1,
      status: "active",
      title: `${project.name} baseline specification`,
      owner: "ACTOR-001",
      created_by: "ACTOR-002",
      source_ids: ["SRC-001"],
      data: {
        category: "functional",
        priority: "should",
        risk: "low",
        verification_mode: "manual",
        pattern: "ubiquitous",
        conditions: [],
        trigger: null,
        feature: null,
        subject: "workspace",
        response: "Maintain valid AxiomSpec 0.3 baseline even before feature cards are added.",
        weight_minor: 1000,
        flag_id: null,
      },
    });
    exportsList.push("REQ-001");
    addEdge("REQ-001", "satisfies", "GOAL-001", "Baseline goal trace");
  }

  if (previousSpec && Array.isArray(previousSpec.nodes)) {
    const prevById = new Map<string, Record<string, unknown>>();
    for (const prevNode of previousSpec.nodes as Record<string, unknown>[]) {
      if (typeof prevNode.id === "string") prevById.set(prevNode.id, prevNode);
    }
    for (const node of nodes) {
      const prev = prevById.get(String(node.id));
      if (!prev) continue;
      const prevRev = Number(prev.revision || 1);
      const prevSig = JSON.stringify({
        title: prev.title,
        status: prev.status,
        data: prev.data,
        source_ids: prev.source_ids,
      });
      const currSig = JSON.stringify({
        title: node.title,
        status: node.status,
        data: node.data,
        source_ids: node.source_ids,
      });
      node.revision = prevSig === currSig ? prevRev : Math.max(Number(node.revision || 1), prevRev + 1);
    }
  }

  return {
    format: "axiomspec/0.3",
    profile: "AX-CORE-0.3",
    release: {
      version,
      previous,
      compatibility: [],
    },
    project: {
      id: projectId,
      name: project.name,
      description: project.description || `${project.name} specification`,
      owner: "ACTOR-001",
      mode: "product",
      weight_minor_units: 100,
    },
    actors: [
      {
        id: "ACTOR-001",
        name: "Project Owner",
        type: "human_role",
        binding_status: "verified",
      },
      {
        id: "ACTOR-002",
        name: "aeion-spec-agent",
        type: "service",
        binding_status: "asserted",
      },
    ],
    approval: {
      policy: {
        low: { approvers: 0, methods: [] },
        medium: { approvers: 0, methods: [] },
        high: { approvers: 0, methods: [] },
        critical: { approvers: 0, methods: [] },
      },
      keys: [],
    },
    imports: [],
    exports: exportsList,
    sources: [
      {
        id: "SRC-001",
        type: project.sourceKind === "empty" ? "user_input" : "document",
        locator:
          project.sourceRef ||
          (project.sourceKind === "empty"
            ? "aeion-spec://greenfield"
            : `aeion-spec://${project.sourceKind}/${project.slug}`),
        capture_sha256:
          project.openshellSummary?.rootDigest ||
          sha256Hex(`${project.id}:${version}`),
        review_state: "reviewed",
      },
    ],
    environments: [
      {
        id: "ENV-001",
        title: "Execution environment",
        schema: {
          type: "object",
          properties: {
            request_bytes: { type: "integer", minimum: 0, maximum: 104857600 },
          },
          required: ["request_bytes"],
          additionalProperties: false,
        },
        units: [],
      },
    ],
    flags: [],
    nodes,
    edges,
    bindings: [],
    context_assets: [],
  };
}

async function runPythonEngine<T>(payload: Record<string, unknown>): Promise<T> {
  const proc = Bun.spawn([PYTHON_BIN, ENGINE_PY], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !stdout.trim()) {
    throw new Error(`axiom03 engine failed (${code}): ${stderr}`);
  }
  const parsed = JSON.parse(stdout) as T & { error?: string };
  if (parsed && typeof parsed === "object" && "error" in parsed && parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed;
}

export async function validateAxiom03Spec(
  spec: Record<string, unknown>,
  baseline?: Record<string, unknown> | null,
): Promise<Axiom03Report> {
  return runPythonEngine<Axiom03Report>({
    action: "validate_spec",
    spec,
    baseline: baseline ?? null,
  });
}

export async function compareAxiom03Releases(
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
): Promise<{
  report: Record<string, unknown>;
  recommendedBump: "major" | "minor" | "patch";
  riskScore: number;
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: string[];
  breakingChanges: string[];
}> {
  return runPythonEngine({
    action: "compare_releases",
    baseline,
    candidate,
  });
}

export async function signAndVerifyAxiom03Release(
  spec: Record<string, unknown>,
  baseline?: Record<string, unknown> | null,
  actorId = "ACTOR-001",
): Promise<{
  spec: Record<string, unknown>;
  specDigest: string;
  approvalBundle: Record<string, unknown>;
  verification: Record<string, unknown>;
  signature: string;
  publicKey: string;
}> {
  return runPythonEngine({
    action: "sign_and_verify",
    spec,
    baseline: baseline ?? null,
    actorId,
  });
}
