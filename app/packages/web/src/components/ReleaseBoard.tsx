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
  llmKeyCount: number;
  onOpenKeys: () => void;
  onRefresh: () => Promise<void>;
  onSelectCard: (card: TableauCard, tab?: "interview" | "review" | "spec" | "axiom") => void;
}

type BoardColumn = Exclude<TableauColumn, "archived">;
type StageFilter = "all" | BoardColumn;

const STAGES: Array<{ id: BoardColumn; step: number; short: string; label: string; hint: string }> = [
  { id: "idea", step: 1, short: "Ideas", label: "Step 1 · Ideas", hint: "Define scope and target files" },
  {
    id: "goldfish_interview",
    step: 2,
    short: "Interview",
    label: "Step 2 · Interview",
    hint: "Clarify gaps with Elephant and Goldfish",
  },
  {
    id: "automated_review",
    step: 3,
    short: "Review",
    label: "Step 3 · Review",
    hint: "Pass AxiomSpec gates and cross-family check",
  },
  { id: "validated", step: 4, short: "Validated", label: "Step 4 · Validated", hint: "Ready to seal for builders" },
];

// Suggest the next minor version after a seal; the owner can change it in the dialog.
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
  llmKeyCount,
  onOpenKeys,
  onRefresh,
  onSelectCard,
}: ReleaseBoardProps) {
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
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

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const client = createApiClient(csrfToken);

  // Escape closes the seal dialog unless a seal request is in flight.
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
      setStageFilter("all");
      await onRefresh();
    } catch (err) {
      setError(errorText(err, "The feature could not be created."));
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
      setError(errorText(err, "The release details could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const moveCard = async (
    cardId: string,
    targetColumn: TableauColumn,
    openTab?: "interview" | "review" | "spec" | "axiom",
  ) => {
    setError(null);
    setBusy(true);
    try {
      const res = await unwrap(
        client.api.projects({ projectId: project.id }).cards({ cardId }).move.post({
          targetColumn,
        }),
      );
      await onRefresh();
      if (openTab) {
        onSelectCard(res.card, openTab);
      } else if (targetColumn === "goldfish_interview" || targetColumn === "automated_review") {
        onSelectCard(res.card, targetColumn === "automated_review" ? "review" : "interview");
      }
    } catch (err) {
      setError(errorText(err, "A workflow gate blocked that move."));
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
    ? `${project.sourceKind} (${project.openshellSummary.mode})`
    : project.sourceKind;

  const visibleCards = stageFilter === "all" ? cards : cards.filter((c) => c.column === stageFilter);

  return (
    <div className="stack">
      <header className="release-header">
        <div className="release-title-group">
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
          <div className="release-meta-line">
            <span>{project.name}</span>
            <span>Source: {sourceLabel}</span>
            <span className="tabular">
              {validatedCount} of {cards.length} validated
            </span>
          </div>
        </div>

        <div className="release-actions">
          <button type="button" className="btn btn-primary" onClick={() => setShowIdeaForm((s) => !s)}>
            {showIdeaForm ? "Close form" : "+ New feature"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={validatedCount === 0 || busy}
            title={validatedCount === 0 ? "Validate at least one feature before sealing." : undefined}
            onClick={openSealModal}
          >
            Seal release ({validatedCount})
          </button>
        </div>
      </header>

      {llmKeyCount === 0 && (
        <div className="inline-tip" role="status">
          <span>Need live AI runs? Add an API key in Keys first (skip this in mock mode).</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenKeys}>
            Open Keys →
          </button>
        </div>
      )}

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
              <h2>New feature</h2>
              <p className="muted">Starts at Step 1 (Ideas), then moves into a Goldfish interview when ready.</p>
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
            <label htmlFor="idea-summary">Problem and goal</label>
            <textarea
              id="idea-summary"
              className="textarea"
              required
              minLength={10}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Describe what should happen, who uses it, and which failures matter."
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
            <button type="button" className="btn btn-ghost" onClick={() => setShowIdeaForm(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Adding..." : "Add feature"}
            </button>
          </div>
        </form>
      )}

      <nav className="pipeline-bar" aria-label="Pipeline stages">
        <button
          type="button"
          className={`pipeline-tab ${stageFilter === "all" ? "active" : ""}`}
          onClick={() => setStageFilter("all")}
        >
          <span>All</span>
          <span className="count-pill tabular">{cards.length}</span>
        </button>
        {STAGES.map((stage) => {
          const count = cards.filter((c) => c.column === stage.id).length;
          return (
            <button
              key={stage.id}
              type="button"
              className={`pipeline-tab ${stageFilter === stage.id ? "active" : ""}`}
              onClick={() => setStageFilter(stage.id)}
            >
              <span>
                {stage.step}. {stage.short}
              </span>
              <span className="count-pill tabular">{count}</span>
            </button>
          );
        })}
      </nav>

      {cards.length === 0 && !showIdeaForm ? (
        <div className="stack">
          <div className="step-guide" aria-label="How the workflow runs">
            {STAGES.map((stage) => (
              <div key={stage.id} className="step-guide-item">
                <strong>{stage.label}</strong>
                <span>{stage.hint}</span>
              </div>
            ))}
          </div>
          <div className="empty-state stack">
            <p>No features in this release yet. Add your first feature to begin Step 1.</p>
            <div>
              <button type="button" className="btn btn-primary" onClick={() => setShowIdeaForm(true)}>
                + New feature
              </button>
            </div>
          </div>
        </div>
      ) : visibleCards.length === 0 ? (
        <div className="empty-state stack">
          <p>No features in {STAGES.find((s) => s.id === stageFilter)?.short ?? "this stage"} right now.</p>
          <div>
            <button type="button" className="btn" onClick={() => setStageFilter("all")}>
              Show all features
            </button>
          </div>
        </div>
      ) : (
        <div className="feature-list">
          {visibleCards.map((card) => {
            const stage = STAGES.find((s) => s.id === card.column) ?? STAGES[0]!;
            return (
              <article key={card.id} className="feature-row">
                <div className="feature-row-main">
                  <div className="card-meta-row">
                    <span className={`badge ${card.column === "validated" ? "badge-emerald" : "badge-warm"}`}>
                      {stage.label}
                    </span>
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
                          Round {card.goldfishRound}: {card.goldfishSatisfied ? "swarm satisfied" : "open items"}
                        </span>
                      )}
                      {card.userSatisfied && <span className="badge badge-emerald">Owner confirmed</span>}
                      {card.reviewPassed && <span className="badge badge-emerald">Review passed</span>}
                    </div>
                  )}
                </div>

                <div className="feature-row-actions">
                  {card.column === "idea" && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => void moveCard(card.id, "goldfish_interview", "interview")}
                    >
                      Start interview →
                    </button>
                  )}

                  {card.column === "goldfish_interview" &&
                    (card.goldfishSatisfied && card.userSatisfied ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={() => void moveCard(card.id, "automated_review", "review")}
                      >
                        Send to review →
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => onSelectCard(card, "interview")}
                      >
                        Continue interview →
                      </button>
                    ))}

                  {card.column === "automated_review" &&
                    (card.reviewPassed ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={() => void moveCard(card.id, "validated")}
                      >
                        Validate →
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => onSelectCard(card, "review")}
                      >
                        Run review →
                      </button>
                    ))}

                  {card.column === "validated" && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => onSelectCard(card, "spec")}
                    >
                      Inspect spec
                    </button>
                  )}

                  <button type="button" className="btn btn-sm" onClick={() => onSelectCard(card)}>
                    Open
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void moveCard(card.id, "archived")}
                  >
                    Archive
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

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
        <div
          className="backdrop-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="seal-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setShowSealModal(false);
          }}
        >
          <form onSubmit={sealRelease} className="modal-box">
            <div>
              <h2 id="seal-title">
                Seal {release.title} <span className="mono tabular">v{release.version}</span>
              </h2>
              <p className="muted">
                This seals <strong>{validatedCount}</strong> validated feature{validatedCount === 1 ? "" : "s"} into a
                signed <span className="mono">axiomspec/0.3</span> snapshot, archives the release, and opens a clean next
                release sheet.
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
                <span className="hint">Must be newer than {release.version}.</span>
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
                placeholder="Summarize what this release delivers."
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
                {busy ? "Sealing..." : "Seal and start next release"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
