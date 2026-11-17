// Spec: knowledge/components/aeion-engine.md

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OBSERVABILITY_MAX_BYTES,
  validateRelativeWritePaths,
  type ObservabilityExportBundle,
  type ObservabilityFeatureValidation,
  type ProjectRecord,
  type ReleaseRecord,
  type TableauCard,
} from "@aeion-spec/shared";

interface ExportProfile {
  max_bytes: number;
  frontmatter: Record<string, unknown>;
  frontmatter_order: string[];
  data_sources_text: string;
  outputs_text: string;
  invariants_text: string;
  determinism_text: string;
}

interface TargetProfile {
  product: string;
  areas: string[];
  phases: string[];
  sizes: string[];
  write_prefixes: string[];
  default_write_paths: string[];
  delivery_steps: [number, number];
  delivery_max_chars: number;
  superseded_stack: string;
}

const PROFILES_DIR = resolve(import.meta.dir, "../../profiles");
const DEFAULT_EXPORT: ExportProfile = JSON.parse(
  readFileSync(resolve(PROFILES_DIR, "aeion-observability.json"), "utf8"),
);
const DEFAULT_TARGET: TargetProfile = JSON.parse(
  readFileSync(resolve(PROFILES_DIR, "aeion-observability-target.json"), "utf8"),
);

export const REQUIRED_SECTIONS = [
  "Intent",
  "Data Sources",
  "Outputs",
  "Constraints & Invariants",
  "Determinism & Security",
  "Interfaces & Write Scope",
  "Verification",
  "Delivery Steps",
] as const;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "feature";
}

function sha256Hex(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function yamlValue(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `\n${v.map((item) => `  - ${JSON.stringify(String(item))}`).join("\n")}`;
  }
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(String(v));
}

