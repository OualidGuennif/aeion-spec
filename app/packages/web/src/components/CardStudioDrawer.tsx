// Spec: knowledge/components/spec-studio.md
"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  GOLDFISH_PERSONAS,
  OBSERVABILITY_MAX_BYTES,
  type FindingSeverity,
  type GoldfishFinding,
  type GoldfishPersonaId,
  type TableauCard,
  type TableauColumn,
} from "@aeion-spec/shared";
import { createApiClient, unwrap } from "../lib/api.ts";

interface CardStudioDrawerProps {
  csrfToken: string;
  projectId: string;
  card: TableauCard;
  initialTab?: StudioTab;
  onClose: () => void;
  onCardUpdated: (card: TableauCard) => void;
}

type StudioTab = "interview" | "review" | "spec" | "axiom";

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

function personaLabel(id: string | null): string {
  return GOLDFISH_PERSONAS.find((p) => p.id === id)?.label ?? id ?? "";
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// The server answers a refused stream with JSON `{ error }`; plain text falls through unchanged.
async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Plain-text error response.
  }
  return text || `The interview request failed (${res.status}).`;
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
  onClose,
  onCardUpdated,
}: CardStudioDrawerProps) {
  const [activeTab, setActiveTab] = useState<StudioTab>(initialTab);
  const [selectedPersonas, setSelectedPersonas] = useState<GoldfishPersonaId[]>(card.activePersonas);
  const [showPersonaPicker, setShowPersonaPicker] = useState(false);
  const [message, setMessage] = useState("");
  const [decisionDrafts, setDecisionDrafts] = useState<Record<string, string>>({});
  const [writePathsDraft, setWritePathsDraft] = useState(card.writePaths.join(", "));
  const [copiedSpec, setCopiedSpec] = useState<"idle" | "copied" | "failed">("idle");
  const [busy, setBusy] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const readOnly = card.column === "archived";

  useEffect(() => {
    setWritePathsDraft(card.writePaths.join(", "));
  }, [card.id, card.writePaths]);

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

  const togglePersona = (id: GoldfishPersonaId) => {
    setSelectedPersonas((prev) =>
      prev.includes(id) ? (prev.length > 1 ? prev.filter((x) => x !== id) : prev) : [...prev, id],
    );
  };

  const runInterviewTurn = async (e: FormEvent) => {
    e.preventDefault();
    const decisionAnswers = Object.entries(decisionDrafts)
      .filter(([, text]) => text.trim().length > 0)
      .map(([decisionId, answerText]) => ({ decisionId, answerText: answerText.trim() }));
    if (!message.trim() && decisionAnswers.length === 0) return;
    setError(null);
    setBusy(true);
    setStreamStatus("Connecting to Elephant and the Goldfish swarm...");

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const res = await fetch(`/api/projects/${projectId}/cards/${card.id}/interview/stream`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Aeion": "1", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({
          message: message.trim() || "Reassess the settled decisions with fresh Goldfish contexts.",
          decisionAnswers,
          personas: selectedPersonas,
        }),
      });
      if (!res.ok || !res.body) throw new Error(await readErrorBody(res));

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;

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
          let data: { card?: TableauCard; message?: string; persona?: string; error?: string };
          try {
            data = JSON.parse(dataMatch[1]!);
          } catch {
            continue;
          }
          const evType = eventMatch[1]!.trim();
          if (evType === "progress") {
            setStreamStatus(
              data.message || (data.persona ? `Goldfish (${personaLabel(data.persona)}) is reviewing...` : "Working..."),
            );
          } else if (evType === "complete" && data.card) {
            completed = true;
            onCardUpdated(data.card);
            setMessage("");
            setDecisionDrafts({});
          } else if (evType === "error") {
            throw new Error(data.error || "The agent round failed.");
          }
        }
      }
      // A stream that closes without a complete event failed mid-flight.
      if (!completed) throw new Error("The interview stream ended before the round completed.");
    } catch (err) {
      setError(errorText(err, "The interview round failed."));
    } finally {
      void reader?.cancel().catch(() => undefined);
      setBusy(false);
      setStreamStatus(null);
    }
  };

  const callCard = async (fn: () => Promise<{ card: TableauCard }>, fallback: string, then?: () => void) => {
    setError(null);
    setBusy(true);
    try {
      const res = await fn();
      onCardUpdated(res.card);
      then?.();
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const cardApi = () => createApiClient(csrfToken).api.projects({ projectId }).cards({ cardId: card.id });

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

  const runReview = () =>
    callCard(() => unwrap(cardApi().review.post()), "The automated review failed.", () => setActiveTab("review"));

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

  const saveWritePaths = (e: FormEvent) => {
    e.preventDefault();
    const writePaths = writePathsDraft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (writePaths.length === 0) return setError("Enter at least one relative write path.");
    return callCard(
      () => unwrap(cardApi().patch({ writePaths })),
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

  const mdBytes = new TextEncoder().encode(card.draftMarkdown || "").length;
  const openDecisions = card.decisions.filter((d) => !d.resolved);
  const openFindings = card.findings.filter((f) => !f.resolved);
  const resolvedFindings = card.findings.filter((f) => f.resolved);
  const unverifiedAssumptions = card.assumptions.filter((a) => a.status === "unverified").length;
  const review = card.latestReview;

  const blockingFindings = openFindings.filter((f) => f.severity === "BLOCKER" || f.severity === "MAJOR").length;
  const blockingDecisions = openDecisions.filter((d) => d.blocking).length;
  const openSwarmItems = openFindings.length + blockingDecisions;

  const blockersToReview: string[] = [];
  if (card.goldfishRound === 0) {
    blockersToReview.push("Run at least one Goldfish round");
  } else {
    if (blockingFindings > 0) {
      blockersToReview.push(`resolve ${blockingFindings} blocker or major challenge${blockingFindings === 1 ? "" : "s"}`);
    }
    if (blockingDecisions > 0) {
      blockersToReview.push(`answer ${blockingDecisions} blocking decision${blockingDecisions === 1 ? "" : "s"}`);
    }
    if (!card.userSatisfied) {
      blockersToReview.push("click I am satisfied");
    }
  }

  const tabs: Array<{ id: StudioTab; label: string }> = [
    { id: "interview", label: openSwarmItems > 0 ? `Interview (${openSwarmItems})` : "Interview" },
    { id: "review", label: card.reviewPassed ? "Review ✓" : "Review" },
    { id: "spec", label: "Spec" },
    { id: "axiom", label: "Gates" },
  ];

  const swarmStatusClass = card.goldfishRound === 0 ? "" : card.goldfishSatisfied ? "is-ok" : "is-open";
  const swarmStatusText =
    card.goldfishRound === 0
      ? "Swarm: not started"
      : card.goldfishSatisfied
        ? "Swarm: satisfied"
        : openSwarmItems > 0
          ? `Swarm: ${openSwarmItems} open item${openSwarmItems === 1 ? "" : "s"}`
          : "Swarm: needs another round";

  const ownerStatusClass = card.userSatisfied ? "is-ok" : card.goldfishRound === 0 ? "" : "is-open";
  const ownerStatusText = card.userSatisfied
    ? "Owner: confirmed"
    : card.goldfishRound === 0
      ? "Owner: waiting on interview"
      : "Owner: confirmation needed";

  const reviewStatusClass = card.reviewPassed ? "is-ok" : review ? "is-open" : "";
  const reviewStatusText = card.reviewPassed ? "Review: passed" : review ? "Review: needs fixes" : "Review: not run";

  let nextStepHint = "Send your first note below so Elephant and the Goldfish swarm can examine this feature.";
  if (card.column === "archived") {
    nextStepHint = "This feature is archived. Restore it to Ideas from Workspace to edit it.";
  } else if (card.column === "validated") {
    nextStepHint = "This feature passed review and is ready to include when you seal the release.";
  } else if (card.column === "automated_review") {
    nextStepHint = card.reviewPassed
      ? "Automated review passed. Open the Review tab and click Approve to Validated."
      : "Open the Review tab and click Run review and reassessment.";
  } else if (card.column === "idea" && card.messages.length === 0) {
    nextStepHint = "Describe edge cases and limits below, then click Send and start round 1 to begin the interview.";
  } else if (card.goldfishSatisfied && card.userSatisfied) {
    nextStepHint = "Both you and the Goldfish swarm are satisfied. Click Move to review below.";
  } else if (card.goldfishRound > 0) {
    nextStepHint = "Answer open decisions or resolve challenges above, run another round, then confirm you are satisfied.";
  }

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
              <span className="chip tabular">Round {card.goldfishRound}</span>
            </div>
            <h2 id="studio-title">{card.title}</h2>
            <div className="status-row">
              <span className={`status-pill ${swarmStatusClass}`}>{swarmStatusText}</span>
              <span className={`status-pill ${ownerStatusClass}`}>{ownerStatusText}</span>
              <span className={`status-pill ${reviewStatusClass}`}>{reviewStatusText}</span>
            </div>
          </div>
          <button ref={closeRef} type="button" className="icon-btn" aria-label="Close studio" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="next-step-bar">
          <strong>Next step:</strong> {nextStepHint}
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
              {error}
            </div>
          )}
          {streamStatus && (
            <div className="live-status" role="status">
              <span className="spinner" aria-hidden="true" />
              {streamStatus}
            </div>
          )}

          {activeTab === "interview" && (
            <>
              <section className="studio-section">
                <div className="persona-bar">
                  <span>
                    <strong>Goldfish panel:</strong> {selectedPersonas.length} of {GOLDFISH_PERSONAS.length} active
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-expanded={showPersonaPicker}
                    onClick={() => setShowPersonaPicker((v) => !v)}
                  >
                    {showPersonaPicker ? "Hide reviewers" : "Customize"}
                  </button>
                </div>
                {showPersonaPicker && (
                  <div className="stack-tight">
                    <p className="hint">Each Goldfish evaluates only the draft spec without seeing prior chat.</p>
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
              </section>

              {openDecisions.length > 0 && (
                <section className="studio-section">
                  <h3>Open decisions ({openDecisions.length})</h3>
                  <p className="hint">
                    Answering a decision also confirms the unverified assumptions attached to this feature.
                  </p>
                  {openDecisions.map((dec) => (
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
                              aria-pressed={decisionDrafts[dec.id] === opt}
                              className={`choice ${decisionDrafts[dec.id] === opt ? "active" : ""}`}
                              onClick={() => setDecisionDrafts((prev) => ({ ...prev, [dec.id]: opt }))}
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      )}
                      <input
                        id={`dec-${dec.id}`}
                        className="input"
                        value={decisionDrafts[dec.id] ?? ""}
                        onChange={(e) => setDecisionDrafts((prev) => ({ ...prev, [dec.id]: e.target.value }))}
                        placeholder="Your answer and rationale"
                      />
                    </div>
                  ))}
                </section>
              )}

              {openFindings.length > 0 && (
                <section className="studio-section">
                  <div className="section-head">
                    <h3>Open Goldfish challenges ({openFindings.length})</h3>
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
                </section>
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

              <section className="chat-feed studio-section" aria-label="Interview transcript">
                {card.messages.length === 0 ? (
                  <p className="muted">No messages yet. Send your first note below to begin round 1.</p>
                ) : (
                  card.messages.map((m) => (
                    <div key={m.id} className={`msg-bubble role-${m.role}`}>
                      <div className="msg-meta">
                        <strong>{m.role === "goldfish" ? `Goldfish · ${personaLabel(m.persona)}` : m.role}</strong>
                        {m.modelUsed && <span className="mono">{m.modelUsed}</span>}
                        {m.contextIsolated && <span className="badge badge-info">Fresh context</span>}
                      </div>
                      <div className="msg-text">{m.content}</div>
                    </div>
                  ))
                )}
              </section>
            </>
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
              <div className="row-gap">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || readOnly || !card.goldfishSatisfied || !card.userSatisfied}
                  onClick={() => void runReview()}
                >
                  {busy ? "Running gates..." : review ? "Re-run review" : "Run review and reassessment"}
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
                {card.column === "automated_review" && (
                  <button
                    type="button"
                    className="btn"
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
                  <p>No review report yet. Run the review once the interview reaches dual satisfaction.</p>
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
                <form onSubmit={saveWritePaths} className="scope-form">
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
                {card.draftMarkdown || "The feature Markdown draft appears after round 1."}
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

        {activeTab === "interview" && (
          <footer className="drawer-footer">
            <p className={`readiness-line ${blockersToReview.length === 0 ? "is-ready" : ""}`}>
              {blockersToReview.length === 0
                ? "Ready for automated review: both you and the Goldfish swarm are satisfied."
                : `Next to unlock review: ${blockersToReview.join(", ")}.`}
            </p>
            <form onSubmit={runInterviewTurn} className="composer">
              <label htmlFor="interview-input" className="sr-only">
                Your reply to Elephant
              </label>
              <textarea
                id="interview-input"
                className="textarea"
                value={message}
                disabled={readOnly}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Clarify failure modes, non-goals, and limits, or answer the open decisions above."
              />
              <div className="composer-actions">
                <button type="submit" className="btn btn-primary" disabled={busy || readOnly}>
                  {busy
                    ? "Running round..."
                    : card.goldfishRound === 0
                      ? "Send and start round 1"
                      : "Send and run round"}
                </button>
                <button
                  type="button"
                  className={`btn ${card.userSatisfied ? "btn-success" : ""}`}
                  aria-pressed={card.userSatisfied}
                  disabled={busy || readOnly}
                  onClick={() => void toggleUserSatisfaction(!card.userSatisfied)}
                >
                  {card.userSatisfied ? "Confirmed ✓" : "I am satisfied"}
                </button>
                {(card.column === "idea" || card.column === "goldfish_interview") && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || readOnly || !card.goldfishSatisfied || !card.userSatisfied}
                    onClick={() => void moveCard("automated_review")}
                  >
                    Move to review
                  </button>
                )}
              </div>
            </form>
          </footer>
        )}
      </aside>
    </div>
  );
}
