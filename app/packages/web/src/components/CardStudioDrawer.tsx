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
  onClose: () => void;
  onCardUpdated: (card: TableauCard) => void;
}

type StudioTab = "interview" | "review" | "spec" | "axiom";

const COLUMN_LABEL: Record<TableauColumn, string> = {
  idea: "Idea",
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

// The server answers a refused stream with JSON `{ error }`; anything else is shown as is.
async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON.
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

export function CardStudioDrawer({ csrfToken, projectId, card, onClose, onCardUpdated }: CardStudioDrawerProps) {
  const [activeTab, setActiveTab] = useState<StudioTab>("interview");
  const [selectedPersonas, setSelectedPersonas] = useState<GoldfishPersonaId[]>(card.activePersonas);
  const [message, setMessage] = useState("");
  const [decisionDrafts, setDecisionDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const readOnly = card.column === "archived";

  // Focus lands inside the dialog, and Escape closes it unless an agent turn is running.
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
    setStreamStatus("Connecting to the Elephant and the Goldfish swarm…");

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
              data.message || (data.persona ? `Goldfish ${personaLabel(data.persona)} is reviewing…` : "Working…"),
            );
          } else if (evType === "complete" && data.card) {
            completed = true;
            onCardUpdated(data.card);
            setMessage("");
            setDecisionDrafts({});
          } else if (evType === "error") {
            throw new Error(data.error || "The agent turn failed.");
          }
        }
      }
      // A stream that closes without a result is a failure, never a silent success.
      if (!completed) throw new Error("The interview stream ended before the turn completed.");
    } catch (err) {
      setError(errorText(err, "The interview failed."));
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
    callCard(() => unwrap(cardApi().satisfy.post({ userSatisfied: satisfied })), "The update failed.");

  const moveCard = (targetColumn: TableauColumn) =>
    callCard(() => unwrap(cardApi().move.post({ targetColumn })), "A workflow gate blocked the move.");

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
      "The finding could not be resolved.",
    );

  const mdBytes = new TextEncoder().encode(card.draftMarkdown || "").length;
  const openDecisions = card.decisions.filter((d) => !d.resolved);
  const openFindings = card.findings.filter((f) => !f.resolved).length;
  const review = card.latestReview;

  const tabs: Array<{ id: StudioTab; label: string }> = [
    { id: "interview", label: openFindings > 0 ? `Interview · ${openFindings}` : "Interview" },
    { id: "review", label: "Review" },
    { id: "spec", label: "Spec" },
    { id: "axiom", label: "Gates" },
  ];

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
              <span className={`status-pill ${card.goldfishSatisfied ? "is-ok" : "is-open"}`}>
                Swarm {card.goldfishSatisfied ? "satisfied" : "has open questions"}
              </span>
              <span className={`status-pill ${card.userSatisfied ? "is-ok" : "is-open"}`}>
                Owner {card.userSatisfied ? "satisfied" : "not yet satisfied"}
              </span>
              <span className={`status-pill ${card.reviewPassed ? "is-ok" : "is-open"}`}>
                Review {card.reviewPassed ? "passed" : "not passed"}
              </span>
            </div>
          </div>
          <button ref={closeRef} type="button" className="icon-btn" aria-label="Close studio" onClick={onClose}>
            ×
          </button>
        </header>

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
            <div className="notice">This card is archived and read-only. Restore it to Ideas from the board.</div>
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
                <h3>Next round reviewers</h3>
                <p className="muted">Each Goldfish starts from a fresh context with no shared history.</p>
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
              </section>

              {openDecisions.length > 0 && (
                <section className="studio-section panel-inset">
                  <h3>Open decisions</h3>
                  <p className="muted">Answering a decision also confirms the unverified assumptions listed below.</p>
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
                        placeholder="Your answer and why"
                      />
                    </div>
                  ))}
                </section>
              )}

              {card.assumptions.length > 0 && (
                <section className="studio-section">
                  <h3>Assumptions</h3>
                  <ul className="plain-list">
                    {card.assumptions.map((a) => (
                      <li key={a.id} className="assumption">
                        <span className={`badge ${ASSUMPTION_BADGE[a.status]}`}>{a.status}</span>
                        <span className={`badge ${RISK_BADGE[a.riskIfFalse]}`}>risk {a.riskIfFalse}</span>
                        <span>{a.statement}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {card.findings.length > 0 && (
                <section className="studio-section">
                  <h3>Goldfish challenges</h3>
                  <ul className="plain-list">
                    {card.findings.map((f) => (
                      <FindingRow key={f.id} finding={f} busy={busy} readOnly={readOnly} onResolve={resolveFinding} />
                    ))}
                  </ul>
                </section>
              )}

              <section className="chat-feed" aria-label="Interview transcript">
                {card.messages.length === 0 && (
                  <p className="muted">No messages yet. Describe the feature to start the first round.</p>
                )}
                {card.messages.map((m) => (
                  <div key={m.id} className={`msg-bubble role-${m.role}`}>
                    <div className="msg-meta">
                      <strong>{m.role === "goldfish" ? `Goldfish · ${personaLabel(m.persona)}` : m.role}</strong>
                      {m.modelUsed && <span className="mono">{m.modelUsed}</span>}
                      {m.contextIsolated && <span className="badge badge-info">Fresh context</span>}
                    </div>
                    <div className="msg-text">{m.content}</div>
                  </div>
                ))}
              </section>

              <form onSubmit={runInterviewTurn} className="composer">
                <label htmlFor="interview-input" className="sr-only">
                  Your answer to the Elephant
                </label>
                <textarea
                  id="interview-input"
                  className="textarea"
                  value={message}
                  disabled={readOnly}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Clarify failure modes, non-goals and limits, or answer the decisions above."
                />
                <div className="composer-actions">
                  <button type="submit" className="btn btn-primary" disabled={busy || readOnly}>
                    {busy ? "Running the swarm…" : "Send and challenge"}
                  </button>
                  <button
                    type="button"
                    className={`btn ${card.userSatisfied ? "btn-success" : ""}`}
                    aria-pressed={card.userSatisfied}
                    disabled={busy || readOnly}
                    onClick={() => void toggleUserSatisfaction(!card.userSatisfied)}
                  >
                    {card.userSatisfied ? "I am satisfied ✓" : "I am satisfied"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || readOnly || !card.goldfishSatisfied || !card.userSatisfied}
                    onClick={() => void moveCard("automated_review")}
                  >
                    Run review
                  </button>
                </div>
              </form>
            </>
          )}

          {activeTab === "review" && (
            <>
              {!(card.goldfishSatisfied && card.userSatisfied) && (
                <p className="notice notice-warn">
                  The review runs once the swarm has no open questions and you have confirmed you are satisfied.
                </p>
              )}
              <div className="row-gap">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || readOnly || !card.goldfishSatisfied || !card.userSatisfied}
                  onClick={() => void runReview()}
                >
                  {busy ? "Running the gates…" : "Run review and reassessment"}
                </button>
                {card.reviewPassed && card.column !== "validated" && (
                  <button type="button" className="btn btn-success" disabled={busy} onClick={() => void moveCard("validated")}>
                    Validate
                  </button>
                )}
                {card.column === "automated_review" && (
                  <button type="button" className="btn" disabled={busy} onClick={() => void moveCard("goldfish_interview")}>
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
                      <h3>{review.passed ? "Review passed" : `Not approved · ${review.verdict}`}</h3>
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
                  <p>No review yet. Run it once the swarm and you are both satisfied.</p>
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
                <span className={`badge ${mdBytes <= OBSERVABILITY_MAX_BYTES ? "badge-emerald" : "badge-danger"}`}>
                  {mdBytes <= OBSERVABILITY_MAX_BYTES ? "Within budget" : "Over the limit"}
                </span>
              </div>
              <progress
                className="byte-meter"
                value={Math.min(mdBytes, OBSERVABILITY_MAX_BYTES)}
                max={OBSERVABILITY_MAX_BYTES}
                aria-label="Spec size"
              />
              <pre className="code-block">
                {card.draftMarkdown || "The draft appears after the first interview round."}
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
                        <td className="mono">{g.gateId}</td>
                        <td>{g.name}</td>
                        <td>
                          <span className={`badge ${g.passed ? "badge-emerald" : g.severity === "warning" ? "badge-warn" : "badge-danger"}`}>
                            {g.passed ? "Pass" : g.severity === "warning" ? "Warning" : "Fail"}
                          </span>
                        </td>
                        <td>{g.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">
                <p>The AxiomSpec gate matrix appears after the first automated review.</p>
              </div>
            ))}
        </div>
      </aside>
    </div>
  );
}
