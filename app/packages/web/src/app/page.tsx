// Spec: knowledge/components/spec-studio.md
"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ModelMixerConfig,
  ProjectRecord,
  ReleaseRecord,
  SessionUser,
  TableauCard,
  VaultKeySummary,
} from "@aeion-spec/shared";
import { AuthGate } from "../components/AuthGate.tsx";
import { CardStudioDrawer } from "../components/CardStudioDrawer.tsx";
import { CreateProjectModal } from "../components/CreateProjectModal.tsx";
import { ReleaseBoard } from "../components/ReleaseBoard.tsx";
import { ReleasesArchive } from "../components/ReleasesArchive.tsx";
import { ThemeSwitch } from "../components/ThemeSwitch.tsx";
import { VaultMixerPanel } from "../components/VaultMixerPanel.tsx";
import { createApiClient, unwrap } from "../lib/api.ts";

type AppTab = "tableau" | "vault" | "releases";

const TABS: Array<{ id: AppTab; label: string }> = [
  { id: "tableau", label: "Board" },
  { id: "vault", label: "Keys & models" },
  { id: "releases", label: "Releases" },
];

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function Brand() {
  return (
    <span className="brand-mark">
      <span className="brand-dot" aria-hidden="true" />
      <span>Æion Spec</span>
    </span>
  );
}

