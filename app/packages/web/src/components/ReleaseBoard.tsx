// Spec: knowledge/components/spec-studio.md
"use client";

import { useEffect, useState, type FormEvent } from "react";
import type {
  ProjectRecord,
  ReleaseRecord,
  TableauCard,
  TableauColumn,
} from "@aeion-spec/shared";
import { createApiClient, unwrap } from "../lib/api.ts";

interface ReleaseBoardProps {
  csrfToken: string;
  project: ProjectRecord;
  release: ReleaseRecord;
  cards: TableauCard[];
  archivedCards: TableauCard[];
  onRefresh: () => Promise<void>;
  onSelectCard: (card: TableauCard) => void;
}

type BoardColumn = Exclude<TableauColumn, "archived">;

const COLUMNS: Array<{ id: BoardColumn; step: number; label: string; hint: string }> = [
  { id: "idea", step: 1, label: "Ideas", hint: "Candidate features, not yet questioned" },
  {
    id: "goldfish_interview",
    step: 2,
    label: "Goldfish interview",
    hint: "Elephant and a fresh swarm until both sides are satisfied",
  },
  {
    id: "automated_review",
    step: 3,
    label: "Automated review",
    hint: "AxiomSpec gates, cross-family reviewer, reassessment",
  },
  { id: "validated", step: 4, label: "Validated", hint: "Approved and exportable through the Builder API" },
];

