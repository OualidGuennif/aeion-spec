// Spec: knowledge/components/spec-studio.md
"use client";

import { useState, type FormEvent } from "react";
import type { SessionUser } from "@aeion-spec/shared";
import { createApiClient, unwrap } from "../lib/api.ts";

interface AuthGateProps {
  // Resolves once the workspace loads so any startup failure stays visible on this screen.
  onAuthenticated: (user: SessionUser, builderTokenPlain?: string) => Promise<void>;
}

function StepIcon({ kind }: { kind: "board" | "review" | "seal" }) {
  if (kind === "board") {
    return (
      <svg className="journey-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
        <path d="M7.5 3.5v13M12.5 3.5v13" />
      </svg>
    );
  }
  if (kind === "review") {
    return (
      <svg className="journey-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3H6.5A2.5 2.5 0 0 1 4 10.5v-5Z" />
      </svg>
    );
  }
  return (
    <svg className="journey-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M10 2.5 16 5v4.8c0 3.7-2.6 6.7-6 7.7-3.4-1-6-4-6-7.7V5l6-2.5Z" />
      <path d="m7.5 10 1.8 1.8 3.4-3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const STEPS: Array<{ icon: "board" | "review" | "seal"; title: string; body: string }> = [
  {
    icon: "board",
    title: "Scope the work",
    body: "Add a feature to your release board, alone or beside a quarantined codebase.",
  },
  {
    icon: "review",
    title: "Test every angle",
    body: "Answer Elephant's questions while eight reviewers probe security, reliability, UX, and cost.",
  },
  {
    icon: "seal",
    title: "Seal the contract",
    body: "Run AxiomSpec gates across model families, then serve a signed spec over the Builder API.",
  },
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
        <h1>Specs that hold up before anyone writes code.</h1>
        <p className="lead">
          Discuss a feature with Elephant, test it against eight zero-memory Goldfish reviewers, and seal an AxiomSpec
          contract that builders can read.
        </p>
        <ul className="journey">
          {STEPS.map((s) => (
            <li key={s.title} className="journey-step">
              <StepIcon kind={s.icon} />
              <div>
                <strong>{s.title}</strong>
                <span className="muted">{s.body}</span>
              </div>
            </li>
          ))}
        </ul>
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
            {busy ? "Signing in..." : tab === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="divider">
          <span>or</span>
        </div>

        <div className="invite-box">
          <div>
            <strong>Try without an account</strong>
            <p className="muted">
              Your projects, keys, and interviews stay in memory and disappear when you leave or close your session.
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