export default function HomePage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [builderTokenPlain, setBuilderTokenPlain] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [activeTab, setActiveTab] = useState<AppTab>("tableau");
  const [appError, setAppError] = useState<string | null>(null);

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [vaultKeys, setVaultKeys] = useState<VaultKeySummary[]>([]);

  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [activeRelease, setActiveRelease] = useState<ReleaseRecord | null>(null);
  const [cards, setCards] = useState<TableauCard[]>([]);
  const [archivedCards, setArchivedCards] = useState<TableauCard[]>([]);
  const [releases, setReleases] = useState<ReleaseRecord[]>([]);
  const [mixer, setMixer] = useState<ModelMixerConfig | null>(null);

  const [selectedCard, setSelectedCard] = useState<TableauCard | null>(null);
  const [showCreateProject, setShowCreateProject] = useState(false);

  const clearWorkspace = useCallback(() => {
    setActiveProject(null);
    setActiveRelease(null);
    setCards([]);
    setArchivedCards([]);
    setReleases([]);
    setMixer(null);
    setSelectedCard(null);
  }, []);

  const loadTableau = useCallback(async (projectId: string, csrf: string) => {
    const data = await unwrap(createApiClient(csrf).api.projects({ projectId }).tableau.get());
    setActiveProject(data.project);
    setActiveRelease(data.release);
    setCards(data.cards);
    setArchivedCards(data.archivedCards);
    setReleases(data.releases);
    setMixer(data.mixer);
    setSelectedCard((prev) => (prev ? (data.cards.find((c) => c.id === prev.id) ?? null) : null));
  }, []);

  // The workspace loads before the user is set, so a failed load leaves the sign-in screen with its error.
  const bootstrapSession = useCallback(
    async (sessionUser: SessionUser, plainBuilderToken?: string) => {
      const client = createApiClient(sessionUser.csrfToken);
      const [projRes, keysRes] = await Promise.all([
        unwrap(client.api.projects.get()),
        unwrap(client.api.vault.keys.get()),
      ]);
      const firstId = projRes.projects[0]?.id ?? null;
      if (firstId) await loadTableau(firstId, sessionUser.csrfToken);
      else clearWorkspace();
      setProjects(projRes.projects);
      setVaultKeys(keysRes.keys);
      setSelectedProjectId(firstId);
      setBuilderTokenPlain(plainBuilderToken ?? null);
      setUser(sessionUser);
    },
    [loadTableau, clearWorkspace],
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/session", { credentials: "include" });
        if (res.ok && mounted) {
          const data = (await res.json()) as { user: SessionUser };
          await bootstrapSession(data.user);
        }
      } catch (err) {
        if (mounted) setAppError(errorText(err, "The saved session could not be restored."));
      } finally {
        if (mounted) setBooting(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [bootstrapSession]);

  const refresh = useCallback(async () => {
    if (!user || !activeProject) return;
    try {
      await loadTableau(activeProject.id, user.csrfToken);
    } catch (err) {
      setAppError(errorText(err, "The board could not be refreshed."));
    }
  }, [user, activeProject, loadTableau]);

  const selectProject = async (projectId: string) => {
    if (!user || !projectId) return;
    setSelectedProjectId(projectId);
    setSelectedCard(null);
    try {
      await loadTableau(projectId, user.csrfToken);
    } catch (err) {
      setAppError(errorText(err, "The project could not be opened."));
    }
  };

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      setUser(null);
      setBuilderTokenPlain(null);
      setProjects([]);
      setSelectedProjectId(null);
      setVaultKeys([]);
      setActiveTab("tableau");
      clearWorkspace();
    }
  };

  if (booting) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <div className="topbar-inner">
            <Brand />
          </div>
        </header>
        <main className="main-content">
          <div className="boot-state" role="status">
            <span className="spinner" aria-hidden="true" />
            Opening your workspace…
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className={`topbar-inner ${user ? "has-user" : ""}`}>
          <Brand />

          {user && (
            <nav className="segmented nav-tabs" aria-label="Workspace sections">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-current={activeTab === t.id ? "page" : undefined}
                  className={`segment ${activeTab === t.id ? "active" : ""}`}
                  onClick={() => setActiveTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          )}

          <div className="topbar-right">
            {user && (
              <>
                {projects.length > 0 && (
                  <select
                    aria-label="Active project"
                    className="nav-select"
                    value={selectedProjectId ?? ""}
                    onChange={(e) => void selectProject(e.target.value)}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · v{p.activeReleaseVersion}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  aria-label="New project"
                  className="btn btn-primary btn-sm topbar-new"
                  onClick={() => setShowCreateProject(true)}
                >
                  New<span className="label-extra"> project</span>
                </button>
                <span
                  className={`user-chip ${user.mode === "invite" ? "is-guest" : ""}`}
                  title={user.mode === "invite" ? "Guest session: memory only" : (user.email ?? undefined)}
                >
                  {user.mode === "invite" ? "Guest" : user.displayName || user.email}
                </span>
                <button type="button" className="btn btn-ghost btn-sm topbar-exit" onClick={() => void logout()}>
                  {user.mode === "invite" ? "End and erase" : "Sign out"}
                </button>
              </>
            )}
            <ThemeSwitch />
          </div>
        </div>
      </header>

      {user?.mode === "invite" && (
        <div className="guest-ribbon" role="note">
          Guest session: projects, keys and interviews live in memory only and are erased when you end it.
        </div>
      )}

      <main className="main-content">
        {appError && (
          <div className="error-banner" role="alert">
            <span>{appError}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAppError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {!user ? (
          <AuthGate onAuthenticated={bootstrapSession} />
        ) : (
          <>
            {activeTab === "tableau" &&
              (activeProject && activeRelease ? (
                <ReleaseBoard
                  key={activeProject.id}
                  csrfToken={user.csrfToken}
                  project={activeProject}
                  release={activeRelease}
                  cards={cards}
                  archivedCards={archivedCards}
                  onRefresh={refresh}
                  onSelectCard={setSelectedCard}
                />
              ) : (
                <section className="welcome">
                  <span className="eyebrow">
                    {user.mode === "invite" || !user.displayName ? "Welcome" : `Welcome, ${user.displayName}`}
                  </span>
                  <h1>Start your first spec</h1>
                  <p className="lead">
                    Begin from a blank page, a GitHub repository or an archive of your code. The source stays
                    read-only in a quarantined sandbox.
                  </p>
                  <div className="row-gap">
                    <button type="button" className="btn btn-primary" onClick={() => setShowCreateProject(true)}>
                      Create a project
                    </button>
                    <button type="button" className="btn" onClick={() => setActiveTab("vault")}>
                      Add model keys first
                    </button>
                  </div>
                </section>
              ))}

            {activeTab === "vault" && (
              <VaultMixerPanel
                csrfToken={user.csrfToken}
                memoryOnly={user.mode === "invite"}
                projectId={selectedProjectId}
                vaultKeys={vaultKeys}
                mixer={mixer}
                onKeysChanged={setVaultKeys}
                onMixerSaved={setMixer}
              />
            )}

            {activeTab === "releases" &&
              (activeProject ? (
                <ReleasesArchive
                  key={activeProject.id}
                  csrfToken={user.csrfToken}
                  project={activeProject}
                  releases={releases}
                  builderTokenPreview={user.builderTokenPreview}
                  builderTokenPlain={builderTokenPlain}
                  onBuilderTokenRotated={(plain, preview) => {
                    setBuilderTokenPlain(plain);
                    setUser((prev) => (prev ? { ...prev, builderTokenPreview: preview } : prev));
                  }}
                />
              ) : (
                <div className="empty-state">
                  <p>Create or select a project to see its releases, its Builder API access and its source.</p>
                </div>
              ))}
          </>
        )}
      </main>

      {showCreateProject && user && (
        <CreateProjectModal
          csrfToken={user.csrfToken}
          vaultKeys={vaultKeys}
          onClose={() => setShowCreateProject(false)}
          onCreated={async (created) => {
            setShowCreateProject(false);
            try {
              const client = createApiClient(user.csrfToken);
              const [list, keys] = await Promise.all([
                unwrap(client.api.projects.get()),
                unwrap(client.api.vault.keys.get()),
              ]);
              setProjects(list.projects);
              setVaultKeys(keys.keys);
            } catch (err) {
              setAppError(errorText(err, "The project list could not be refreshed."));
            }
            await selectProject(created.id);
            setActiveTab("tableau");
          }}
        />
      )}

      {selectedCard && activeProject && user && (
        <CardStudioDrawer
          key={selectedCard.id}
          csrfToken={user.csrfToken}
          projectId={activeProject.id}
          card={selectedCard}
          onClose={() => setSelectedCard(null)}
          onCardUpdated={(updated) => {
            setSelectedCard(updated);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
