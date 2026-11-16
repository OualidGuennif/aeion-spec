// Spec: knowledge/components/spec-studio.md
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

type AppTab = "tableau" | "releases" | "vault";

const TABS: Array<{ id: AppTab; label: string }> = [
  { id: "tableau", label: "Workspace" },
  { id: "releases", label: "Releases" },
  { id: "vault", label: "Keys" },
];

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function Brand() {
  return (
    <span className="brand-mark">
      <svg className="brand-glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect width="24" height="24" rx="6" fill="var(--btn-primary-bg)" />
        <rect x="5.5" y="6" width="7.5" height="12" rx="1.5" fill="var(--btn-primary-text)" />
        <rect x="15" y="6" width="3.5" height="5.5" rx="1.2" fill="var(--btn-primary-text)" fillOpacity="0.82" />
        <rect x="15" y="13" width="3.5" height="5" rx="1.2" fill="var(--btn-primary-text)" fillOpacity="0.52" />
      </svg>
      <span>Æion Spec</span>
    </span>
  );
}

function ProjectMenu({
  projects,
  selectedId,
  onSelect,
  onNewProject,
}: {
  projects: ProjectRecord[];
  selectedId: string | null;
  onSelect: (projectId: string) => void;
  onNewProject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = projects.find((p) => p.id === selectedId) ?? projects[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!current) {
    return (
      <button type="button" className="btn btn-sm" onClick={onNewProject}>
        + New project
      </button>
    );
  }

  return (
    <div ref={rootRef} className="project-menu">
      <button
        type="button"
        className="nav-select-btn"
        aria-label="Switch or create project"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="nav-select-label">
          {current.name} · v{current.activeReleaseVersion}
        </span>
        <svg className="nav-select-chevron" width="12" height="8" viewBox="0 0 12 8" fill="none" aria-hidden="true">
          <path d="M1 1.5l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="popover-menu" role="menu" aria-label="Projects">
          <ul className="project-menu-list">
            {projects.map((p) => {
              const active = p.id === current.id;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={`project-menu-item ${active ? "active" : ""}`}
                    onClick={() => {
                      setOpen(false);
                      onSelect(p.id);
                    }}
                  >
                    <span className="project-menu-name">{p.name}</span>
                    <span className="mono tabular project-menu-ver">v{p.activeReleaseVersion}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="project-menu-item is-action"
            onClick={() => {
              setOpen(false);
              onNewProject();
            }}
          >
            + New project
          </button>
        </div>
      )}
    </div>
  );
}

function SessionMenu({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const isGuest = user.mode === "invite";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="session-menu">
      <button
        type="button"
        className={`user-chip-btn ${isGuest ? "is-guest" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={isGuest ? "Guest session (memory only)" : (user.email ?? undefined)}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="user-chip-dot" aria-hidden="true" />
        <span>{isGuest ? "Guest" : user.displayName || user.email}</span>
        <svg className="nav-select-chevron" width="10" height="7" viewBox="0 0 12 8" fill="none" aria-hidden="true">
          <path d="M1 1.5l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="popover-menu popover-menu-right" role="menu" aria-label="Session">
          <p className="hint">
            {isGuest
              ? "Guest session: projects, keys, and interviews stay in memory and disappear when you leave or end this session."
              : user.email || user.displayName}
          </p>
          <button
            type="button"
            role="menuitem"
            className="btn btn-sm btn-block"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            {isGuest ? "End and erase session" : "Sign out"}
          </button>
        </div>
      )}
    </div>
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
  const [drawerInitialTab, setDrawerInitialTab] = useState<"interview" | "review" | "spec" | "axiom">("interview");
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

  // Load workspace data before setting user so startup errors remain visible on the sign-in screen.
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
        if (mounted) setAppError(errorText(err, "Your saved session could not be restored."));
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
      setAppError(errorText(err, "The workspace could not be refreshed."));
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

  const openCard = (card: TableauCard, tab: "interview" | "review" | "spec" | "axiom" = "interview") => {
    setDrawerInitialTab(tab);
    setSelectedCard(card);
  };

  const llmKeyCount = vaultKeys.filter((k) => k.purpose === "llm_provider").length;

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
            Opening your workspace...
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className={`topbar-inner ${user ? "has-user" : ""}`}>
          <div className="topbar-left">
            <Brand />
            {user && (
              <ProjectMenu
                projects={projects}
                selectedId={selectedProjectId}
                onSelect={(id) => void selectProject(id)}
                onNewProject={() => setShowCreateProject(true)}
              />
            )}
          </div>

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
            <ThemeSwitch />
            {user && <SessionMenu user={user} onLogout={() => void logout()} />}
          </div>
        </div>
      </header>

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
                  llmKeyCount={llmKeyCount}
                  onOpenKeys={() => setActiveTab("vault")}
                  onRefresh={refresh}
                  onSelectCard={openCard}
                />
              ) : (
                <section className="welcome">
                  <h1>
                    {user.mode === "invite" || !user.displayName
                      ? "Create your first project"
                      : `Welcome, ${user.displayName}`}
                  </h1>
                  <p className="lead">
                    Start from an empty board, a GitHub repository, or an uploaded archive. Your source stays read-only
                    inside an isolated sandbox.
                  </p>
                  {user.mode === "invite" && (
                    <p className="hint">
                      Guest session active: projects, keys, and interviews stay in memory only until you close or end
                      this session.
                    </p>
                  )}
                  <div className="row-gap">
                    <button type="button" className="btn btn-primary" onClick={() => setShowCreateProject(true)}>
                      Create a project
                    </button>
                    <button type="button" className="btn" onClick={() => setActiveTab("vault")}>
                      {llmKeyCount === 0 ? "Add API keys first" : `Keys (${llmKeyCount})`}
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
                  <p>Create or select a project to inspect its releases, Builder API token, and quarantined source.</p>
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
          key={`${selectedCard.id}-${drawerInitialTab}`}
          csrfToken={user.csrfToken}
          projectId={activeProject.id}
          card={selectedCard}
          initialTab={drawerInitialTab}
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
