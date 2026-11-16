// Spec: knowledge/components/spec-studio.md
"use client";

import { useEffect, useState } from "react";
import type { ProjectRecord, ReleaseCompareReport, ReleaseRecord, TableauCard } from "@aeion-spec/shared";
import { createApiClient, unwrap } from "../lib/api.ts";

interface ReleasesArchiveProps {
  csrfToken: string;
  project: ProjectRecord;
  releases: ReleaseRecord[];
  builderTokenPreview: string | null;
  builderTokenPlain: string | null;
  onBuilderTokenRotated: (plain: string, preview: string) => void;
}

const FILE_LIST_LIMIT = 80;

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1600);
  };
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()} aria-label={label}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}

export function ReleasesArchive({
  csrfToken,
  project,
  releases,
  builderTokenPreview,
  builderTokenPlain,
  onBuilderTokenRotated,
}: ReleasesArchiveProps) {
  const [selectedRelease, setSelectedRelease] = useState<ReleaseRecord | null>(null);
  const [snapshotCards, setSnapshotCards] = useState<TableauCard[]>([]);
  const [compareFrom, setCompareFrom] = useState("");
  const [compareTo, setCompareTo] = useState("");
  const [diffReport, setDiffReport] = useState<ReleaseCompareReport | null>(null);
  const [sandboxFiles, setSandboxFiles] = useState<string[] | null>(null);
  const [fileSlice, setFileSlice] = useState<{ path: string; content: string; totalLines: number } | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The browser origin is the address the owner can actually reach; the API sits behind it.
  const [origin, setOrigin] = useState("http://127.0.0.1:4170");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const client = createApiClient(csrfToken);
  const sealedReleases = releases.filter((r) => r.status === "sealed");
  const specUrl = `${origin}/api/v1/builder/projects/${project.slug}/spec`;
  const curl = `curl -sS -H "Authorization: Bearer ${builderTokenPlain || "<BUILDER_TOKEN>"}" \\\n  "${specUrl}"`;

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const inspectRelease = (releaseId: string) =>
    run(async () => {
      const res = await unwrap(client.api.projects({ projectId: project.id }).releases({ releaseId }).get());
      setSelectedRelease(res.release);
      setSnapshotCards(res.cardsSnapshot);
    }, "The release could not be loaded.");

  const comparePair = () =>
    run(async () => {
      const res = await unwrap(
        client.api
          .projects({ projectId: project.id })
          .releases({ releaseId: compareFrom })
          .compare({ otherId: compareTo })
          .get(),
      );
      setDiffReport(res);
    }, "The comparison failed.");

  const rotateToken = () =>
    run(async () => {
      const res = await unwrap(client.api.auth["builder-token"].rotate.post());
      onBuilderTokenRotated(res.tokenPlain, res.preview);
      setConfirmRotate(false);
    }, "The builder token could not be rotated.");

  const loadSandboxFiles = () =>
    run(async () => {
      const res = await unwrap(client.api.projects({ projectId: project.id }).source.files.get());
      setSandboxFiles(res.files);
    }, "The quarantined files could not be listed.");

  const openSandboxSlice = (path: string) =>
    run(async () => {
      const res = await unwrap(client.api.projects({ projectId: project.id }).source.file.get({ query: { path } }));
      setFileSlice(res);
    }, "The file could not be opened.");

  return (
    <div className="stack">
      <div className="page-header">
        <span className="eyebrow">{project.name}</span>
        <h1>Releases and sources</h1>
        <p className="muted">Sealed specs, their differences, the Builder API, and the quarantined source.</p>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <section className="panel stack" aria-labelledby="history-title">
        <div className="panel-header">
          <div>
            <h2 id="history-title">Release history</h2>
            <p className="muted">Each sealed release keeps its AxiomSpec snapshot and Observability bundle.</p>
          </div>
          <span className="count-pill tabular">{sealedReleases.length} sealed</span>
        </div>

        <ul className="release-list">
          {releases.map((r) => (
            <li key={r.id} className={`release-row ${selectedRelease?.id === r.id ? "is-selected" : ""}`}>
              <span className="chip chip-version mono tabular">v{r.version}</span>
              <div className="release-row-main">
                <strong>{r.title}</strong>
                <span className="muted tabular">
                  {r.status === "sealed"
                    ? `${r.bumpKind ?? "unknown"} bump · risk ${r.riskScore ?? "unknown"} · ${r.validatedCount} features`
                    : "In progress"}
                </span>
              </div>
              <span className={`badge ${r.status === "sealed" ? "badge-emerald" : "badge-info"}`}>
                {r.status === "sealed" ? "Sealed" : "Active"}
              </span>
              <span className="mono release-digest" title={r.sealedDigest ?? undefined}>
                {r.sealedDigest ? `${r.sealedDigest.slice(0, 12)}…` : "no digest"}
              </span>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void inspectRelease(r.id)}>
                View
              </button>
            </li>
          ))}
        </ul>

        {selectedRelease && (
          <div className="panel-inset stack">
            <div className="panel-header">
              <h3>
                v{selectedRelease.version} · {selectedRelease.title}
              </h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedRelease(null)}>
                Close
              </button>
            </div>
            {selectedRelease.notes && <p>{selectedRelease.notes}</p>}
            {snapshotCards.length > 0 ? (
              <div className="card-flags">
                {snapshotCards.map((c) => (
                  <span key={c.id} className="chip">
                    <span className="mono">{c.featureCode}</span> {c.title}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">No features were captured in this release.</p>
            )}
            {selectedRelease.observabilityManifestJson && (
              <pre className="code-block">{JSON.stringify(selectedRelease.observabilityManifestJson, null, 2)}</pre>
            )}
          </div>
        )}

        {sealedReleases.length >= 2 && (
          <div className="panel-inset stack">
            <h3>Compare two sealed releases</h3>
            <div className="row-gap">
              <select
                aria-label="Baseline release"
                className="select"
                value={compareFrom}
                onChange={(e) => setCompareFrom(e.target.value)}
              >
                <option value="">From…</option>
                {sealedReleases.map((r) => (
                  <option key={r.id} value={r.id}>
                    v{r.version} · {r.title}
                  </option>
                ))}
              </select>
              <select
                aria-label="Candidate release"
                className="select"
                value={compareTo}
                onChange={(e) => setCompareTo(e.target.value)}
              >
                <option value="">To…</option>
                {sealedReleases.map((r) => (
                  <option key={r.id} value={r.id}>
                    v{r.version} · {r.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || !compareFrom || !compareTo || compareFrom === compareTo}
                onClick={() => void comparePair()}
              >
                Compare
              </button>
            </div>
            {diffReport && (
              <div className="diff-summary">
                <div className="stat">
                  <span className="stat-value">{diffReport.recommendedBump}</span>
                  <span className="stat-label">recommended bump</span>
                </div>
                <div className="stat">
                  <span className="stat-value tabular">{diffReport.riskScore}</span>
                  <span className="stat-label">risk score</span>
                </div>
                <div className="stat">
                  <span className="stat-value tabular">+{diffReport.addedNodes.length}</span>
                  <span className="stat-label">added</span>
                </div>
                <div className="stat">
                  <span className="stat-value tabular">−{diffReport.removedNodes.length}</span>
                  <span className="stat-label">removed</span>
                </div>
                <div className="stat">
                  <span className="stat-value tabular">{diffReport.changedNodes.length}</span>
                  <span className="stat-label">changed</span>
                </div>
                {diffReport.breakingChanges.length > 0 && (
                  <ul className="error-list">
                    {diffReport.breakingChanges.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="panel stack" aria-labelledby="builder-title">
        <div className="panel-header">
          <div>
            <h2 id="builder-title">Builder API</h2>
            <p className="muted">Builder agents read validated specs with a read-only bearer token.</p>
          </div>
          {confirmRotate ? (
            <span className="row-gap">
              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void rotateToken()}>
                Rotate now
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmRotate(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => setConfirmRotate(true)}>
              Rotate token
            </button>
          )}
        </div>
        {confirmRotate && (
          <div className="notice notice-warn">Rotating stops the current token at once for every builder using it.</div>
        )}
        <div className="token-row">
          <span className="mono token-value">
            {builderTokenPlain || builderTokenPreview || "No token yet: rotate to create one"}
          </span>
          {builderTokenPlain && <CopyButton text={builderTokenPlain} label="Copy builder token" />}
        </div>
        {builderTokenPlain && (
          <p className="hint">This is the only time the full token is shown. Store it before leaving the page.</p>
        )}
        <div className="code-wrap">
          <pre className="code-block">{curl}</pre>
          <CopyButton text={curl.replace("\\\n  ", "")} label="Copy curl command" />
        </div>
      </section>

      <section className="panel stack" aria-labelledby="source-title">
        <div className="panel-header">
          <div>
            <h2 id="source-title">Quarantined source</h2>
            <p className="muted">Read-only, network-isolated snapshot with archive, symlink and secret checks.</p>
          </div>
          {project.sourceKind !== "empty" && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void loadSandboxFiles()}>
              Browse files
            </button>
          )}
        </div>

        {project.openshellSummary ? (
          <pre className="code-block">{JSON.stringify(project.openshellSummary, null, 2)}</pre>
        ) : (
          <p className="muted">This project started empty, so there is no source snapshot.</p>
        )}

        {sandboxFiles && (
          <div className="file-browser">
            <div className="file-list">
              <span className="muted tabular">
                {sandboxFiles.length > FILE_LIST_LIMIT
                  ? `Showing ${FILE_LIST_LIMIT} of ${sandboxFiles.length} files`
                  : `${sandboxFiles.length} files`}
              </span>
              {sandboxFiles.length === 0 && <p className="muted">No files are held for this project right now.</p>}
              {sandboxFiles.slice(0, FILE_LIST_LIMIT).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`file-item mono ${fileSlice?.path === f ? "active" : ""}`}
                  onClick={() => void openSandboxSlice(f)}
                >
                  {f}
                </button>
              ))}
            </div>
            {fileSlice && (
              <div className="stack">
                <span className="muted mono tabular">
                  {fileSlice.path} · first {Math.min(120, fileSlice.totalLines)} of {fileSlice.totalLines} lines
                </span>
                <pre className="code-block">{fileSlice.content || "(empty file)"}</pre>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
