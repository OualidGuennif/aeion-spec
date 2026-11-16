// Spec: knowledge/components/spec-studio.md
"use client";

import { useState, type FormEvent } from "react";
import type { SessionUser } from "@aeion-spec/shared";
import { createApiClient, unwrap } from "../lib/api.ts";

interface AuthGateProps {
  // Resolves once the workspace has loaded, so a failure is shown here rather than lost.
  onAuthenticated: (user: SessionUser, builderTokenPlain?: string) => Promise<void>;
}

const STEPS = [
  { title: "Describe a feature", body: "Drop an idea on the board, alone or with your codebase." },
  { title: "Face the Goldfish", body: "Eight fresh-context reviewers question it until nothing is left open." },
  { title: "Ship a sealed spec", body: "Gates, a cross-family review, then a signed release builders can read." },
];

export function AuthGate({ onAuthenticated }: AuthGateProps) {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const client = createApiClient();

  const submitCredentials = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (tab === "login") {
        const res = await unwrap(client.api.auth.login.post({ email, password }));
        await onAuthenticated(res.user);
      } else {
        const res = await unwrap(
          client.api.auth.register.post({
            email,
            password,
            displayName: displayName || email.split("@")[0] || "Owner",
          }),
        );
        await onAuthenticated(res.user, res.builderTokenPlain);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const launchInvite = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await unwrap(client.api.auth.invite.post());
      await onAuthenticated(res.user, res.builderTokenPlain);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The guest session could not start.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-grid">
      <section className="auth-hero">
        <span className="eyebrow">Æion Spec</span>
        <h1>Specs that survive a room full of skeptics.</h1>
        <p className="lead">
          An Elephant interviews you, a swarm of Goldfish reviewers with no shared memory challenges every answer,
          and only a spec that passes the AxiomSpec gates gets sealed.
        </p>
        <ol className="journey">
          {STEPS.map((s, i) => (
            <li key={s.title} className="journey-step">
              <span className="step-dot tabular" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <strong>{s.title}</strong>
                <span className="muted">{s.body}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel auth-card" aria-label="Sign in">
        <div className="segmented" role="tablist" aria-label="Account">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "login"}
            className={`segment ${tab === "login" ? "active" : ""}`}
            onClick={() => setTab("login")}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "register"}
            className={`segment ${tab === "register" ? "active" : ""}`}
            onClick={() => setTab("register")}
          >
            Create account
          </button>
        </div>

        <form onSubmit={submitCredentials} className="stack">
          {tab === "register" && (
            <div className="field">
              <label htmlFor="auth-display">Name</label>
              <input
                id="auth-display"
                className="input"
                type="text"
                autoComplete="name"
                required
                minLength={2}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>

          <div className="field">
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              className="input"
              type="password"
              autoComplete={tab === "register" ? "new-password" : "current-password"}
              required
              minLength={tab === "register" ? 12 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {tab === "register" && <span className="hint">At least 12 characters.</span>}
          </div>

          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "One moment…" : tab === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="divider">
          <span>or</span>
        </div>

        <div className="invite-box">
          <div>
            <strong>Try it as a guest</strong>
            <p className="muted">
              Everything stays in memory and is erased when you leave. No account, nothing written to disk.
            </p>
          </div>
          <button type="button" className="btn btn-block" disabled={busy} onClick={() => void launchInvite()}>
            Continue as guest
          </button>
        </div>
      </section>
    </div>
  );
}
