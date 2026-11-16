// Spec: knowledge/components/spec-studio.md
"use client";

import { useEffect, useState, type FormEvent } from "react";
import { MAX_UPLOAD_BYTES, type ProjectRecord, type SourceKind, type VaultKeySummary } from "@aeion-spec/shared";
import { createApiClient, unwrap } from "../lib/api.ts";

interface CreateProjectModalProps {
  csrfToken: string;
  vaultKeys: VaultKeySummary[];
  onClose: () => void;
  onCreated: (project: ProjectRecord) => void;
}

const SOURCES: Array<{ id: SourceKind; title: string; note: string }> = [
  { id: "empty", title: "Start empty", note: "Spec only, no codebase" },
  { id: "github_public", title: "Public GitHub", note: "Read-only clone into OpenShell" },
  { id: "github_private", title: "Private GitHub", note: "Read-only token from the vault" },
  { id: "upload", title: "Upload archive", note: ".zip or .tar.gz up to 100 MiB" },
];

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function uploadArchive(projectId: string, file: File, csrfToken: string) {
  const form = new FormData();
  form.append("archive", file);
  const res = await fetch(`/api/projects/${projectId}/source/upload`, {
    method: "POST",
    credentials: "include",
    headers: { "X-Aeion": "1", "X-CSRF-Token": csrfToken },
    body: form,
  });
  let body: { summary?: ProjectRecord["openshellSummary"]; error?: string } = {};
  try {
    body = await res.json();
  } catch {
    // A proxy may answer with HTML; the status still tells what happened.
  }
  if (!res.ok) throw new Error(body.error || `The archive upload failed (${res.status}).`);
  return body.summary ?? null;
}

