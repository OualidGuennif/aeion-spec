# Changelog

Every notable change, newest first ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[SemVer](https://semver.org/)). Each change adds its line under Unreleased; `tools/release/release`
dates them at release time. Spec: knowledge/policies/engineering.md

## [Unreleased]

## [0.2.1] - 2026-11-16

- Redesigned the Spec Studio web UI around an OpenAI-style monochrome black-and-white palette with a
  subtle Anthropic warm paper/clay touch and midnight blue focus/links, and simplified navigation into
  a 3-tab shell (`Workspace`, `Releases`, `Keys`) with project creation inside the project menu, a compact
  session menu, and a guided 4-step feature pipeline (`Ideas`, `Interview`, `Review`, `Validated`) with
  clear next-step guidance, `impeccable` craft cleanup, `humanizer` copy, and `temporary_tools/`
  gitignored.

## [0.2.0] - 2026-11-16

- A card is refused with 409 while a model run works on it, so an edit is no longer lost when the run
  saves; two seals of one sheet leave one sealed release and one active sheet, and a sheet's header
  cannot be renamed while it is sealed; an invite import that ends after its session is dropped instead
  of kept in RAM; quarantine helpers stop after 180 s; and `/api/health` reports the real version.
- The vault's AES-GCM accepts only full 16-byte tags, and CI installs Bun through a pinned
  `oven-sh/setup-bun` instead of piping a script into a shell (both found by the release's Semgrep scan).
- The application test job keeps the name `main`'s branch protection requires, so a release can merge.
- Updated Æion Factory 3.0.0 to Æion Template 4.0.3: the marker is `.aeion-template`, CI runs
  `tools/template-tests` and no longer runs `axiom check` or the efficiency bundle, and the doc gate now
  asks for a file's docs to be read before it is edited. The embedded AxiomSpec engine, `efficiency/` and
  `knowledge/axiomspec/` left the repository. `knowledge/spec/` and the `docs/` cockpit stay frozen until
  migrated to aeion-framework. OpenShell has its own spec (`knowledge/components/openshell.md`).
- A GitHub snapshot stops at its 15,000-file cap instead of letting every later folder add more, and a
  rejected symlink is named by its path in the repository.
- Rebuilt the application as **Æion Spec** (`aeion-spec`) on Bun + Elysia + Eden Treaty + Next.js with
  dual-mode auth (Argon2id accounts & ephemeral `:memory:` Invite Mode) and an AES-256-GCM + HKDF-SHA256
  user vault for provider API keys and read-only GitHub tokens.
- Added the Jira-style Release Tableau (`Idea` → `Goldfish Interview` → `Automated Review` → `Validated`),
  per-role 7-provider Model Mixer routed through `ContextRelay` + `litellm_bridge.py` (`x-opencode-session`
  forwarding and synchronous SSE fallback), Flue + Pi isolated Goldfish rounds, AxiomSpec `0.3` (`G01–G14`)
  + `aeion-observability` export compiler, immutable HMAC-signed release sealing with cumulative history, and
  scoped Builder Bearer API (`/api/v1/builder/*`).
- Integrated NVIDIA OpenShell (`openshell/quarantine.py` & `openshell/sandbox.py`) for `github_public`,
  `github_private`, and strict `<= 100 MB` `archive_upload` source ingestion with secret redaction, symlink
  rejection, and read-only sandboxing; removed legacy `app/aeion/`, `app/flue/`, and `app/web/` modules.
- Redesigned the web UI on glass light/dark tokens (PayPal ink and blue, Apple frosted layers, Skyscanner
  chips and swipeable lanes): theme set before first paint, compact phone header, archive and restore,
  release notes, copy buttons, per-role "no key stored" warnings, assumptions and reassessment in the drawer.
- Fixed a full review's findings. The automated review fails closed and submissions are re-checked
  against their schema. The bridge gets an allowlisted environment, and one failed Goldfish persona
  becomes a finding instead of sinking the swarm. Archived or sealed cards are refused with 409, so is a
  review run before the swarm and the owner are both satisfied, and an edit demotes a passed review. A seal needs a greater version and runs in one transaction. Failed
  ingests leave no orphan project. The API no longer shares its port with a stale instance. The web
  surfaces every failed request, rejects an interview stream that ends early, and keeps a project when
  only its upload failed. CI pins its Python test packages.

## [0.1.0] - 2026-11-10

- Æion Core 0.1.0 from Æion Factory 3.0.0: brainstorm (Elephant-Goldfish), spec studio with AxiomSpec gates and
  export for aeion-observability, documentation hub with a cited assistant; twelve Flue agents on
  deepseek-v4.1-flash at maximum reasoning, behind a loopback gateway that keeps the key.
- Hardened before the first push, from an independent review: a patch that still fails its checks is not
  applied and a value outside the AxiomSpec schema is never stored; nothing `axiom check` would refuse is
  saved; gates that did not run are `unknown`; approval needs aeion-observability's catalog; the server
  binds and answers loopback only (IPv4 or IPv6); a malformed or oversized `Content-Length` is refused on
  the server and the gateway. New tests prove the key never reaches a response and an export loads in
  aeion-observability's own catalog loader.
- The Model Context Protocol packages the Flue harness pins are overridden to their patched releases
  (sdk 1.32.2, client and server 2.4.0): the first dependency scan in CI flagged the pinned ones.
