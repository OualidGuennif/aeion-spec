// Spec: knowledge/components/spec-studio.md
"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  GOLDFISH_PERSONAS,
  OBSERVABILITY_MAX_BYTES,
  validateRelativeWritePaths,
  type FindingSeverity,
  type GoldfishFinding,
  type GoldfishPersonaId,
  type TableauCard,
  type TableauColumn,
} from "@aeion-spec/shared";
import { createApiClient, unwrap } from "../lib/api.ts";

export type StudioTab = "interview" | "review" | "spec" | "axiom";

interface CardStudioDrawerProps {
  csrfToken: string;
  projectId: string;
  card: TableauCard;
  initialTab?: StudioTab;
  autoStartReview?: boolean;
  onClose: () => void;
  onCardUpdated: (card: TableauCard) => void;
}

type CardDecision = TableauCard["decisions"][number];

const COLUMN_LABEL: Record<TableauColumn, string> = {
  idea: "Ideas",
  goldfish_interview: "Goldfish interview",
  automated_review: "Automated review",
  validated: "Validated",
  archived: "Archived",
};

const SEVERITY_BADGE: Record<FindingSeverity, string> = {
  BLOCKER: "badge-danger",
  MAJOR: "badge-warn",
  NIT: "badge-neutral",
};

const RISK_BADGE = { high: "badge-danger", medium: "badge-warn", low: "badge-neutral" } as const;
const ASSUMPTION_BADGE = { unverified: "badge-warn", confirmed: "badge-emerald", rejected: "badge-danger" } as const;

const REVIEW_STEPS = [
  { id: "gates", label: "1. Observability & AxiomSpec G01-G14" },
  { id: "reviewer", label: "2. Cross-family independent reviewer" },
  { id: "reassessment", label: "3. Stage 5-9 Goldfish reassessment" },
] as const;

function personaLabel(id: string | null): string {
  return GOLDFISH_PERSONAS.find((p) => p.id === id)?.label ?? id ?? "";
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// The server answers a refused stream with JSON `{ error }`; plain text falls through unchanged.
async function readErrorBody(res: Response, fallbackStatusLabel: string): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Plain-text error response.
  }
  return text || `${fallbackStatusLabel} (${res.status}).`;
}

// Shared SSE consumer for interview turns and automated reviews.
async function consumeCardStream(params: {
  url: string;
  csrfToken: string;
  body?: unknown;
  signal?: AbortSignal;
  fallbackStatusLabel: string;
  incompleteError: string;
  onProgress: (message: string, step?: string) => void;
  onComplete: (card: TableauCard) => void;
}): Promise<void> {
  const headers: Record<string, string> = {
    "X-Aeion": "1",
    "X-CSRF-Token": params.csrfToken,
  };
  if (params.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(params.url, {
    method: "POST",
    credentials: "include",
    headers,
    signal: params.signal,
    body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
  });
  if (!res.ok || !res.body) {
    throw new Error(await readErrorBody(res, params.fallbackStatusLabel));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const eventMatch = frame.match(/^event:\s*(.+)$/m);
        const dataMatch = frame.match(/^data:\s*(.+)$/m);
        if (!eventMatch || !dataMatch) continue;
        let data: { card?: TableauCard; message?: string; step?: string; persona?: string; error?: string };
        try {
          data = JSON.parse(dataMatch[1]!);
        } catch {
          continue;
        }
        const evType = eventMatch[1]!.trim();
        if (evType === "progress") {
          const msg =
            data.message || (data.persona ? `Goldfish (${personaLabel(data.persona)}) is reviewing...` : "Working...");
          params.onProgress(msg, data.step);
        } else if (evType === "complete" && data.card) {
          completed = true;
          params.onComplete(data.card);
        } else if (evType === "error") {
          throw new Error(data.error || params.incompleteError);
        }
      }
    }
    if (!completed) {
      throw new Error(params.incompleteError);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function FindingRow({
  finding,
  busy,
  readOnly,
  onResolve,
}: {
  finding: GoldfishFinding;
  busy: boolean;
  readOnly: boolean;
  onResolve?: (id: string) => void;
}) {
  return (
    <li className={`finding ${finding.resolved ? "is-resolved" : ""}`}>
      <div className="finding-head">
        <span className={`badge ${SEVERITY_BADGE[finding.severity]}`}>{finding.severity}</span>
        <span className="finding-persona">{personaLabel(finding.persona)}</span>
        <span className="mono finding-id">{finding.id}</span>
        {finding.resolved ? (
          <span className="badge badge-emerald">Resolved</span>
        ) : (
          onResolve && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || readOnly}
              onClick={() => onResolve(finding.id)}
            >
              Mark resolved
            </button>
          )
        )}
      </div>
      <p className="finding-title">{finding.title}</p>
      <p className="finding-body">{finding.challenge}</p>
      {finding.resolutionNote && <p className="finding-note">Resolution: {finding.resolutionNote}</p>}
    </li>
  );
}

