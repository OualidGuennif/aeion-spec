// Spec: knowledge/components/spec-studio.md
"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  ALL_PROVIDER_IDS,
  GOLDFISH_PERSONAS,
  PROVIDER_CATALOG,
  type AgentRoleId,
  type LlmProviderId,
  type ModelMixerConfig,
  type VaultKeySummary,
  type VaultSecretPurpose,
} from "@aeion-spec/shared";
import { createApiClient, unwrap } from "../lib/api.ts";

interface VaultMixerPanelProps {
  csrfToken: string;
  /** Guest keys stay sealed in memory and vanish when the session ends. */
  memoryOnly: boolean;
  projectId: string | null;
  vaultKeys: VaultKeySummary[];
  mixer: ModelMixerConfig | null;
  onKeysChanged: (keys: VaultKeySummary[]) => void;
  onMixerSaved: (mixer: ModelMixerConfig) => void;
}

interface DraftRow {
  provider: LlmProviderId;
  modelId: string;
}

const CORE_ROLES: Array<{ id: AgentRoleId; label: string; note: string }> = [
  { id: "elephant", label: "Elephant", note: "Leads the interview and reads the quarantined source" },
  { id: "drafter", label: "Drafter", note: "Writes the feature spec and its AxiomSpec obligations" },
  { id: "reviewer", label: "Reviewer", note: "Independent gatekeeper from another vendor family" },
];

const GOLDFISH_ROLES: Array<{ id: AgentRoleId; label: string; note: string }> = GOLDFISH_PERSONAS.map((g) => ({
  id: g.roleId,
  label: `Goldfish · ${g.label}`,
  note: g.lens,
}));

const ALL_ROLES = [...CORE_ROLES, ...GOLDFISH_ROLES];

function providerLabel(id: LlmProviderId | "github"): string {
  return id === "github" ? "GitHub" : PROVIDER_CATALOG[id].label;
}

