---
type: Component
title: "OpenShell quarantine"
description: "How Æion Spec takes in a project's source: archive and GitHub quarantine, secret scrubbing, read-only snapshots in RAM or on disk, and the bounded read API the agents use."
status: stable
sources:
  - id: openshell_quarantine
    resource: ../../app/openshell/quarantine.py
    title: "Zero-trust archive & GitHub quarantine scrubber"
  - id: openshell_sandbox
    resource: ../../app/openshell/sandbox.py
    title: "OpenShell & Docker runtime probe and read-only snapshot writer"
  - id: openshell_service
    resource: ../../app/packages/server/src/openshell/service.ts
    title: "Server-side OpenShell orchestration & sandbox read API"
  - id: python_tests
    resource: ../../app/tests/test_platform_python.py
    title: "Quarantine contract tests"
---

# OpenShell quarantine

## Intent

Let the agents read a project's code without ever running it, writing into it, or seeing its secrets.
Every source passes one quarantine and lands as a read-only, digested snapshot; the agents only reach
it through bounded list, slice and search calls.

## Data sources

| Source | What is read | Owner | Freshness |
| --- | --- | --- | --- |
| Uploaded archive | `.zip` or tarball bytes, at most 100 MiB | the project owner | once per upload |
| GitHub repository | a `--depth=1` clone without submodules or LFS, `.git` dropped | the project owner | once per ingest |
| Host runtime | `openshell status`, `docker info`, the `aeion-openshell-agent:local` image | the machine | probe cached 30 s |

## Inputs

`quarantine.py` and `sandbox.py` read one JSON object on stdin (`quarantine_archive`,
`quarantine_github`, `probe`, `materialize`) from `service.ts`. A private GitHub token is checked
against the repository first and reaches git only as an `http.extraheader` in the child environment.

## Outputs

A snapshot summary (`mode`, `networkMode: "none"`, byte and file counts, redactions, at most 100
rejected entries, a SHA-256 `rootDigest` over sorted paths and contents). Invite sessions keep the
files in RAM only; registered projects get read-only (`0444`) files under
`app/.aeion/openshell/workspaces/<projectId>/` and a `<projectId>.digest` beside them.

## Invariants

- Refused: archives over 100 MiB, over 250 MiB expanded, over a 25x ratio past 10 MiB, absolute or
  `..` paths, symlinks, non-regular files, and files over 2 MiB. A snapshot holds at most 15,000 files;
  a repository walk stops at the cap and says so once in the rejected entries.
- Version-control and dependency folders (`.git`, `node_modules`, `.venv`, `.next`, …) are skipped.
- `.env*`, `.pem`, `.key`, `.p12`, `.pfx` contents are replaced; Anthropic, OpenAI, GitHub and AWS
  keys and private-key blocks are redacted in every text file; binaries are dropped.
- A clone error never echoes the token; the clone runs with only `PATH` and git's no-prompt settings.
- Reads stay inside the project's workspace (`startsWith(base + "/")`, no symlinks), and an in-RAM
  path resolves own keys only.
- `mode` reports what the host offers (`openshell`, `docker-hardened` or `quarantine-readonly`); the
  server itself only reads the frozen snapshot and never executes its code.
- Logging out of an invite session or its expiry clears that session's snapshots.

## Determinism

The same files give the same `rootDigest`: paths are hashed in sorted order with their scrubbed contents.

## Acceptance checks

- [ ] `.venv/bin/python -m unittest discover -s app/tests -v` passes the quarantine contract tests.
- [ ] `(cd app && bun test packages/server/test)` passes the OpenShell ingest and invite cleanup tests.

## Out of scope

Running, building or testing the ingested code; writing back to the source repository; isolating the
agents' own processes, which `aeion-agents.md` covers.