export function CardStudioDrawer({
  csrfToken,
  projectId,
  card,
  initialTab = "interview",
  autoStartReview = false,
  onClose,
  onCardUpdated,
}: CardStudioDrawerProps) {
  const [activeTab, setActiveTab] = useState<StudioTab>(initialTab);
  const [selectedPersonas, setSelectedPersonas] = useState<GoldfishPersonaId[]>(card.activePersonas);
  const [showPersonaPicker, setShowPersonaPicker] = useState(false);
  const [message, setMessage] = useState("");
  const [decisionDrafts, setDecisionDrafts] = useState<Record<string, { chosenOption?: string; answerText: string }>>({});
  const [editingDecisionId, setEditingDecisionId] = useState<string | null>(null);
  const [settledChoiceDraft, setSettledChoiceDraft] = useState<string | undefined>(undefined);
  const [settledAnswerDraft, setSettledAnswerDraft] = useState("");
  const [summaryDraft, setSummaryDraft] = useState(card.summary);
  const [writePathsDraft, setWritePathsDraft] = useState(card.writePaths.join(", "));
  const [showBriefEditor, setShowBriefEditor] = useState(
    card.goldfishRound === 0 || Boolean(card.latestReview && !card.latestReview.passed),
  );
  const [showSwarmLogs, setShowSwarmLogs] = useState(false);
  const [reviewStep, setReviewStep] = useState<string | null>(null);
  const [copiedSpec, setCopiedSpec] = useState<"idle" | "copied" | "failed">("idle");
  const [busy, setBusy] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const closeRef = useRef<HTMLButtonElement>(null);
  const didAutoReviewRef = useRef(false);
  const mountedRef = useRef(true);
  const streamAbortRef = useRef<AbortController | null>(null);
  const readOnly = card.column === "archived";
  const writePathsValue = card.writePaths.join(", ");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      streamAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    setSummaryDraft(card.summary);
  }, [card.id, card.summary]);

  useEffect(() => {
    setWritePathsDraft(writePathsValue);
  }, [card.id, writePathsValue]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const cardApi = useCallback(
    () => createApiClient(csrfToken).api.projects({ projectId }).cards({ cardId: card.id }),
    [csrfToken, projectId, card.id],
  );

  const callCard = async (fn: () => Promise<{ card: TableauCard }>, fallback: string, then?: () => void) => {
    setError(null);
    setBusy(true);
    try {
      const res = await fn();
      if (!mountedRef.current) return;
      onCardUpdated(res.card);
      then?.();
    } catch (err) {
      if (mountedRef.current) setError(errorText(err, fallback));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const togglePersona = (id: GoldfishPersonaId) => {
    setSelectedPersonas((prev) =>
      prev.includes(id) ? (prev.length > 1 ? prev.filter((x) => x !== id) : prev) : [...prev, id],
    );
  };

  const runInterviewTurn = async (e: FormEvent) => {
    e.preventDefault();
    const decisionAnswers = Object.entries(decisionDrafts)
      .filter(([, draft]) => draft.answerText.trim().length > 0)
      .map(([decisionId, draft]) => ({
        decisionId,
        chosenOption: draft.chosenOption,
        answerText: draft.answerText.trim(),
      }));
    if (!message.trim() && decisionAnswers.length === 0) return;

    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;

    setError(null);
    setBusy(true);
    setReviewStep(null);
    setStreamStatus("Connecting to Elephant and the Goldfish swarm...");
    try {
      await consumeCardStream({
        url: `/api/projects/${projectId}/cards/${card.id}/interview/stream`,
        csrfToken,
        signal: controller.signal,
        body: {
          message: message.trim() || "Reassess the settled decisions with fresh Goldfish contexts.",
          decisionAnswers,
          personas: selectedPersonas,
        },
        fallbackStatusLabel: "The interview request failed",
        incompleteError: "The interview stream ended before the round completed.",
        onProgress: (msg) => {
          if (mountedRef.current) setStreamStatus(msg);
        },
        onComplete: (updated) => {
          if (!mountedRef.current) return;
          onCardUpdated(updated);
          setMessage("");
          setDecisionDrafts({});
        },
      });
    } catch (err) {
      if (mountedRef.current && !(err instanceof DOMException && err.name === "AbortError")) {
        setError(errorText(err, "The interview round failed."));
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        setStreamStatus(null);
      }
    }
  };

  const runReview = useCallback(async () => {
    if (readOnly || !card.goldfishSatisfied || !card.userSatisfied) return;
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;

    setActiveTab("review");
    setError(null);
    setBusy(true);
    setReviewStep("gates");
    setStreamStatus("Starting automated review (AxiomSpec G01-G14, reviewer, Stage 5-9 reassessment)...");
    try {
      await consumeCardStream({
        url: `/api/projects/${projectId}/cards/${card.id}/review/stream`,
        csrfToken,
        signal: controller.signal,
        fallbackStatusLabel: "The automated review request failed",
        incompleteError: "The automated review stream ended before producing a report.",
        onProgress: (msg, step) => {
          if (!mountedRef.current) return;
          setStreamStatus(msg);
          if (step) setReviewStep(step);
        },
        onComplete: (updated) => {
          if (!mountedRef.current) return;
          onCardUpdated(updated);
          setActiveTab("review");
        },
      });
    } catch (err) {
      if (mountedRef.current && !(err instanceof DOMException && err.name === "AbortError")) {
        setError(errorText(err, "The automated review failed."));
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        setStreamStatus(null);
        setReviewStep(null);
      }
    }
  }, [readOnly, card.goldfishSatisfied, card.userSatisfied, projectId, card.id, csrfToken, onCardUpdated]);

  useEffect(() => {
    if (!autoStartReview || didAutoReviewRef.current || !card.goldfishSatisfied || !card.userSatisfied || readOnly) {
      return;
    }
    // Defer via macrotask so React 19 Strict Mode cancels the setup before firing a doomed stream request.
    const timer = window.setTimeout(() => {
      if (!mountedRef.current || didAutoReviewRef.current) return;
      didAutoReviewRef.current = true;
      void runReview();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoStartReview, card.goldfishSatisfied, card.userSatisfied, readOnly, runReview]);

  const toggleUserSatisfaction = (satisfied: boolean) =>
    callCard(() => unwrap(cardApi().satisfy.post({ userSatisfied: satisfied })), "Could not update your confirmation.");

  const moveCard = (targetColumn: TableauColumn) =>
    callCard(
      () => unwrap(cardApi().move.post({ targetColumn })),
      "A workflow gate blocked that move.",
      () => {
        if (targetColumn === "automated_review") setActiveTab("review");
      },
    );

  const resolveFinding = (findingId: string) =>
    callCard(
      () =>
        unwrap(
          cardApi().patch({
            resolveFindingIds: [{ findingId, note: "Resolved by the owner in Spec Studio." }],
          }),
        ),
      "The challenge could not be marked resolved.",
    );

  const resolveAllFindings = () =>
    callCard(
      () =>
        unwrap(
          cardApi().patch({
            resolveFindingIds: openFindings.map((f) => ({
              findingId: f.id,
              note: "Resolved by the owner in Spec Studio.",
            })),
          }),
        ),
      "The challenges could not be marked resolved.",
    );

  const saveDecisionAnswer = (decisionId: string, chosenOption: string | undefined, answerText: string, clearOpen?: boolean) => {
    const trimmed = answerText.trim();
    if (!trimmed) return setError("Enter an answer before saving the decision.");
    return callCard(
      () =>
        unwrap(
          cardApi().patch({
            decisionAnswers: [{ decisionId, chosenOption, answerText: trimmed }],
          }),
        ),
      "The decision could not be saved.",
      () => {
        setEditingDecisionId(null);
        if (clearOpen) {
          setDecisionDrafts((prev) => {
            const next = { ...prev };
            delete next[decisionId];
            return next;
          });
        }
      },
    );
  };

  const beginEditDecision = (dec: CardDecision) => {
    setEditingDecisionId(dec.id);
    setSettledChoiceDraft(dec.chosenOption ?? undefined);
    setSettledAnswerDraft(dec.answerText ?? dec.chosenOption ?? "");
  };

  const saveBriefAndScope = (e: FormEvent) => {
    e.preventDefault();
    const cleanSummary = summaryDraft.trim();
    if (cleanSummary.length < 10) {
      return setError("Feature brief must be at least 10 characters.");
    }
    const rawPaths = writePathsDraft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (rawPaths.length === 0) return setError("Enter at least one relative write path.");
    const verdict = validateRelativeWritePaths(rawPaths);
    if (!verdict.ok) return setError(verdict.error);
    return callCard(
      () => unwrap(cardApi().patch({ summary: cleanSummary, writePaths: verdict.paths })),
      "The brief and write scope could not be updated.",
    );
  };

  const saveWritePathsOnly = (e: FormEvent) => {
    e.preventDefault();
    const rawPaths = writePathsDraft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (rawPaths.length === 0) return setError("Enter at least one relative write path.");
    const verdict = validateRelativeWritePaths(rawPaths);
    if (!verdict.ok) return setError(verdict.error);
    return callCard(
      () => unwrap(cardApi().patch({ writePaths: verdict.paths })),
      "The write scope could not be updated.",
    );
  };

  const copyMarkdown = async () => {
    if (!card.draftMarkdown) return;
    try {
      await navigator.clipboard.writeText(card.draftMarkdown);
      setCopiedSpec("copied");
    } catch {
      setCopiedSpec("failed");
    }
    setTimeout(() => setCopiedSpec("idle"), 1600);
  };

  const jumpToFixInterview = () => {
    setActiveTab("interview");
    setShowBriefEditor(true);
  };

  const mdBytes = new TextEncoder().encode(card.draftMarkdown || "").length;
  const openDecisions = card.decisions.filter((d) => !d.resolved);
  const settledDecisions = card.decisions.filter((d) => d.resolved);
  const openFindings = card.findings.filter((f) => !f.resolved);
  const resolvedFindings = card.findings.filter((f) => f.resolved);
  const unverifiedAssumptions = card.assumptions.filter((a) => a.status === "unverified").length;
  const review = card.latestReview;

  const latestElephantMessage = [...card.messages].reverse().find((m) => m.role === "elephant");
  const dialogueMessages = card.messages.filter((m) => showSwarmLogs || m.role !== "goldfish");
  const rawGoldfishCount = card.messages.filter((m) => m.role === "goldfish").length;

  const blockingFindings = openFindings.filter((f) => f.severity === "BLOCKER" || f.severity === "MAJOR").length;
  const blockingDecisions = openDecisions.filter((d) => d.blocking).length;
  const openSwarmItems = openFindings.length + blockingDecisions;

  const blockersToReview: string[] = [];
  if (card.goldfishRound === 0) {
    blockersToReview.push("run Round 1");
  } else {
    if (blockingFindings > 0) {
      blockersToReview.push(`resolve ${blockingFindings} blocker/major challenge${blockingFindings === 1 ? "" : "s"}`);
    }
    if (blockingDecisions > 0) {
      blockersToReview.push(`answer ${blockingDecisions} blocking decision${blockingDecisions === 1 ? "" : "s"}`);
    }
    if (!card.userSatisfied) {
      blockersToReview.push("confirm you are satisfied");
    }
  }

  const tabs: Array<{ id: StudioTab; label: string }> = [
    { id: "interview", label: openSwarmItems > 0 ? `Interview (${openSwarmItems})` : "Interview" },
    { id: "review", label: card.reviewPassed ? "Review ✓" : review ? "Review !" : "Review" },
    { id: "spec", label: "Spec" },
    { id: "axiom", label: "Gates" },
  ];

  // 4-step workflow progression bar.
  const step1Done = card.goldfishRound > 0 && card.goldfishSatisfied;
  const step2Done = card.userSatisfied;
  const step3Done = card.reviewPassed;
  const step4Done = card.column === "validated";
  const workflowSteps = [
    { num: 1, label: "Clarify with swarm", done: step1Done || step4Done, active: !step1Done && !step4Done },
    {
      num: 2,
      label: "Dual sign-off",
      done: (step1Done && step2Done) || step4Done,
      active: step1Done && !step2Done && !step4Done,
    },
    {
      num: 3,
      label: "Automated review",
      done: step3Done || step4Done,
      active: step1Done && step2Done && !step3Done && !step4Done,
    },
    { num: 4, label: "Validated", done: step4Done, active: step4Done },
  ];

  let nextStepHint = "Describe the goal, failure modes, and non-goals on the left, then start Round 1.";
  let bannerVariant = "";
  if (card.column === "archived") {
    nextStepHint = "Archived and read-only. Restore this feature to Ideas on the board before editing.";
  } else if (card.column === "validated") {
    nextStepHint = "Automated review and gates passed. Ready to seal into a release.";
    bannerVariant = "is-ok";
  } else if (review && !review.passed) {
    nextStepHint = `Automated review requested changes: ${review.summary}`;
    bannerVariant = "is-warn";
  } else if (card.reviewPassed) {
    nextStepHint = "Automated review passed. Approve this card to Validated.";
    bannerVariant = "is-ok";
  } else if (card.goldfishSatisfied && card.userSatisfied) {
    nextStepHint = "Both you and the Goldfish swarm signed off. Run Automated Review to check G01-G14 and get cross-family approval.";
    bannerVariant = "is-ok";
  } else if (card.goldfishSatisfied && !card.userSatisfied) {
    nextStepHint = "Swarm has no remaining blockers. Review the brief and settled decisions on the right, then confirm you are satisfied.";
  } else if (card.goldfishRound > 0) {
    nextStepHint = "Read Elephant's latest question on the left, answer any decisions or challenges on the right, and send the next round.";
  }

  const activeReviewIdx = REVIEW_STEPS.findIndex((s) => s.id === reviewStep);

  return (
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <aside className="studio-drawer" role="dialog" aria-modal="true" aria-labelledby="studio-title">
        <header className="drawer-header">
          <div className="drawer-heading">
            <div className="card-meta-row">
              <span className="chip mono">{card.featureCode}</span>
              <span className="chip">{COLUMN_LABEL[card.column]}</span>
              <span className="chip">{card.area}</span>
              <span className="chip">{card.phase}</span>
              <span className="chip">Size {card.size}</span>
              <span className="chip tabular">Round {card.goldfishRound}</span>
            </div>
            <h2 id="studio-title">{card.title}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label="Close studio"
            disabled={busy}
            onClick={() => {
              if (!busy) onClose();
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <ol className="studio-stepper" aria-label="Feature workflow steps">
          {workflowSteps.map((s) => (
            <li
              key={s.num}
              className={`stepper-item ${s.done ? "is-done" : ""} ${s.active ? "is-active" : ""}`}
            >
              <span className="stepper-num tabular">{s.done ? "✓" : s.num}</span>
              <span className="stepper-label">{s.label}</span>
            </li>
          ))}
        </ol>

        <div className={`next-step-bar ${bannerVariant}`}>
          <div className="next-step-text">
            <strong>Next step:</strong> {nextStepHint}
          </div>
          {!readOnly && card.column !== "validated" && (
            <div className="next-step-cta">
              {card.reviewPassed ? (
                <button
                  type="button"
                  className="btn btn-success btn-sm"
                  disabled={busy}
                  onClick={() => void moveCard("validated")}
                >
                  Approve to Validated →
                </button>
              ) : card.goldfishSatisfied && !card.userSatisfied ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => void toggleUserSatisfaction(true)}
                >
                  Confirm: I am satisfied ✓
                </button>
              ) : review && !review.passed ? (
                <>
                  {activeTab !== "interview" && (
                    <button type="button" className="btn btn-primary btn-sm" onClick={jumpToFixInterview}>
                      Fix in Interview
                    </button>
                  )}
                  <button
                    type="button"
                    className={`btn ${activeTab === "interview" ? "btn-primary" : ""} btn-sm`}
                    disabled={busy || !card.goldfishSatisfied || !card.userSatisfied}
                    onClick={() => void runReview()}
                  >
                    Re-run review
                  </button>
                </>
              ) : card.goldfishSatisfied && card.userSatisfied ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => void runReview()}
                >
                  {busy ? "Reviewing..." : "Run automated review →"}
                </button>
              ) : null}
            </div>
          )}
        </div>

        <div className="segmented drawer-tabs" role="tablist" aria-label="Studio sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`segment ${activeTab === t.id ? "active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="drawer-body">
          {readOnly && (
            <div className="notice">This card is archived and read-only. Restore it to Ideas from the board to edit.</div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          )}
          {streamStatus && (
            <div className="live-status" role="status">
              <span className="spinner" aria-hidden="true" />
              <span>{streamStatus}</span>
            </div>
          )}

          {activeTab === "interview" && (
            <div className="studio-split">
              <div className="studio-col-main">
                {review && !review.passed && (
                  <div className="notice notice-warn">
                    <strong>Automated review blocked:</strong> {review.summary}{" "}
                    <span className="muted">Update the brief or settled decisions on the right, then re-run review.</span>
                  </div>
                )}

                {latestElephantMessage ? (
                  <section className="elephant-focus" aria-label="Latest Elephant prompt">
                    <div className="elephant-focus-head">
                      <strong>Latest question from Elephant</strong>
                      <span className="chip tabular">Round {latestElephantMessage.round}</span>
                    </div>
                    <div className="elephant-focus-body">{latestElephantMessage.content}</div>
                  </section>
                ) : (
                  <section className="elephant-focus" aria-label="Starter guide">
                    <div className="elephant-focus-head">
                      <strong>What to write to start Round 1</strong>
                      <span className="chip">Guide</span>
                    </div>
                    <ul className="guide-bullets">
                      <li>
                        <strong>Flow:</strong> exact user input, endpoint/state transition, and success result.
                      </li>
                      <li>
                        <strong>Failures &amp; limits:</strong> error codes (401/429/etc.), max lengths, no client retries.
                      </li>
                      <li>
                        <strong>Boundaries:</strong> list explicit non-goals and check the relative file paths on the right.
                      </li>
                    </ul>
                  </section>
                )}

                <form onSubmit={runInterviewTurn} className="studio-reply-card">
                  <div className="section-head">
                    <label htmlFor="interview-input" className="reply-title">
                      {card.goldfishRound === 0 ? "Your specification details" : "Your reply to Elephant"}
                    </label>
                    <span className="hint">Sent together with any filled open decisions</span>
                  </div>
                  <textarea
                    id="interview-input"
                    className="textarea"
                    value={message}
                    disabled={readOnly || busy}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder={
                      card.goldfishRound === 0
                        ? "Example: Users sign in with email and password via POST /api/auth/login. Valid credentials set a session cookie and redirect to /. Invalid or throttled requests show one uniform alert with zero mutation. Out of scope: signup, reset password, MFA."
                        : "Reply directly to Elephant's questions above, state error codes, limits, or non-goals."
                    }
                  />
                  <div className="composer-actions">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={busy || readOnly || (!message.trim() && Object.values(decisionDrafts).every((d) => !d.answerText.trim()))}
                    >
                      {busy
                        ? "Running round..."
                        : card.goldfishRound === 0
                          ? "Send & start Round 1"
                          : "Send reply & run round"}
                    </button>
                    <button
                      type="button"
                      className={`btn ${card.userSatisfied ? "btn-success" : ""}`}
                      aria-pressed={card.userSatisfied}
                      disabled={busy || readOnly || card.goldfishRound === 0}
                      onClick={() => void toggleUserSatisfaction(!card.userSatisfied)}
                    >
                      {card.userSatisfied ? "Owner confirmed ✓" : "I am satisfied"}
                    </button>
                    {card.goldfishSatisfied && card.userSatisfied && !readOnly && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void runReview()}
                      >
                        Send to review →
                      </button>
                    )}
                  </div>
                  <p className={`readiness-line ${blockersToReview.length === 0 ? "is-ready" : ""}`}>
                    {blockersToReview.length === 0
                      ? "Ready: both you and the Goldfish swarm signed off."
                      : `Still needed before Automated Review: ${blockersToReview.join(", ")}.`}
                  </p>
                </form>

                <section className="studio-section" aria-label="Interview history">
                  <div className="section-head">
                    <h3>Conversation ({dialogueMessages.length})</h3>
                    {rawGoldfishCount > 0 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setShowSwarmLogs((v) => !v)}
                      >
                        {showSwarmLogs ? "Hide Goldfish notes" : `Show Goldfish notes (${rawGoldfishCount})`}
                      </button>
                    )}
                  </div>
                  <div className="chat-feed">
                    {dialogueMessages.length === 0 ? (
                      <p className="muted">No messages yet. Start Round 1 above to get Elephant&apos;s feedback.</p>
                    ) : (
                      dialogueMessages.map((m) => (
                        <div key={m.id} className={`msg-bubble role-${m.role}`}>
                          <div className="msg-meta">
                            <strong>{m.role === "goldfish" ? `Goldfish · ${personaLabel(m.persona)}` : m.role}</strong>
                            <span className="tabular">Round {m.round}</span>
                            {m.modelUsed && <span className="mono">{m.modelUsed}</span>}
                            {m.contextIsolated && <span className="badge badge-info">Fresh context</span>}
                          </div>
                          <div className="msg-text">{m.content}</div>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              </div>

              <div className="studio-col-side">
                {openDecisions.length > 0 && (
                  <section className="studio-side-card">
                    <div className="section-head">
                      <h3>Open decisions ({openDecisions.length})</h3>
                    </div>
                    <p className="hint">
                      Pick an option or write your decision. Saving also confirms unverified assumptions.
                    </p>
                    {openDecisions.map((dec) => {
                      const draft = decisionDrafts[dec.id] ?? { answerText: "" };
                      return (
                        <div key={dec.id} className="field decision">
                          <label htmlFor={`dec-${dec.id}`}>
                            <span className="mono">{dec.id}</span> {dec.question}
                            {dec.blocking && <span className="badge badge-danger">Blocking</span>}
                          </label>
                          {dec.options.length > 0 && (
                            <div className="choice-row">
                              {dec.options.map((opt) => (
                                <button
                                  key={opt}
                                  type="button"
                                  aria-pressed={draft.chosenOption === opt}
                                  className={`choice ${draft.chosenOption === opt ? "active" : ""}`}
                                  onClick={() =>
                                    setDecisionDrafts((prev) => ({
                                      ...prev,
                                      [dec.id]: { chosenOption: opt, answerText: opt },
                                    }))
                                  }
                                >
                                  {opt}
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="decision-input-row">
                            <input
                              id={`dec-${dec.id}`}
                              className="input"
                              disabled={readOnly || busy}
                              value={draft.answerText}
                              onChange={(e) =>
                                setDecisionDrafts((prev) => ({
                                  ...prev,
                                  [dec.id]: { chosenOption: prev[dec.id]?.chosenOption, answerText: e.target.value },
                                }))
                              }
                              placeholder="Type your decision and rationale"
                            />
                            {!readOnly && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={busy || !draft.answerText.trim()}
                                onClick={() => void saveDecisionAnswer(dec.id, draft.chosenOption, draft.answerText, true)}
                              >
                                Save
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </section>
                )}

                {settledDecisions.length > 0 && (
                  <section className="studio-side-card">
                    <div className="section-head">
                      <h3>Settled decisions ({settledDecisions.length})</h3>
                      <span className="hint">Included in the spec</span>
                    </div>
                    <div className="stack-tight">
                      {settledDecisions.map((dec) => {
                        const isEditing = editingDecisionId === dec.id;
                        return (
                          <div key={dec.id} className="settled-decision">
                            <div className="finding-head">
                              <span className="mono finding-id">{dec.id}</span>
                              <span className="badge badge-emerald">Settled</span>
                              {!readOnly && !isEditing && (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  disabled={busy}
                                  onClick={() => beginEditDecision(dec)}
                                >
                                  Edit
                                </button>
                              )}
                            </div>
                            <p className="settled-question">{dec.question}</p>
                            {!isEditing ? (
                              <p className="settled-answer">
                                {dec.answerText || dec.chosenOption || "Resolved"}
                              </p>
                            ) : (
                              <div className="stack-tight">
                                {dec.options.length > 0 && (
                                  <div className="choice-row">
                                    {dec.options.map((opt) => (
                                      <button
                                        key={opt}
                                        type="button"
                                        aria-pressed={settledChoiceDraft === opt}
                                        className={`choice ${settledChoiceDraft === opt ? "active" : ""}`}
                                        onClick={() => {
                                          setSettledChoiceDraft(opt);
                                          setSettledAnswerDraft(opt);
                                        }}
                                      >
                                        {opt}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                <input
                                  aria-label={`Edit ${dec.id}`}
                                  className="input"
                                  value={settledAnswerDraft}
                                  disabled={busy}
                                  onChange={(e) => setSettledAnswerDraft(e.target.value)}
                                />
                                <div className="row-gap">
                                  <button
                                    type="button"
                                    className="btn btn-primary btn-sm"
                                    disabled={busy || !settledAnswerDraft.trim()}
                                    onClick={() => void saveDecisionAnswer(dec.id, settledChoiceDraft, settledAnswerDraft)}
                                  >
                                    Save decision
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    disabled={busy}
                                    onClick={() => setEditingDecisionId(null)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                <section className="studio-side-card">
                  <div className="section-head">
                    <h3>Brief &amp; write scope</h3>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-expanded={showBriefEditor}
                      onClick={() => setShowBriefEditor((v) => !v)}
                    >
                      {showBriefEditor ? "Hide editor" : "Edit brief & files"}
                    </button>
                  </div>
                  {!showBriefEditor ? (
                    <div className="stack-tight">
                      <p className="muted settled-question">{card.summary}</p>
                      <p className="hint mono">Files: {card.writePaths.join(", ") || "None declared"}</p>
                    </div>
                  ) : (
                    <form onSubmit={saveBriefAndScope} className="stack-tight">
                      <div className="field">
                        <label htmlFor="studio-brief-summary">Feature brief</label>
                        <textarea
                          id="studio-brief-summary"
                          className="textarea"
                          value={summaryDraft}
                          disabled={busy || readOnly}
                          onChange={(e) => setSummaryDraft(e.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="studio-brief-paths">Allowed relative write paths (comma-separated)</label>
                        <input
                          id="studio-brief-paths"
                          className="input mono"
                          value={writePathsDraft}
                          disabled={busy || readOnly}
                          onChange={(e) => setWritePathsDraft(e.target.value)}
                          placeholder="src/login/, tests/login.test.ts"
                        />
                      </div>
                      {!readOnly && (
                        <div className="row-gap">
                          <button type="submit" className="btn btn-sm" disabled={busy}>
                            Save brief &amp; scope
                          </button>
                        </div>
                      )}
                    </form>
                  )}
                </section>

                <section className="studio-side-card">
                  <div className="persona-bar">
                    <span>
                      <strong>Goldfish swarm:</strong> {selectedPersonas.length} of {GOLDFISH_PERSONAS.length} lenses
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-expanded={showPersonaPicker}
                      onClick={() => setShowPersonaPicker((v) => !v)}
                    >
                      {showPersonaPicker ? "Hide" : "Customize"}
                    </button>
                  </div>
                  {showPersonaPicker && (
                    <div className="stack-tight">
                      <p className="hint">Each Goldfish evaluates only the spec without seeing prior chat.</p>
                      <div className="persona-chips">
                        {GOLDFISH_PERSONAS.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            aria-pressed={selectedPersonas.includes(p.id)}
                            className={`persona-chip ${selectedPersonas.includes(p.id) ? "active" : ""}`}
                            onClick={() => togglePersona(p.id)}
                            title={p.lens}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {openFindings.length > 0 && (
                    <div className="stack-tight">
                      <div className="section-head">
                        <h3>Open challenges ({openFindings.length})</h3>
                        {!readOnly && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => void resolveAllFindings()}
                          >
                            Resolve all
                          </button>
                        )}
                      </div>
                      <ul className="plain-list">
                        {openFindings.map((f) => (
                          <FindingRow key={f.id} finding={f} busy={busy} readOnly={readOnly} onResolve={resolveFinding} />
                        ))}
                      </ul>
                    </div>
                  )}

                  {resolvedFindings.length > 0 && (
                    <details className="subtle-disclosure">
                      <summary>
                        <span>Resolved challenges</span>
                        <span className="count-pill tabular">{resolvedFindings.length}</span>
                      </summary>
                      <ul className="plain-list">
                        {resolvedFindings.map((f) => (
                          <FindingRow key={f.id} finding={f} busy={busy} readOnly={readOnly} />
                        ))}
                      </ul>
                    </details>
                  )}

                  {card.assumptions.length > 0 && (
                    <details className="subtle-disclosure" open={unverifiedAssumptions > 0}>
                      <summary>
                        <span>
                          Assumptions ({card.assumptions.length}
                          {unverifiedAssumptions > 0 ? `, ${unverifiedAssumptions} unverified` : ""})
                        </span>
                      </summary>
                      <ul className="plain-list">
                        {card.assumptions.map((a) => (
                          <li key={a.id} className="assumption">
                            <span className={`badge ${ASSUMPTION_BADGE[a.status]}`}>{a.status}</span>
                            <span className={`badge ${RISK_BADGE[a.riskIfFalse]}`}>risk {a.riskIfFalse}</span>
                            <span>{a.statement}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </section>
              </div>
            </div>
          )}

          {activeTab === "review" && (
            <>
              <p className="muted">
                Automated review checks AxiomSpec gates (G01–G14), the {OBSERVABILITY_MAX_BYTES.toLocaleString()}-byte
                Observability limit, an independent cross-family reviewer model, and a final Goldfish reassessment.
              </p>
              {!(card.goldfishSatisfied && card.userSatisfied) && (
                <p className="notice notice-warn">
                  Automated review unlocks once the Goldfish swarm has no open blockers or major items and you confirm
                  you are satisfied.
                </p>
              )}

              {busy && reviewStep && (
                <ol className="review-progress-list" aria-label="Automated review progress">
                  {REVIEW_STEPS.map((step, idx) => {
                    const done = activeReviewIdx > idx || reviewStep === "saved";
                    const current = activeReviewIdx === idx;
                    return (
                      <li
                        key={step.id}
                        className={`review-progress-step ${done ? "is-done" : ""} ${current ? "is-current" : ""}`}
                      >
                        <span className="stepper-num">{done ? "✓" : current ? "…" : idx + 1}</span>
                        <span>{step.label}</span>
                      </li>
                    );
                  })}
                </ol>
              )}

              <div className="row-gap">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || readOnly || !card.goldfishSatisfied || !card.userSatisfied}
                  onClick={() => void runReview()}
                >
                  {busy ? "Running review..." : review ? "Re-run review" : "Run review and reassessment"}
                </button>
                {card.reviewPassed && card.column !== "validated" && (
                  <button
                    type="button"
                    className="btn btn-success"
                    disabled={busy}
                    onClick={() => void moveCard("validated")}
                  >
                    Approve to Validated
                  </button>
                )}
                {review && !review.passed && !readOnly && (
                  <button type="button" className="btn" disabled={busy} onClick={jumpToFixInterview}>
                    Fix brief &amp; decisions in Interview →
                  </button>
                )}
                {card.column === "automated_review" && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => void moveCard("goldfish_interview")}
                  >
                    Back to interview
                  </button>
                )}
              </div>

              {review ? (
                <section className={`verdict-card ${review.passed ? "is-pass" : "is-fail"}`}>
                  <div className="verdict-head">
                    <span className="verdict-mark" aria-hidden="true">
                      {review.passed ? "✓" : "!"}
                    </span>
                    <div>
                      <h3>{review.passed ? "Review passed" : `Changes requested (${review.verdict})`}</h3>
                      <p className="muted mono">
                        {review.reviewerProvider}/{review.reviewerModel}
                      </p>
                    </div>
                  </div>
                  <div className="card-flags">
                    <span className={`badge ${review.crossFamilyVerified ? "badge-emerald" : "badge-warn"}`}>
                      {review.crossFamilyVerified
                        ? `Cross-family: ${review.reviewerVendorFamily} reviews ${review.drafterVendorFamily}`
                        : "Same vendor family"}
                    </span>
                    <span className={`badge ${review.axiomReport.valid ? "badge-emerald" : "badge-danger"}`}>
                      AxiomSpec {review.axiomReport.valid ? "valid" : "invalid"}
                    </span>
                    <span className="badge badge-neutral tabular">Risk {review.axiomReport.riskScore}</span>
                  </div>
                  <p>{review.summary}</p>
                  {review.mechanicalErrors.length > 0 && (
                    <ul className="error-list">
                      {review.mechanicalErrors.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  )}
                  {review.goldfishReassessmentFindings.length > 0 && (
                    <>
                      <h4>Reassessment findings</h4>
                      <ul className="plain-list">
                        {review.goldfishReassessmentFindings.map((f) => (
                          <FindingRow key={f.id} finding={f} busy={busy} readOnly />
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              ) : (
                <div className="empty-state">
                  <p>No review report yet. Click Run review and reassessment once dual satisfaction is confirmed.</p>
                </div>
              )}
            </>
          )}

          {activeTab === "spec" && (
            <>
              <div className="card-meta-row">
                <span className="tabular">
                  <strong>{mdBytes.toLocaleString()}</strong> / {OBSERVABILITY_MAX_BYTES.toLocaleString()} bytes
                </span>
                <div className="row-gap">
                  <span className={`badge ${mdBytes <= OBSERVABILITY_MAX_BYTES ? "badge-emerald" : "badge-danger"}`}>
                    {mdBytes <= OBSERVABILITY_MAX_BYTES ? "Within budget" : "Over budget"}
                  </span>
                  {card.draftMarkdown && (
                    <button type="button" className="btn btn-sm" onClick={() => void copyMarkdown()}>
                      {copiedSpec === "copied" ? "Copied" : copiedSpec === "failed" ? "Copy failed" : "Copy Markdown"}
                    </button>
                  )}
                </div>
              </div>
              <progress
                className="byte-meter"
                value={Math.min(mdBytes, OBSERVABILITY_MAX_BYTES)}
                max={OBSERVABILITY_MAX_BYTES}
                aria-label="Spec size"
              />
              {!readOnly && (
                <form onSubmit={saveWritePathsOnly} className="scope-form">
                  <div className="field">
                    <label htmlFor="drawer-write-paths">Write scope (comma-separated relative paths)</label>
                    <input
                      id="drawer-write-paths"
                      className="input mono"
                      value={writePathsDraft}
                      disabled={busy}
                      onChange={(e) => setWritePathsDraft(e.target.value)}
                      placeholder="src/"
                    />
                  </div>
                  <button type="submit" className="btn btn-sm" disabled={busy}>
                    Save scope
                  </button>
                </form>
              )}
              <pre className="code-block">
                {card.draftMarkdown || "The feature Markdown draft appears after Round 1."}
              </pre>
            </>
          )}

          {activeTab === "axiom" &&
            (review?.axiomReport ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Gate</th>
                      <th>Check</th>
                      <th>Status</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.axiomReport.gates.map((g) => (
                      <tr key={g.gateId}>
                        <td data-label="Gate" className="mono">
                          {g.gateId}
                        </td>
                        <td data-label="Check">{g.name}</td>
                        <td data-label="Status">
                          <span
                            className={`badge ${
                              g.passed ? "badge-emerald" : g.severity === "warning" ? "badge-warn" : "badge-danger"
                            }`}
                          >
                            {g.passed ? "Pass" : g.severity === "warning" ? "Warning" : "Fail"}
                          </span>
                        </td>
                        <td data-label="Detail">{g.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">
                <p>The AxiomSpec gate matrix (G01–G14) appears after the first automated review.</p>
              </div>
            ))}
        </div>
      </aside>
    </div>
  );
}