function clampStep(step: string, maxChars: number): string {
  const singleLine = step.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  const cut = singleLine.slice(0, maxChars - 3);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

function trimBoundary(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const bounded = (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
  return /[.!?]$/.test(bounded) ? bounded : `${bounded}.`;
}

export function buildFeatureMarkdown(params: {
  project: ProjectRecord;
  release: Pick<ReleaseRecord, "version" | "title">;
  card: TableauCard;
  sequence: number;
}): string {
  const { project, release, card, sequence } = params;
  const isObservabilityAgoraTarget =
    project.slug === "agora" ||
    project.slug.includes("observability-agora") ||
    (project.sourceRef ?? "").toLowerCase().includes("aeion-observability");

  const writePaths =
    card.writePaths.length > 0
      ? card.writePaths
      : project.sourceKind === "empty"
        ? [`src/${slugify(card.area)}/`, `tests/${slugify(card.area)}/`]
        : [...DEFAULT_TARGET.default_write_paths];

  const archName = isObservabilityAgoraTarget
    ? String(DEFAULT_EXPORT.frontmatter.architecture)
    : project.sourceKind === "empty"
      ? `${project.slug}-greenfield-v1`
      : `${project.slug}-v1`;
  const archDigest = isObservabilityAgoraTarget
    ? String(DEFAULT_EXPORT.frontmatter.architecture_digest)
    : project.openshellSummary?.rootDigest ??
      sha256Hex(`${project.id}:${project.slug}:${release.version}`);

  const fmMap: Record<string, unknown> = {
    id: card.featureCode,
    sequence,
    title: card.title,
    area: card.area || "foundation",
    size: card.size,
    parallel: false,
    phase: card.phase || "P1",
    tier: DEFAULT_EXPORT.frontmatter.tier ?? 3,
    write_paths: writePaths,
    depends_on: card.dependsOn,
    owner: DEFAULT_EXPORT.frontmatter.owner ?? "builder",
    status: card.column === "validated" ? "validated" : "proposed",
    architecture: archName,
    architecture_digest: archDigest,
  };

  const fmLines = DEFAULT_EXPORT.frontmatter_order.map(
    (key) => `${key}: ${yamlValue(fmMap[key])}`,
  );

  const settledDecisions = card.decisions.filter(
    (d) => d.resolved && (d.answerText || d.chosenOption),
  );
  const pendingDecisions = card.decisions.filter(
    (d) => !d.resolved || (!d.answerText && !d.chosenOption),
  );
  const decisionsSummaryText = card.decisions
    .map((d) => {
      const q = trimBoundary(d.question, 220).replace(/`/g, "'");
      const rawAns = d.answerText || d.chosenOption || "";
      const resolution = trimBoundary(rawAns, 240).replace(/`/g, "'");
      const tag = d.resolved ? `\`RESOLVED: ${resolution || "Confirmed"}\`` : "`PENDING`";
      return `- **${d.id}**: ${q} -> ${tag}`;
    })
    .join("\n");

  const ownerClarifications = card.messages
    .filter(
      (m) =>
        m.role === "user" &&
        !m.content.startsWith("[Satisfaction Update:") &&
        m.content.trim().length > 0,
    )
    .slice(-4)
    .map((m) => `- ${m.content.replace(/\s+/g, " ").trim().slice(0, 1200)}`)
    .join("\n");

  const unresolvedFindings = card.findings
    .filter((f) => !f.resolved)
    .sort((a, b) => {
      const rank = { BLOCKER: 0, MAJOR: 1, NIT: 2 };
      return rank[a.severity] - rank[b.severity];
    });
  const resolvedFindings = card.findings.filter((f) => f.resolved);

  let findingsText = "";
  for (const f of unresolvedFindings) {
    const line = `- **[${f.severity} / ${f.persona}]** ${trimBoundary(f.challenge, 220)}`;
    if (Buffer.byteLength(findingsText + line, "utf8") > 3600) break;
    findingsText += (findingsText ? "\n" : "") + line;
  }
  if (resolvedFindings.length > 0) {
    const uniqueNotes = Array.from(
      new Set(
        resolvedFindings
          .map((f) => f.resolutionNote?.trim())
          .filter((n): n is string => Boolean(n && n.length > 0)),
      ),
    ).slice(0, 4);
    const resolvedLine = `- **[RESOLVED (${resolvedFindings.length} Goldfish finding(s))]** ${uniqueNotes.length > 0 ? uniqueNotes.map((n) => trimBoundary(n, 240)).join(" | ") : "Addressed by owner clarifications and settled decisions."}`;
    findingsText += (findingsText ? "\n" : "") + resolvedLine;
  }

  const rawSteps = [
    `Implement ${card.featureCode} (${card.title}) strictly inside ${writePaths.join(", ")}.`,
    `Enforce fail-closed input validation, resource bounds, and settled Goldfish decisions.`,
    `Execute positive integration tests and negative-control refusal checks to prove isolation.`,
  ];
  const steps = rawSteps
    .map((s, idx) => `${idx + 1}. ${clampStep(s, DEFAULT_TARGET.delivery_max_chars)}`)
    .join("\n");

  const dataSourcesBody =
    project.sourceKind === "empty"
      ? `Greenfield specification tracked in aeion-spec. Content and model output are untrusted until validated by AxiomSpec 0.3.`
      : isObservabilityAgoraTarget
        ? DEFAULT_EXPORT.data_sources_text
        : `Quarantined source snapshot (${project.sourceKind}, OpenShell mode: ${project.openshellSummary?.mode ?? "quarantine"}, digest: ${project.openshellSummary?.rootDigest?.slice(0, 12) ?? "pending"}) under strict secret redaction and O_NOFOLLOW bounds. Content and model output are untrusted until validated by AxiomSpec 0.3.`;

  const outputsBody =
    project.sourceKind === "empty" || !isObservabilityAgoraTarget
      ? `Deterministic implementation and verification artifacts strictly restricted to ${writePaths.join(", ")}, with acceptance criteria verified against declared invariants.`
      : DEFAULT_EXPORT.outputs_text;

  const invariantsLead = isObservabilityAgoraTarget
    ? DEFAULT_EXPORT.invariants_text.replace("{id}", card.featureCode.toLowerCase())
    : `All invariants and failure guards for \`${card.featureCode}\` remain externally verifiable; implementation edits are strictly confined to \`write_paths\`.`;

  const positiveWitness = `Valid ${card.title} execution completes deterministically within declared bounds inside ${writePaths.join(", ")} and passes acceptance assertions.`;
  const settledVerificationRules = settledDecisions
    .map((d) => `${d.id}: ${trimBoundary(d.answerText || d.chosenOption || "", 240)}`)
    .join("; ");
  const negativeControl = settledVerificationRules
    ? `${trimBoundary(settledVerificationRules, 1600)} Out-of-bounds or invalid inputs fail closed cleanly without mutating state outside declared scope.`
    : pendingDecisions.length > 0
      ? `Pending decision settlement (${pendingDecisions.map((d) => d.id).join(", ")}): invalid or unauthorized inputs fail closed cleanly without mutating persistent state.`
      : `Invalid, resource-exceeded, or malformed input fails closed with explicit non-zero refusal signaling and zero out-of-scope state mutation.`;

  const sections = [
    `## Intent\n\nFeature \`${card.featureCode}\` for **${project.name}** (release \`${release.version}\`).\n\n${card.summary.trim()}${ownerClarifications ? `\n\nOwner Clarifications:\n${ownerClarifications}` : ""}`,
    `## Data Sources\n\n${dataSourcesBody}${decisionsSummaryText ? `\n\nDecision Status:\n${decisionsSummaryText}` : ""}`,
    `## Outputs\n\n${outputsBody}`,
    `## Constraints & Invariants\n\n${invariantsLead}${findingsText ? `\n\nAdversarial Goldfish Constraints:\n${findingsText}` : ""}`,
    `## Determinism & Security\n\n${DEFAULT_EXPORT.determinism_text}\nZero plaintext credentials committed or logged; deterministic behavior under declared resource and timeout caps.`,
    `## Interfaces & Write Scope\n\nAllowed \`write_paths\`:\n${writePaths.map((p) => `- \`${p}\``).join("\n")}\n\nDependencies: ${card.dependsOn.length ? card.dependsOn.join(", ") : "None"}.`,
    `## Verification\n\n- **Positive witness**: ${positiveWitness}\n- **Negative control (Rule 1)**: ${negativeControl}`,
    `## Delivery Steps\n\n${steps}`,
  ];

  let markdown = `---\n${fmLines.join("\n")}\n---\n\n${sections.join("\n\n")}\n`;
  if (Buffer.byteLength(markdown, "utf8") > OBSERVABILITY_MAX_BYTES) {
    // Deterministic compaction preserving required sections, Delivery Steps, and negative control
    for (const [decLimit, findLimit, verifLimit] of [
      [8, 8, 600],
      [4, 4, 300],
      [2, 2, 160],
    ] as const) {
      const compactDecisions = decisionsSummaryText
        ? decisionsSummaryText.split("\n").slice(0, decLimit).join("\n")
        : "";
      const compactConstraints = findingsText
        ? findingsText.split("\n").slice(0, findLimit).join("\n")
        : "";
      const compactNeg = settledVerificationRules
        ? `${trimBoundary(settledVerificationRules, verifLimit)} Out-of-bounds or invalid inputs fail closed cleanly without mutating state outside declared scope.`
        : negativeControl;
      const compacted = sections.map((sec) => {
        if (sec.startsWith("## Intent")) {
          return `## Intent\n\nFeature \`${card.featureCode}\` for **${project.name}** (release \`${release.version}\`).\n\n${trimBoundary(card.summary, 1200)}`;
        }
        if (sec.startsWith("## Data Sources")) {
          return `## Data Sources\n\n${dataSourcesBody}${compactDecisions ? `\n\nDecision Status:\n${compactDecisions}` : ""}`;
        }
        if (sec.startsWith("## Constraints & Invariants") && compactConstraints) {
          return `## Constraints & Invariants\n\n${invariantsLead}\n\nAdversarial Goldfish Constraints (top findings):\n${compactConstraints}`;
        }
        if (sec.startsWith("## Verification")) {
          return `## Verification\n\n- **Positive witness**: ${positiveWitness}\n- **Negative control (Rule 1)**: ${compactNeg}`;
        }
        return sec;
      });
      markdown = `---\n${fmLines.join("\n")}\n---\n\n${compacted.join("\n\n")}\n`;
      if (Buffer.byteLength(markdown, "utf8") <= OBSERVABILITY_MAX_BYTES) break;
    }
  }
  return markdown;
}

