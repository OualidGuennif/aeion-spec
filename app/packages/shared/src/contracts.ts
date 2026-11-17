// Spec: knowledge/components/aeion-agents.md

import type {
  AgentRoleId,
  GoldfishPersonaId,
  LlmProviderId,
  PiWireApi,
} from "./providers.ts";

export type SessionMode = "authenticated" | "invite";

export type ThemeMode = "light" | "night" | "auto";

export type TableauColumn =
  | "idea"
  | "goldfish_interview"
  | "automated_review"
  | "validated"
  | "archived";

export const TABLEAU_ACTIVE_COLUMNS: readonly TableauColumn[] = [
  "idea",
  "goldfish_interview",
  "automated_review",
  "validated",
] as const;

export type SourceKind = "empty" | "github_public" | "github_private" | "upload";

export type VaultSecretPurpose = "llm_provider" | "github_readonly";

export type FindingSeverity = "BLOCKER" | "MAJOR" | "NIT";

export type SatisfiedActor = "goldfish" | "user" | "both" | "none";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const OBSERVABILITY_MAX_BYTES = 12_000;

export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string;
  mode: SessionMode;
  expiresAt: string;
  csrfToken: string;
  builderTokenPreview: string | null;
}

export interface VaultKeySummary {
  id: string;
  purpose: VaultSecretPurpose;
  provider: LlmProviderId | "github";
  label: string;
  maskedHint: string;
  keyFingerprint: string;
  verifiedAt: string | null;
  createdAt: string;
}

export interface ModelAssignment {
  role: AgentRoleId;
  provider: LlmProviderId;
  modelId: string;
  api: PiWireApi;
  temperature: number;
  thinkingLevel: "off" | "low" | "medium" | "high" | "max";
}

export interface ModelMixerConfig {
  projectId: string;
  assignments: Partial<Record<AgentRoleId, ModelAssignment>>;
  // What each role actually runs, after the fallback chain fills unassigned roles.
  effectiveAssignments: Record<AgentRoleId, ModelAssignment>;
  crossFamilyEnforced: boolean;
  warnings: string[];
  enabledOpenCodeModels?: string[];
}

export interface OpenShellScanSummary {
  sandboxName: string;
  mode:
    | "openshell"
    | "docker-hardened"
    | "quarantine-readonly"
    | "unverified-blocked";
  networkMode: "none";
  landlockActive: boolean;
  sourceKind: SourceKind;
  totalBytes: number;
  fileCount: number;
  quarantinedCount: number;
  redactedSecretsCount: number;
  rejectedEntries: string[];
  rootDigest: string;
  qualifiedAt: string;
}

export interface ProjectRecord {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  description: string;
  sourceKind: SourceKind;
  sourceRef: string | null;
  activeReleaseId: string | null;
  activeReleaseVersion: string;
  activeReleaseTitle: string;
  githubVaultKeyId: string | null;
  openshellSummary: OpenShellScanSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoldfishFinding {
  id: string;
  persona: GoldfishPersonaId;
  severity: FindingSeverity;
  title: string;
  claim: string;
  challenge: string;
  suggestedQuestion: string;
  resolved: boolean;
  resolutionNote: string | null;
}

export interface DecisionItem {
  id: string;
  question: string;
  rationale: string;
  options: string[];
  chosenOption: string | null;
  answerText: string | null;
  blocking: boolean;
  resolved: boolean;
  raisedByPersona: GoldfishPersonaId | "elephant";
}

export interface AssumptionItem {
  id: string;
  statement: string;
  riskIfFalse: "high" | "medium" | "low";
  status: "unverified" | "confirmed" | "rejected";
  evidenceNote: string | null;
}

export interface GoldfishMessage {
  id: string;
  role: "user" | "elephant" | "goldfish" | "reviewer" | "system";
  persona: GoldfishPersonaId | null;
  round: number;
  content: string;
  modelUsed: string | null;
  contextIsolated: boolean;
  createdAt: string;
}

export interface AxiomGateResult {
  gateId: string;
  name: string;
  passed: boolean;
  severity: "error" | "warning";
  detail: string;
}

export interface Axiom03Report {
  specVersion: "axiomspec/0.3";
  valid: boolean;
  riskScore: number;
  recommendedBump: "major" | "minor" | "patch";
  gates: AxiomGateResult[];
  errors: string[];
  warnings: string[];
  snapshotDigest: string;
  specJson: Record<string, unknown>;
}

export interface ObservabilityFeatureValidation {
  featureId: string;
  slug: string;
  byteCount: number;
  maxBytes: number;
  sectionCount: number;
  deliveryStepsCount: number;
  hasNegativeControl: boolean;
  writePathsValid: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
  markdown: string;
}

export interface ObservabilityExportBundle {
  manifest: Record<string, unknown>;
  feature: ObservabilityFeatureValidation;
  manifestValid: boolean;
  manifestErrors: string[];
}

export interface AutomatedReviewReport {
  id: string;
  passed: boolean;
  reviewerProvider: LlmProviderId;
  reviewerModel: string;
  reviewerVendorFamily: string;
  drafterVendorFamily: string;
  crossFamilyVerified: boolean;
  summary: string;
  verdict: "approve" | "revise" | "block";
  repairedAutomatically: boolean;
  axiomReport: Axiom03Report;
  observabilityBundle: ObservabilityExportBundle;
  goldfishReassessmentFindings: GoldfishFinding[];
  mechanicalErrors: string[];
  reviewedAt: string;
}

export interface TableauCard {
  id: string;
  projectId: string;
  releaseId: string;
  featureCode: string;
  title: string;
  summary: string;
  area: string;
  phase: string;
  size: "S" | "M" | "L";
  writePaths: string[];
  dependsOn: string[];
  column: TableauColumn;
  position: number;
  goldfishRound: number;
  goldfishSatisfied: boolean;
  userSatisfied: boolean;
  reviewPassed: boolean;
  activePersonas: GoldfishPersonaId[];
  messages: GoldfishMessage[];
  findings: GoldfishFinding[];
  decisions: DecisionItem[];
  assumptions: AssumptionItem[];
  draftMarkdown: string;
  latestReview: AutomatedReviewReport | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseRecord {
  id: string;
  projectId: string;
  version: string;
  title: string;
  notes: string;
  status: "active" | "sealed";
  bumpKind: "major" | "minor" | "patch" | null;
  riskScore: number | null;
  sealedDigest: string | null;
  approvalSignature: string | null;
  axiomSnapshotJson: Record<string, unknown> | null;
  observabilityManifestJson: Record<string, unknown> | null;
  cardsCount: number;
  validatedCount: number;
  createdAt: string;
  sealedAt: string | null;
}

export interface ReleaseCompareReport {
  fromReleaseId: string;
  fromVersion: string;
  toReleaseId: string;
  toVersion: string;
  recommendedBump: "major" | "minor" | "patch";
  riskScore: number;
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: string[];
  breakingChanges: string[];
}

export interface BuilderSpecPayload {
  project: Pick<ProjectRecord, "id" | "slug" | "name" | "sourceKind">;
  release: Pick<
    ReleaseRecord,
    "id" | "version" | "title" | "status" | "sealedDigest" | "sealedAt"
  >;
  axiomSpec03: Record<string, unknown>;
  observabilityManifest: Record<string, unknown>;
  features: Array<{
    featureCode: string;
    title: string;
    column: TableauColumn;
    markdown: string;
    byteCount: number;
  }>;
}
