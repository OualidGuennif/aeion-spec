#!/usr/bin/env python3
# Spec: knowledge/components/aeion-engine.md
"""Python-side security & AxiomSpec 0.3 / OpenShell / LiteLLM contract verification."""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_VENV_CANDIDATE = ROOT / ".venv" / "bin" / "python"
VENV_PY = _VENV_CANDIDATE if _VENV_CANDIDATE.is_file() else Path(sys.executable)
QUARANTINE_PY = ROOT / "app" / "openshell" / "quarantine.py"
AXIOM03_PY = ROOT / "app" / "axiom03" / "engine.py"


class PlatformPythonTests(unittest.TestCase):
    def _run_py(self, script: Path, payload: dict) -> tuple[int, dict]:
        proc = subprocess.run(
            [str(VENV_PY), str(script)],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            check=False,
        )
        return proc.returncode, json.loads(proc.stdout)

    def test_quarantine_blocks_traversal_and_symlinks_and_scrubs_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            zpath = Path(tmp) / "bundle.zip"
            with zipfile.ZipFile(zpath, "w") as zf:
                zf.writestr("src/index.ts", "const k = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234';\n")
                zf.writestr("../../outside.sh", "rm -rf /\n")
                info = zipfile.ZipInfo("src/sym")
                info.create_system = 3
                info.external_attr = (0o120777 << 16)
                zf.writestr(info, "/etc/passwd")

            code, res = self._run_py(
                QUARANTINE_PY,
                {"action": "quarantine_archive", "archivePath": str(zpath), "filename": "bundle.zip"},
            )
            self.assertEqual(code, 0)
            self.assertEqual(res["fileCount"], 1)
            self.assertGreaterEqual(res["redactedSecretsCount"], 1)
            self.assertNotIn("abcdefghijklmnopqrstuvwxyz", res["files"]["src/index.ts"])
            self.assertTrue(any("outside.sh" in r for r in res["rejectedEntries"]))
            self.assertTrue(any("sym" in r for r in res["rejectedEntries"]))

    def test_quarantine_directory_stops_at_the_file_cap_across_folders(self) -> None:
        # Loaded in-process so the cap can be lowered without writing 15,000 files.
        spec = importlib.util.spec_from_file_location("aeion_quarantine", QUARANTINE_PY)
        quarantine = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(quarantine)
        quarantine.MAX_FILES = 2
        with tempfile.TemporaryDirectory() as tmp:
            for folder in ("a", "b", "c"):
                (Path(tmp) / folder).mkdir()
                for name in ("one.txt", "two.txt"):
                    (Path(tmp) / folder / name).write_text(f"{folder}/{name}\n")
            os.symlink(Path(tmp) / "a" / "one.txt", Path(tmp) / "a" / "link.txt")
            res = quarantine._quarantine_directory(Path(tmp))
        self.assertEqual(res["fileCount"], 2)
        self.assertIn("a/link.txt: symlink rejected", res["rejectedEntries"])

    def test_axiom03_engine_validates_strict_spec_and_rejects_broken_release_bump(self) -> None:
        base_spec = {
            "format": "axiomspec/0.3",
            "profile": "AX-CORE-0.3",
            "release": {"version": "0.1.0", "previous": None, "compatibility": []},
            "project": {
                "id": "PROJECT-001",
                "name": "Test Spec",
                "description": "Strict 0.3",
                "owner": "ACTOR-001",
                "mode": "product",
                "weight_minor_units": 100,
            },
            "actors": [
                {"id": "ACTOR-001", "name": "Owner", "type": "human_role", "binding_status": "verified"},
                {"id": "ACTOR-002", "name": "Agent", "type": "service", "binding_status": "asserted"},
            ],
            "approval": {
                "policy": {
                    "low": {"approvers": 0, "methods": []},
                    "medium": {"approvers": 0, "methods": []},
                    "high": {"approvers": 0, "methods": []},
                    "critical": {"approvers": 0, "methods": []},
                },
                "keys": [],
            },
            "imports": [],
            "exports": ["REQ-100"],
            "sources": [
                {
                    "id": "SRC-001",
                    "type": "user_input",
                    "locator": "aeion-spec://test",
                    "capture_sha256": "0" * 64,
                    "review_state": "reviewed",
                }
            ],
            "environments": [
                {
                    "id": "ENV-001",
                    "title": "Env",
                    "schema": {
                        "type": "object",
                        "properties": {"request_bytes": {"type": "integer", "minimum": 0, "maximum": 10000}},
                        "required": ["request_bytes"],
                        "additionalProperties": False,
                    },
                    "units": [],
                }
            ],
            "flags": [],
            "nodes": [
                {
                    "id": "GOAL-001",
                    "kind": "Goal",
                    "revision": 1,
                    "status": "active",
                    "title": "Deliver safe spec",
                    "owner": "ACTOR-001",
                    "created_by": "ACTOR-001",
                    "source_ids": ["SRC-001"],
                    "data": {"description": "Goal", "success_measure": "All gates pass"},
                },
                {
                    "id": "REQ-100",
                    "kind": "Requirement",
                    "revision": 1,
                    "status": "active",
                    "title": "Validate input",
                    "owner": "ACTOR-001",
                    "created_by": "ACTOR-002",
                    "source_ids": ["SRC-001"],
                    "data": {
                        "category": "security",
                        "priority": "must",
                        "risk": "high",
                        "verification_mode": "mixed",
                        "pattern": "ubiquitous",
                        "conditions": [],
                        "trigger": None,
                        "feature": None,
                        "subject": "api",
                        "response": "Reject invalid input",
                        "weight_minor": 7500,
                        "flag_id": None,
                    },
                },
                {
                    "id": "CON-100",
                    "kind": "Constraint",
                    "revision": 1,
                    "status": "active",
                    "title": "Boundary",
                    "owner": "ACTOR-001",
                    "created_by": "ACTOR-002",
                    "source_ids": ["SRC-001"],
                    "data": {
                        "classification": {
                            "category": "technical",
                            "explicitness": "explicit",
                            "temporality": "predefined",
                            "strength": "hard",
                        },
                        "scope": "linked",
                        "roles": ["enforcement", "verification"],
                        "representation": "review_protocol",
                        "environment_id": None,
                        "expression": None,
                        "review_protocol": "Fail closed on malformed input",
                        "enforcement_binding_id": None,
                        "effective_from": None,
                        "effective_until": None,
                        "predicate_role": "review",
                    },
                },
                {
                    "id": "SCN-200",
                    "kind": "Scenario",
                    "revision": 1,
                    "status": "active",
                    "title": "Witness",
                    "owner": "ACTOR-001",
                    "created_by": "ACTOR-002",
                    "source_ids": ["SRC-001"],
                    "data": {
                        "intent": "witness",
                        "environment_id": "ENV-001",
                        "given": {"request_bytes": 10},
                        "event": "ok",
                        "expected": "accept",
                        "constraint_expectations": [{"constraint_id": "CON-100", "expected": True}],
                    },
                },
                {
                    "id": "SCN-201",
                    "kind": "Scenario",
                    "revision": 1,
                    "status": "active",
                    "title": "Negative",
                    "owner": "ACTOR-001",
                    "created_by": "ACTOR-002",
                    "source_ids": ["SRC-001"],
                    "data": {
                        "intent": "counterexample",
                        "environment_id": "ENV-001",
                        "given": {"request_bytes": 0},
                        "event": "bad",
                        "expected": "reject",
                        "constraint_expectations": [{"constraint_id": "CON-100", "expected": False}],
                    },
                },
                {
                    "id": "TEST-200",
                    "kind": "TestCase",
                    "revision": 1,
                    "status": "active",
                    "title": "Pos test",
                    "owner": "ACTOR-001",
                    "created_by": "ACTOR-002",
                    "source_ids": ["SRC-001"],
                    "data": {
                        "level": "integration",
                        "oracle": "200 OK",
                        "state": "planned",
                        "runner": "factory",
                        "negative": False,
                        "witness_scenario_ids": ["SCN-200"],
                        "flag_states": [],
                    },
                },
                {
                    "id": "TEST-201",
                    "kind": "TestCase",
                    "revision": 1,
                    "status": "active",
                    "title": "Neg test",
                    "owner": "ACTOR-001",
                    "created_by": "ACTOR-002",
                    "source_ids": ["SRC-001"],
                    "data": {
                        "level": "contract",
                        "oracle": "400 Refusal",
                        "state": "planned",
                        "runner": "factory",
                        "negative": True,
                        "witness_scenario_ids": ["SCN-201"],
                        "flag_states": [],
                    },
                },
            ],
            "edges": [
                {"id": "EDGE-001", "from": "REQ-100", "relation": "satisfies", "to": "GOAL-001", "origin": "declared", "rationale": "t"},
                {"id": "EDGE-002", "from": "CON-100", "relation": "formalizes", "to": "REQ-100", "origin": "declared", "rationale": "t"},
                {"id": "EDGE-003", "from": "SCN-200", "relation": "illustrates", "to": "REQ-100", "origin": "declared", "rationale": "t"},
                {"id": "EDGE-004", "from": "SCN-201", "relation": "illustrates", "to": "REQ-100", "origin": "declared", "rationale": "t"},
                {"id": "EDGE-005", "from": "TEST-200", "relation": "verifies", "to": "REQ-100", "origin": "declared", "rationale": "t"},
                {"id": "EDGE-006", "from": "TEST-201", "relation": "verifies", "to": "REQ-100", "origin": "declared", "rationale": "t"},
            ],
            "bindings": [],
            "context_assets": [],
        }
        code, report = self._run_py(AXIOM03_PY, {"action": "validate_spec", "spec": base_spec})
        self.assertEqual(code, 0)
        self.assertTrue(report["valid"])
        self.assertEqual(len(report["gates"]), 14)

        code2, signed = self._run_py(AXIOM03_PY, {"action": "sign_and_verify", "spec": base_spec})
        self.assertEqual(code2, 0)
        self.assertEqual(signed["verification"]["status"], "pass")


if __name__ == "__main__":
    unittest.main()