// The next minor version is the usual step after a sealed release; the owner can change it.
function suggestNextVersion(current: string): string {
  const parts = current.replace(/^v/i, "").split(".").map(Number);
  if (parts.length === 3 && parts.every((n) => Number.isInteger(n) && n >= 0)) {
    return `${parts[0]}.${(parts[1] ?? 0) + 1}.0`;
  }
  return "0.2.0";
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function ReleaseBoard({
  csrfToken,
  project,
  release,
  cards,
  archivedCards,
  onRefresh,
  onSelectCard,
}: ReleaseBoardProps) {
  const [showIdeaForm, setShowIdeaForm] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [area, setArea] = useState("foundation");
  const [phase, setPhase] = useState("P1");
  const [size, setSize] = useState<"S" | "M" | "L">("M");
  const [writePathsText, setWritePathsText] = useState("src/");

  const [editingRelease, setEditingRelease] = useState(false);
  const [relTitle, setRelTitle] = useState(release.title);
  const [relVer, setRelVer] = useState(release.version);

  const [showSealModal, setShowSealModal] = useState(false);
  const [nextTitle, setNextTitle] = useState("Next release");
  const [nextVersion, setNextVersion] = useState(() => suggestNextVersion(release.version));
  const [releaseNotes, setReleaseNotes] = useState("");
  const [sealError, setSealError] = useState<string | null>(null);

  const [dragCardId, setDragCardId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<BoardColumn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const client = createApiClient(csrfToken);

  // Escape closes the seal dialog unless a seal is in flight.
  useEffect(() => {
    if (!showSealModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setShowSealModal(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSealModal, busy]);

  const openSealModal = () => {
    setNextVersion(suggestNextVersion(release.version));
    setSealError(null);
    setShowSealModal(true);
  };

  const createIdea = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const writePaths = writePathsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await unwrap(
        client.api.projects({ projectId: project.id }).cards.post({
          title,
          summary,
          area,
          phase,
          size,
          writePaths,
          dependsOn: [],
        }),
      );
      setTitle("");
      setSummary("");
      setShowIdeaForm(false);
      await onRefresh();
    } catch (err) {
      setError(errorText(err, "The idea could not be created."));
    } finally {
      setBusy(false);
    }
  };

  const saveReleaseHeader = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await unwrap(
        client.api.projects({ projectId: project.id }).release.patch({
          title: relTitle,
          version: relVer,
        }),
      );
      setEditingRelease(false);
      await onRefresh();
    } catch (err) {
      setError(errorText(err, "The release header could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const moveCard = async (cardId: string, targetColumn: TableauColumn) => {
    setError(null);
    setBusy(true);
    try {
      const res = await unwrap(
        client.api.projects({ projectId: project.id }).cards({ cardId }).move.post({
          targetColumn,
        }),
      );
      await onRefresh();
      if (targetColumn === "goldfish_interview" || targetColumn === "automated_review") {
        onSelectCard(res.card);
      }
    } catch (err) {
      setError(errorText(err, "A workflow gate blocked the move."));
    } finally {
      setBusy(false);
    }
  };

  const sealRelease = async (e: FormEvent) => {
    e.preventDefault();
    setSealError(null);
    setBusy(true);
    try {
      await unwrap(
        client.api.projects({ projectId: project.id }).releases.validate.post({
          nextReleaseTitle: nextTitle,
          nextReleaseVersion: nextVersion,
          releaseNotes: releaseNotes.trim() || undefined,
          cleanValidatedCards: true,
        }),
      );
      setShowSealModal(false);
      setReleaseNotes("");
      await onRefresh();
    } catch (err) {
      setSealError(errorText(err, "The release could not be sealed."));
    } finally {
      setBusy(false);
    }
  };

  const validatedCount = cards.filter((c) => c.column === "validated").length;
  const sourceLabel = project.openshellSummary
    ? `${project.sourceKind} · ${project.openshellSummary.mode}`
    : project.sourceKind;

  return (
    <div className="stack">
      <section className="release-bar" aria-label="Active release">
        <div className="release-title-group">
          <span className="eyebrow">{project.name}</span>
          {!editingRelease ? (
            <div className="release-headline">
              <h1>{release.title}</h1>
              <span className="chip chip-version mono tabular">v{release.version}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setRelTitle(release.title);
                  setRelVer(release.version);
                  setEditingRelease(true);
                }}
              >
                Edit
              </button>
            </div>
          ) : (
            <form onSubmit={saveReleaseHeader} className="row-gap">
              <input
                aria-label="Release title"
                className="input"
                value={relTitle}
                onChange={(e) => setRelTitle(e.target.value)}
                required
              />
              <input
                aria-label="Release version"
                className="input input-short mono tabular"
                value={relVer}
                onChange={(e) => setRelVer(e.target.value)}
                required
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                Save
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setEditingRelease(false)}>
                Cancel
              </button>
            </form>
          )}
          <div className="release-stats">
            <div className="stat">
              <span className="stat-value tabular">
                {validatedCount}
                <span className="stat-of">/{cards.length}</span>
              </span>
              <span className="stat-label">validated</span>
            </div>
            <progress
              className="progress"
              value={validatedCount}
              max={Math.max(cards.length, 1)}
              aria-label="Validated features"
            />
            <span className="chip">Source: {sourceLabel}</span>
          </div>
        </div>

        <div className="release-actions">
          <button type="button" className="btn" onClick={() => setShowIdeaForm((s) => !s)}>
            {showIdeaForm ? "Close idea form" : "New idea"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={validatedCount === 0 || busy}
            onClick={openSealModal}
          >
            Seal release ({validatedCount})
          </button>
        </div>
      </section>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {showIdeaForm && (
        <form onSubmit={createIdea} className="panel stack">
          <div className="panel-header">
            <div>
              <h2>New idea</h2>
              <p className="muted">It lands in Ideas; the Goldfish interview questions it next.</p>
            </div>
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="idea-title">Feature title</label>
              <input
                id="idea-title"
                className="input"
                required
                minLength={3}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Idempotent webhook settlement"
              />
            </div>
            <div className="field">
              <label htmlFor="idea-paths">Write paths (comma-separated)</label>
              <input
                id="idea-paths"
                className="input mono"
                value={writePathsText}
                onChange={(e) => setWritePathsText(e.target.value)}
                placeholder="src/settlement/, tests/settlement/"
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="idea-summary">Problem and intent</label>
            <textarea
              id="idea-summary"
              className="textarea"
              required
              minLength={10}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Scope, actors, non-goals and the edge cases that matter."
            />
          </div>

          <div className="row-gap">
            <select aria-label="Area" className="select" value={area} onChange={(e) => setArea(e.target.value)}>
              <option value="foundation">Foundation</option>
              <option value="security">Security</option>
              <option value="ops">Ops</option>
              <option value="agents">Agents</option>
            </select>
            <select aria-label="Phase" className="select" value={phase} onChange={(e) => setPhase(e.target.value)}>
              <option value="P0">P0</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
            </select>
            <select
              aria-label="Size"
              className="select"
              value={size}
              onChange={(e) => setSize(e.target.value as "S" | "M" | "L")}
            >
              <option value="S">Size S</option>
              <option value="M">Size M</option>
              <option value="L">Size L</option>
            </select>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Add idea
            </button>
          </div>
        </form>
      )}

      <div className="tableau-grid">
        {COLUMNS.map((col) => {
          const colCards = cards.filter((c) => c.column === col.id);
          return (
            <section
              key={col.id}
              className={`tableau-col ${dropTarget === col.id ? "is-drop" : ""}`}
              aria-label={col.label}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragCardId) setDropTarget(col.id);
              }}
              onDragLeave={() => setDropTarget((t) => (t === col.id ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget(null);
                if (dragCardId) {
                  void moveCard(dragCardId, col.id);
                  setDragCardId(null);
                }
              }}
            >
              <header className="tableau-col-header">
                <span className="step-dot tabular" aria-hidden="true">
                  {col.step}
                </span>
                <span className="tableau-col-title">{col.label}</span>
                <span className="count-pill tabular">{colCards.length}</span>
              </header>
              <p className="col-hint">{col.hint}</p>

              {colCards.length === 0 && <div className="col-empty">No cards here yet</div>}

              {colCards.map((card) => (
                <article
                  key={card.id}
                  className="kanban-card"
                  draggable
                  onDragStart={() => setDragCardId(card.id)}
                  onDragEnd={() => {
                    setDragCardId(null);
                    setDropTarget(null);
                  }}
                >
                  <div className="card-meta-row">
                    <span className="chip mono">{card.featureCode}</span>
                    <span className="chip">{card.area}</span>
                    <span className="chip">{card.phase}</span>
                    <span className="chip">Size {card.size}</span>
                  </div>

                  <button type="button" className="card-title" onClick={() => onSelectCard(card)}>
                    {card.title}
                  </button>
                  <p className="card-summary">{card.summary}</p>

                  {(card.goldfishRound > 0 || card.userSatisfied || card.reviewPassed) && (
                    <div className="card-flags">
                      {card.goldfishRound > 0 && (
                        <span className={`badge ${card.goldfishSatisfied ? "badge-emerald" : "badge-warn"}`}>
                          Round {card.goldfishRound}: {card.goldfishSatisfied ? "swarm satisfied" : "open questions"}
                        </span>
                      )}
                      {card.userSatisfied && <span className="badge badge-emerald">Owner satisfied</span>}
                      {card.reviewPassed && <span className="badge badge-emerald">Review passed</span>}
                    </div>
                  )}

                  <div className="card-actions">
                    <button type="button" className="btn btn-sm" onClick={() => onSelectCard(card)}>
                      Open
                    </button>

                    {card.column === "idea" && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={() => void moveCard(card.id, "goldfish_interview")}
                      >
                        Start interview
                      </button>
                    )}

                    {card.column === "goldfish_interview" && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy || !card.goldfishSatisfied || !card.userSatisfied}
                        title={
                          !card.goldfishSatisfied || !card.userSatisfied
                            ? "Needs both the swarm and the owner to be satisfied"
                            : undefined
                        }
                        onClick={() => void moveCard(card.id, "automated_review")}
                      >
                        Run review
                      </button>
                    )}

                    {card.column === "automated_review" && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy || !card.reviewPassed}
                        onClick={() => void moveCard(card.id, "validated")}
                      >
                        Validate
                      </button>
                    )}

                    <button
                      type="button"
                      className="btn btn-ghost btn-sm card-archive"
                      disabled={busy}
                      onClick={() => void moveCard(card.id, "archived")}
                    >
                      Archive
                    </button>
                  </div>
                </article>
              ))}
            </section>
          );
        })}
      </div>

      {archivedCards.length > 0 && (
        <details className="archive-shelf">
          <summary>
            <span>Archived in this release</span>
            <span className="count-pill tabular">{archivedCards.length}</span>
          </summary>
          <ul className="archive-list">
            {archivedCards.map((card) => (
              <li key={card.id} className="archive-row">
                <span className="chip mono">{card.featureCode}</span>
                <span className="archive-title">{card.title}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void moveCard(card.id, "idea")}
                >
                  Restore to Ideas
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {showSealModal && (
        <div className="backdrop-center" role="dialog" aria-modal="true" aria-labelledby="seal-title">
          <form onSubmit={sealRelease} className="modal-box">
            <div>
              <span className="eyebrow">Seal release</span>
              <h2 id="seal-title">
                {release.title} <span className="mono tabular">v{release.version}</span>
              </h2>
              <p className="muted">
                The <strong>{validatedCount}</strong> validated features are compiled into a signed{" "}
                <span className="mono">axiomspec/0.3</span> snapshot, moved to the release history, and the
                board starts the next release clean.
              </p>
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="next-rel-title">Next release title</label>
                <input
                  id="next-rel-title"
                  className="input"
                  required
                  value={nextTitle}
                  onChange={(e) => setNextTitle(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="next-rel-ver">Next version</label>
                <input
                  id="next-rel-ver"
                  className="input mono tabular"
                  required
                  pattern="^v?\d+\.\d+\.\d+$"
                  value={nextVersion}
                  onChange={(e) => setNextVersion(e.target.value)}
                />
                <span className="hint">Must be greater than {release.version}.</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="rel-notes">Release notes (optional)</label>
              <textarea
                id="rel-notes"
                className="textarea"
                maxLength={4000}
                value={releaseNotes}
                onChange={(e) => setReleaseNotes(e.target.value)}
                placeholder="What this release settles, in a few lines."
              />
            </div>
            {sealError && (
              <div className="error-banner" role="alert">
                {sealError}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => setShowSealModal(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "Sealing…" : "Seal and start next release"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