export function validateObservabilityMarkdown(
  card: TableauCard,
  markdown: string,
  sourceKind: ProjectRecord["sourceKind"],
): ObservabilityFeatureValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byteCount = Buffer.byteLength(markdown, "utf8");
  if (byteCount > OBSERVABILITY_MAX_BYTES) {
    errors.push(`Feature exceeds ${OBSERVABILITY_MAX_BYTES} bytes (${byteCount} bytes).`);
  }

  for (const heading of REQUIRED_SECTIONS) {
    if (!markdown.includes(`## ${heading}`)) {
      errors.push(`Missing required section: ## ${heading}`);
    }
  }

  const deliveryMatch = markdown.match(/## Delivery Steps\s+([\s\S]*?)(?:\n## |$)/);
  const deliveryLines = deliveryMatch?.[1]
    ? deliveryMatch[1]
        .trim()
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^\d+\.\s+/.test(l))
    : [];
  const [minSteps, maxSteps] = DEFAULT_TARGET.delivery_steps;
  if (deliveryLines.length < minSteps || deliveryLines.length > maxSteps) {
    errors.push(
      `Delivery Steps must contain ${minSteps}..${maxSteps} numbered steps (found ${deliveryLines.length}).`,
    );
  }
  for (const line of deliveryLines) {
    const clean = line.replace(/^\d+\.\s+/, "");
    if (clean.length > DEFAULT_TARGET.delivery_max_chars) {
      errors.push(`Delivery step exceeds ${DEFAULT_TARGET.delivery_max_chars} chars.`);
    }
  }

  const verifMatch = markdown.match(/## Verification\s+([\s\S]*?)(?:\n## |$)/);
  const verifText = verifMatch?.[1] ?? "";
  const hasNegativeControl = /negative[- ]control|fails? closed|unauthorized|refusal|reject/i.test(
    verifText,
  );
  if (!hasNegativeControl) {
    errors.push("Rule 1 violation: Verification lacks an explicit negative-control refusal case.");
  }

  const writePathsValid = validateRelativeWritePaths(card.writePaths).ok;
  if (!writePathsValid) {
    errors.push("Invalid write_paths: relative paths without traversal are required.");
  }
  if (card.writePaths.length === 0 && sourceKind !== "empty") {
    warnings.push("No explicit write_paths on card; default scope applied.");
  }

  const slug = `${card.featureCode.toLowerCase()}-${slugify(card.title)}`;
  return {
    featureId: card.featureCode,
    slug,
    byteCount,
    maxBytes: OBSERVABILITY_MAX_BYTES,
    sectionCount: REQUIRED_SECTIONS.filter((s) => markdown.includes(`## ${s}`)).length,
    deliveryStepsCount: deliveryLines.length,
    hasNegativeControl,
    writePathsValid,
    valid: errors.length === 0,
    errors,
    warnings,
    markdown,
  };
}