export function CreateProjectModal({ csrfToken, vaultKeys, onClose, onCreated }: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [releaseTitle, setReleaseTitle] = useState("First release");
  const [releaseVersion, setReleaseVersion] = useState("0.1.0");
  const [sourceKind, setSourceKind] = useState<SourceKind>("empty");
  const [repoUrl, setRepoUrl] = useState("");
  const ghKeys = vaultKeys.filter((k) => k.purpose === "github_readonly");
  const [githubKeyId, setGithubKeyId] = useState<string>(ghKeys[0]?.id ?? "");
  const [inlineGhPat, setInlineGhPat] = useState("");
  // A token typed here is stored once; a retry reuses it instead of sealing a duplicate.
  const [storedPatKeyId, setStoredPatKeyId] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  // A project whose upload failed already exists; a retry only repeats the upload.
  const [pendingProject, setPendingProject] = useState<ProjectRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    if (pendingProject) onCreated(pendingProject);
    else onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    // Check everything local before the first request, so nothing half-created is left behind.
    if (sourceKind === "upload") {
      if (!uploadFile) return setError("Choose a .zip or .tar.gz archive.");
      if (uploadFile.size > MAX_UPLOAD_BYTES) {
        return setError(`The archive is ${mib(uploadFile.size)} MiB; the limit is ${mib(MAX_UPLOAD_BYTES)} MiB.`);
      }
    }
    if (sourceKind === "github_private" && !githubKeyId && !storedPatKeyId && !inlineGhPat.trim()) {
      return setError("Pick a stored read-only GitHub token or paste a new one.");
    }

    setBusy(true);
    try {
      const client = createApiClient(csrfToken);
      let project = pendingProject;

      if (!project) {
        let keyId = sourceKind === "github_private" ? githubKeyId || storedPatKeyId || undefined : undefined;
        if (sourceKind === "github_private" && !keyId) {
          const saved = await unwrap(
            client.api.vault.keys.post({
              purpose: "github_readonly",
              provider: "github",
              label: `GitHub read-only (${name || "project"})`,
              secret: inlineGhPat.trim(),
            }),
          );
          keyId = saved.key.id;
          setStoredPatKeyId(saved.key.id);
          setInlineGhPat("");
        }
        const created = await unwrap(
          client.api.projects.post({
            name,
            description,
            releaseTitle,
            releaseVersion,
            sourceKind,
            sourceRef: sourceKind === "github_public" || sourceKind === "github_private" ? repoUrl : undefined,
            githubVaultKeyId: keyId,
          }),
        );
        project = created.project;
      }

      if (sourceKind === "upload" && uploadFile) {
        try {
          project = { ...project, openshellSummary: await uploadArchive(project.id, uploadFile, csrfToken) };
        } catch (err) {
          setPendingProject(project);
          throw err;
        }
      }

      onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The project could not be created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="backdrop-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-box" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
        <div className="panel-header">
          <div>
            <span className="eyebrow">New project</span>
            <h2 id="new-project-title">What are you specifying?</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="stack">
          <fieldset className="source-picker" disabled={!!pendingProject}>
            <legend className="field-legend">Source</legend>
            {SOURCES.map((s) => (
              <label key={s.id} className={`source-option ${sourceKind === s.id ? "active" : ""}`}>
                <input
                  type="radio"
                  name="source"
                  value={s.id}
                  checked={sourceKind === s.id}
                  onChange={() => setSourceKind(s.id)}
                />
                <span className="source-title">{s.title}</span>
                <span className="source-note">{s.note}</span>
              </label>
            ))}
          </fieldset>

          <div className="grid-2">
            <div className="field">
              <label htmlFor="proj-name">Project name</label>
              <input
                id="proj-name"
                className="input"
                required
                minLength={2}
                disabled={!!pendingProject}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Payments settlement core"
              />
            </div>
            <div className="field">
              <label htmlFor="proj-ver">First version</label>
              <input
                id="proj-ver"
                className="input tabular mono"
                required
                disabled={!!pendingProject}
                pattern="^v?\d+\.\d+\.\d+$"
                value={releaseVersion}
                onChange={(e) => setReleaseVersion(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="proj-rel-title">First release title</label>
            <input
              id="proj-rel-title"
              className="input"
              required
              minLength={2}
              disabled={!!pendingProject}
              value={releaseTitle}
              onChange={(e) => setReleaseTitle(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="proj-desc">Description</label>
            <textarea
              id="proj-desc"
              className="textarea"
              disabled={!!pendingProject}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Goals and boundaries, in a few lines."
            />
          </div>

          {(sourceKind === "github_public" || sourceKind === "github_private") && (
            <div className="field">
              <label htmlFor="proj-repo-url">Repository URL</label>
              <input
                id="proj-repo-url"
                className="input mono"
                required
                type="url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
              />
            </div>
          )}

          {sourceKind === "github_private" && (
            <div className="panel-inset stack">
              {ghKeys.length > 0 && (
                <div className="field">
                  <label htmlFor="proj-gh-key">Stored GitHub token</label>
                  <select
                    id="proj-gh-key"
                    className="select"
                    value={githubKeyId}
                    onChange={(e) => setGithubKeyId(e.target.value)}
                  >
                    <option value="">Paste a new token instead</option>
                    {ghKeys.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.label} ({k.maskedHint})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {!githubKeyId && !storedPatKeyId && (
                <div className="field">
                  <label htmlFor="proj-gh-pat">New read-only token</label>
                  <input
                    id="proj-gh-pat"
                    className="input mono"
                    type="password"
                    autoComplete="off"
                    value={inlineGhPat}
                    onChange={(e) => setInlineGhPat(e.target.value)}
                    placeholder="github_pat_… with read-only Contents"
                  />
                  <span className="hint">It is sealed in your vault before the clone starts.</span>
                </div>
              )}
              {storedPatKeyId && !githubKeyId && <span className="badge badge-emerald">Token sealed in your vault</span>}
            </div>
          )}

          {sourceKind === "upload" && (
            <div className="panel-inset stack">
              <div className="field">
                <label htmlFor="proj-archive">Source archive</label>
                <input
                  id="proj-archive"
                  className="input"
                  type="file"
                  accept=".zip,.tar.gz,.tgz"
                  onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                />
                <span className="hint">Quarantined, checked for archive bombs and symlinks, secrets redacted.</span>
              </div>
              {uploadFile && (
                <span className={`badge tabular ${uploadFile.size > MAX_UPLOAD_BYTES ? "badge-danger" : "badge-neutral"}`}>
                  {mib(uploadFile.size)} / {mib(MAX_UPLOAD_BYTES)} MiB
                </span>
              )}
            </div>
          )}

          {pendingProject && (
            <div className="notice notice-warn">
              The project “{pendingProject.name}” exists, but its archive was not stored. Choose another archive and
              retry, or close to keep the project without source.
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn" disabled={busy} onClick={close}>
              {pendingProject ? "Close without source" : "Cancel"}
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Creating…" : pendingProject ? "Retry upload" : "Create project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