function goldfishModelFor(provider: LlmProviderId): string {
  const models = PROVIDER_CATALOG[provider].curatedModels;
  return (models.find((m) => m.recommendedFor.includes("goldfish")) ?? models[0])?.id ?? "";
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function presetsForProvider(
  provider: LlmProviderId,
  enabledOpenCodeModels?: readonly string[],
) {
  const base = PROVIDER_CATALOG[provider].curatedModels;
  if (provider !== "opencode-go" || !enabledOpenCodeModels || enabledOpenCodeModels.length === 0) {
    return base;
  }
  const allowed = new Set(enabledOpenCodeModels);
  const filtered = base.filter((m) => allowed.has(m.id));
  const extra = enabledOpenCodeModels
    .filter((id) => !base.some((m) => m.id === id))
    .map((id) => ({
      id,
      label: `${id} (OpenCode Go)`,
      api: "openai-completions" as const,
      contextWindow: 128_000,
      recommendedFor: ["goldfish"] as const,
    }));
  const combined = [...filtered, ...extra];
  return combined.length > 0 ? combined : base;
}

function MixerRow({
  role,
  row,
  heldProviders,
  enabledOpenCodeModels,
  onUpdate,
}: {
  role: { id: AgentRoleId; label: string; note: string };
  row: DraftRow | undefined;
  heldProviders: Set<string>;
  enabledOpenCodeModels?: readonly string[];
  onUpdate: (role: AgentRoleId, patch: Partial<DraftRow>) => void;
}) {
  if (!row) {
    return (
      <li className="mixer-row">
        <div className="mixer-role">
          <strong>{role.label}</strong>
          <span className="muted">Not assigned yet</span>
        </div>
      </li>
    );
  }
  const presets = presetsForProvider(row.provider, enabledOpenCodeModels);
  const isPreset = presets.some((m) => m.id === row.modelId);
  return (
    <li className="mixer-row">
      <div className="mixer-role">
        <strong>{role.label}</strong>
        <span className="muted">{role.note}</span>
      </div>
      <div className="mixer-controls">
        <select
          aria-label={`${role.label} provider`}
          className="select"
          value={row.provider}
          onChange={(e) => onUpdate(role.id, { provider: e.target.value as LlmProviderId })}
        >
          {ALL_PROVIDER_IDS.map((pid) => (
            <option key={pid} value={pid}>
              {PROVIDER_CATALOG[pid].label}
            </option>
          ))}
        </select>
        <select
          aria-label={`${role.label} model`}
          className="select"
          value={isPreset ? row.modelId : "__custom__"}
          onChange={(e) => {
            if (e.target.value !== "__custom__") onUpdate(role.id, { modelId: e.target.value });
          }}
        >
          {presets.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value="__custom__">Custom model ID</option>
        </select>
        {!isPreset && (
          <input
            aria-label={`${role.label} custom model ID`}
            className="input mono"
            value={row.modelId}
            onChange={(e) => onUpdate(role.id, { modelId: e.target.value })}
          />
        )}
        {!heldProviders.has(row.provider) && <span className="badge badge-warn">No key stored</span>}
      </div>
    </li>
  );
}

export function VaultMixerPanel({
  csrfToken,
  memoryOnly,
  projectId,
  vaultKeys,
  mixer,
  onKeysChanged,
  onMixerSaved,
}: VaultMixerPanelProps) {
  const [purpose, setPurpose] = useState<VaultSecretPurpose>("llm_provider");
  const [provider, setProvider] = useState<LlmProviderId | "github">("openai");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultErr, setVaultErr] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const [rows, setRows] = useState<Record<string, DraftRow>>({});
  const [mixerBusy, setMixerBusy] = useState(false);
  const [mixerMsg, setMixerMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const heldProviders = new Set(vaultKeys.filter((k) => k.purpose === "llm_provider").map((k) => k.provider));

  // Seed draft rows from the server's resolved per-role assignments.
  useEffect(() => {
    const initial: Record<string, DraftRow> = {};
    for (const role of ALL_ROLES) {
      const resolved = mixer?.effectiveAssignments?.[role.id] ?? mixer?.assignments[role.id];
      if (resolved) initial[role.id] = { provider: resolved.provider, modelId: resolved.modelId };
    }
    setRows(initial);
  }, [mixer]);

  const handlePurposeChange = (next: VaultSecretPurpose) => {
    setPurpose(next);
    if (next === "github_readonly") setProvider("github");
    else if (provider === "github") setProvider("openai");
  };

  const refreshKeys = async () => {
    const updated = await unwrap(createApiClient(csrfToken).api.vault.keys.get());
    onKeysChanged(updated.keys);
  };

  const storeKey = async (e: FormEvent) => {
    e.preventDefault();
    setVaultErr(null);
    setVaultBusy(true);
    try {
      await unwrap(
        createApiClient(csrfToken).api.vault.keys.post({
          purpose,
          provider,
          label: label.trim() || (provider === "github" ? "GitHub read-only token" : `${providerLabel(provider)} key`),
          secret,
        }),
      );
      setSecret("");
      setLabel("");
      await refreshKeys();
    } catch (err) {
      setVaultErr(errorText(err, "The key could not be stored."));
    } finally {
      setVaultBusy(false);
    }
  };

  const removeKey = async (keyId: string) => {
    setVaultErr(null);
    setVaultBusy(true);
    try {
      await unwrap(createApiClient(csrfToken).api.vault.keys({ keyId }).delete());
      setConfirmRevoke(null);
      await refreshKeys();
    } catch (err) {
      setVaultErr(errorText(err, "The key could not be revoked."));
    } finally {
      setVaultBusy(false);
    }
  };

  const updateRow = (role: AgentRoleId, patch: Partial<DraftRow>) => {
    setRows((prev) => {
      const current = prev[role] ?? { provider: "openai" as LlmProviderId, modelId: "" };
      const merged = { ...current, ...patch };
      // Pick the provider's first curated model immediately so switching providers never leaves an empty model ID.
      if (patch.provider && !patch.modelId) {
        merged.modelId = presetsForProvider(patch.provider, mixer?.enabledOpenCodeModels)[0]?.id ?? merged.modelId;
      }
      return { ...prev, [role]: merged };
    });
  };

  const applyAllGoldfish = (prov: LlmProviderId) => {
    const modelId = goldfishModelFor(prov);
    setRows((prev) => {
      const next = { ...prev };
      for (const p of GOLDFISH_PERSONAS) next[p.roleId] = { provider: prov, modelId };
      return next;
    });
  };

  const saveMixer = async () => {
    if (!projectId) return;
    setMixerBusy(true);
    setMixerMsg(null);
    try {
      const saved = await unwrap(createApiClient(csrfToken).api.projects({ projectId }).mixer.put({ assignments: rows }));
      onMixerSaved(saved);
      setMixerMsg({ ok: true, text: "Saved. The next agent run uses this mix." });
    } catch (err) {
      setMixerMsg({ ok: false, text: errorText(err, "The mix could not be saved.") });
    } finally {
      setMixerBusy(false);
    }
  };

  const goldfishShortcuts = ALL_PROVIDER_IDS.filter((pid) => heldProviders.has(pid));

  return (
    <div className="stack">
      <div className="page-header">
        <h1>Keys and models</h1>
        <p className="muted">
          Keys are encrypted with AES-256-GCM and stay inside your vault. The relay attaches them per request, so
          agents never see raw secrets.
        </p>
      </div>

      <section className="panel stack" aria-labelledby="vault-title">
        <div className="panel-header">
          <div>
            <h2 id="vault-title">Key vault</h2>
            <p className="muted">Only a masked hint and a fingerprint are shown after storage.</p>
          </div>
          {memoryOnly ? (
            <span className="badge badge-warn">Sealed in memory, erased at session end</span>
          ) : (
            <span className="badge badge-emerald">Sealed at rest</span>
          )}
        </div>

        <form onSubmit={storeKey} className="vault-form">
          <div className="field">
            <label htmlFor="vk-purpose">Purpose</label>
            <select
              id="vk-purpose"
              className="select"
              value={purpose}
              onChange={(e) => handlePurposeChange(e.target.value as VaultSecretPurpose)}
            >
              <option value="llm_provider">Model provider key</option>
              <option value="github_readonly">GitHub read-only token</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="vk-provider">Provider</label>
            {purpose === "github_readonly" ? (
              <input id="vk-provider" className="input" disabled value="GitHub (read-only)" />
            ) : (
              <select
                id="vk-provider"
                className="select"
                value={provider}
                onChange={(e) => setProvider(e.target.value as LlmProviderId)}
              >
                {ALL_PROVIDER_IDS.map((pid) => (
                  <option key={pid} value={pid}>
                    {PROVIDER_CATALOG[pid].label}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="field">
            <label htmlFor="vk-label">Label</label>
            <input
              id="vk-label"
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Work account"
            />
          </div>

          <div className="field">
            <label htmlFor="vk-secret">Secret</label>
            <input
              id="vk-secret"
              className="input mono"
              type="password"
              autoComplete="off"
              required
              minLength={6}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={provider === "github" ? "github_pat_..." : PROVIDER_CATALOG[provider].keyHint}
            />
          </div>

          <button type="submit" className="btn btn-primary vault-submit" disabled={vaultBusy}>
            {vaultBusy ? "Sealing..." : "Seal and store"}
          </button>
        </form>
        {vaultErr && (
          <div className="error-banner" role="alert">
            {vaultErr}
          </div>
        )}

        {vaultKeys.length === 0 ? (
          <div className="empty-state">
            <p>No keys stored yet. Add one model provider key to run live agents.</p>
          </div>
        ) : (
          <ul className="key-list">
            {vaultKeys.map((k) => (
              <li key={k.id} className="key-row">
                <span className="key-avatar" aria-hidden="true">
                  {providerLabel(k.provider).slice(0, 1)}
                </span>
                <div className="key-main">
                  <strong>{k.label}</strong>
                  <span className="muted">
                    {providerLabel(k.provider)} · {k.purpose === "github_readonly" ? "GitHub read-only" : "Model provider"}
                  </span>
                </div>
                <span className="mono key-hint">{k.maskedHint}</span>
                <span className="mono tabular key-fp" title="HMAC fingerprint">
                  {k.keyFingerprint}
                </span>
                {confirmRevoke === k.id ? (
                  <span className="row-gap">
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={vaultBusy}
                      onClick={() => void removeKey(k.id)}
                    >
                      Revoke now
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmRevoke(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-sm" onClick={() => setConfirmRevoke(k.id)}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {projectId ? (
        <section className="panel stack" aria-labelledby="mixer-title">
          <div className="panel-header">
            <div>
              <h2 id="mixer-title">Model mixer</h2>
              <p className="muted">Choose which provider and model each agent role uses for this project.</p>
            </div>
            {mixer && (
              <span className={`badge ${mixer.crossFamilyEnforced ? "badge-emerald" : "badge-warn"}`}>
                {mixer.crossFamilyEnforced ? "Reviewer is cross-family" : "Reviewer shares the drafter's family"}
              </span>
            )}
          </div>

          {mixer?.warnings.map((w) => (
            <div key={w} className="notice notice-warn">
              {w}
            </div>
          ))}

          <div className="stack-tight">
            <h3>Core pipeline (3 roles)</h3>
            <ul className="mixer-list">
              {CORE_ROLES.map((role) => (
                <MixerRow
                  key={role.id}
                  role={role}
                  row={rows[role.id]}
                  heldProviders={heldProviders}
                  enabledOpenCodeModels={mixer?.enabledOpenCodeModels}
                  onUpdate={updateRow}
                />
              ))}
            </ul>
          </div>

          {goldfishShortcuts.length > 0 && (
            <div className="choice-row" aria-label="Goldfish shortcuts">
              <span className="muted">Set all 8 Goldfish reviewers to:</span>
              {goldfishShortcuts.map((pid) => (
                <button key={pid} type="button" className="choice" onClick={() => applyAllGoldfish(pid)}>
                  {PROVIDER_CATALOG[pid].label}
                </button>
              ))}
            </div>
          )}

          <details className="subtle-disclosure">
            <summary>
              <span>Goldfish swarm ({GOLDFISH_ROLES.length} personas)</span>
              <span className="hint">Expand to tune individual reviewers</span>
            </summary>
            <ul className="mixer-list">
              {GOLDFISH_ROLES.map((role) => (
                <MixerRow
                  key={role.id}
                  role={role}
                  row={rows[role.id]}
                  heldProviders={heldProviders}
                  enabledOpenCodeModels={mixer?.enabledOpenCodeModels}
                  onUpdate={updateRow}
                />
              ))}
            </ul>
          </details>

          <div className="row-gap">
            <button type="button" className="btn btn-primary" disabled={mixerBusy} onClick={() => void saveMixer()}>
              {mixerBusy ? "Saving..." : "Save mix"}
            </button>
            {mixerMsg && (
              <span className={`badge ${mixerMsg.ok ? "badge-emerald" : "badge-danger"}`} role="status">
                {mixerMsg.text}
              </span>
            )}
          </div>
        </section>
      ) : (
        <div className="empty-state">
          <p>Create or select a project to assign models to its agent roles.</p>
        </div>
      )}
    </div>
  );
}