export function buildObservabilityBundle(params: {
  project: ProjectRecord;
  release: Pick<ReleaseRecord, "version" | "title">;
  cards: TableauCard[];
  focusCard: TableauCard;
}): ObservabilityExportBundle {
  const { project, release, cards, focusCard } = params;
  const activeCards = cards.filter((c) => c.column !== "archived");
  const focusIdx = Math.max(
    0,
    activeCards.findIndex((c) => c.id === focusCard.id),
  );
  const markdown =
    focusCard.draftMarkdown && focusCard.draftMarkdown.includes("## Delivery Steps")
      ? focusCard.draftMarkdown
      : buildFeatureMarkdown({
          project,
          release,
          card: focusCard,
          sequence: focusIdx + 1,
        });

  const feature = validateObservabilityMarkdown(
    focusCard,
    markdown,
    project.sourceKind,
  );

  const manifestNodes = activeCards.map((c, idx) => {
    const md =
      c.id === focusCard.id
        ? markdown
        : c.draftMarkdown ||
          buildFeatureMarkdown({
            project,
            release,
            card: c,
            sequence: idx + 1,
          });
    return {
      id: c.featureCode,
      sequence: idx + 1,
      title: c.title,
      area: c.area,
      phase: c.phase,
      size: c.size,
      file: `${c.featureCode.toLowerCase()}-${slugify(c.title)}.md`,
      depends_on: c.dependsOn,
      write_paths: c.writePaths,
      contract_digest: sha256Hex(md),
      status: c.column === "validated" ? "validated" : "proposed",
    };
  });

  const knownIds = new Set(manifestNodes.map((n) => n.id));
  const manifestErrors: string[] = [];
  for (const node of manifestNodes) {
    for (const dep of node.depends_on) {
      if (!knownIds.has(dep)) {
        manifestErrors.push(`Node ${node.id} depends on unknown feature ${dep}.`);
      }
      if (dep === node.id) {
        manifestErrors.push(`Self-dependency detected on ${node.id}.`);
      }
    }
  }

  const archDigest =
    project.sourceKind === "empty"
      ? sha256Hex(`${project.id}:${project.slug}:${release.version}`)
      : String(DEFAULT_EXPORT.frontmatter.architecture_digest);

  const manifest = {
    schema_version: 2,
    product: project.slug,
    release_version: release.version.replace(/^v/i, ""),
    release_title: release.title,
    architecture:
      project.sourceKind === "empty"
        ? `${project.slug}-greenfield-v1`
        : DEFAULT_EXPORT.frontmatter.architecture,
    architecture_digest: archDigest,
    features: manifestNodes,
    manifest_digest: sha256Hex(JSON.stringify(manifestNodes)),
  };

  return {
    manifest,
    feature,
    manifestValid: manifestErrors.length === 0,
    manifestErrors,
  };
}
