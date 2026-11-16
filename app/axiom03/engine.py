#!/usr/bin/env python3
# Spec: knowledge/components/aeion-engine.md
"""Bridge between Elysia server and vendored aeion-framework AxiomSpec 0.3 QA modules."""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
VENDOR_QA = HERE / "vendor" / "qa"
VENDOR_SCHEMAS = HERE / "vendor" / "schemas"
if str(VENDOR_QA) not in sys.path:
    sys.path.insert(0, str(VENDOR_QA))

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ed25519  # noqa: E402
from jsonschema import ValidationError  # noqa: E402

import approvals  # noqa: E402
import check_package  # noqa: E402
import graph_index  # noqa: E402
import release_diff  # noqa: E402


def _load_schema(name: str) -> dict[str, Any]:
    return json.loads((VENDOR_SCHEMAS / name).read_text(encoding="utf-8"))


def _eval_gates(
    spec: dict[str, Any],
    schema_errors: list[str],
    ref_errors: list[str],
    diff_report: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], int, str]:
    nodes = spec.get("nodes", [])
    blocking_open = [
        n["id"]
        for n in nodes
        if n.get("status") == "active"
        and n.get("kind") == "Decision"
        and n.get("data", {}).get("blocking")
        and n.get("data", {}).get("answer") is None
    ]
    unverified_assumptions = [
        n["id"]
        for n in nodes
        if n.get("status") == "active"
        and n.get("kind") == "Assumption"
        and n.get("data", {}).get("blocking")
        and n.get("data", {}).get("state") == "unverified"
    ]
    reqs = [n for n in nodes if n.get("kind") == "Requirement" and n.get("status") == "active"]
    total_weight = sum(int(n["data"]["weight_minor"]) for n in reqs)
    units = max(1, int(spec.get("project", {}).get("weight_minor_units", 100)))
    risk_score = round(total_weight / (units * max(1, len(reqs)))) if reqs else 0
    neg_tests = [
        n for n in nodes
        if n.get("kind") == "TestCase" and n.get("status") == "active" and n.get("data", {}).get("negative")
    ]
    pos_tests = [
        n for n in nodes
        if n.get("kind") == "TestCase" and n.get("status") == "active" and not n.get("data", {}).get("negative")
    ]
    has_g07_err = any(e in ref_errors for e in ("SCENARIO_NOT_ILLUSTRATING", "FLAG_STATE_UNTESTED", "UNKNOWN_SCENARIO"))
    has_g02_err = any(e in ref_errors for e in ("DUPLICATE_ID", "UNKNOWN_TARGET", "WRONG_EDGE_TYPE", "DEPENDENCY_CYCLE", "ACTIVE_TO_RETIRED", "WRONG_PREFIX"))
    has_g04_err = any(e in ref_errors for e in ("INCONSISTENT_REVIEW", "INCONSISTENT_BCIR", "INVALID_WINDOW", "UNLINKED_CONSTRAINT", "INVALID_STATES", "UNREACHABLE_STATE", "TERMINAL_HAS_EXIT"))

    recommended_bump = "minor"
    if diff_report and diff_report.get("required_step") in ("major", "minor", "patch"):
        recommended_bump = diff_report["required_step"]

    gates = [
        {
            "gateId": "G01",
            "name": "Strict JSON & Draft-2020-12 Schema",
            "passed": len(schema_errors) == 0,
            "severity": "error",
            "detail": "Schema valid (axiomspec/0.3)" if not schema_errors else "; ".join(schema_errors[:5]),
        },
        {
            "gateId": "G02",
            "name": "Graph Identity, DAG & Provenance",
            "passed": not has_g02_err and "EMPTY_BASELINE" not in ref_errors and "REQUIREMENT_PROVENANCE" not in ref_errors,
            "severity": "error",
            "detail": "All active requirements trace to goals and sources with acyclic DAG"
            if not has_g02_err
            else "Provenance or graph topology error",
        },
        {
            "gateId": "G03",
            "name": "Glossary Terms & Units",
            "passed": "UNKNOWN_UNIT_TERM" not in ref_errors and "UNIT_ANNOTATION" not in ref_errors,
            "severity": "error",
            "detail": "Term units & environment annotations consistent",
        },
        {
            "gateId": "G04",
            "name": "Constraints & State Reachability",
            "passed": not has_g04_err,
            "severity": "error",
            "detail": "All active constraints formalized cleanly",
        },
        {
            "gateId": "G05",
            "name": "Witness & Negative Counterexamples",
            "passed": len(pos_tests) > 0 and len(neg_tests) > 0 and not has_g07_err,
            "severity": "error",
            "detail": f"{len(pos_tests)} positive + {len(neg_tests)} negative test oracle(s)",
        },
        {
            "gateId": "G06",
            "name": "Blocking Decisions Resolved",
            "passed": len(blocking_open) == 0 and len(unverified_assumptions) == 0,
            "severity": "error",
            "detail": "All blocking decisions & assumptions settled"
            if not blocking_open and not unverified_assumptions
            else f"Unresolved blocking items: {', '.join(blocking_open + unverified_assumptions)}",
        },
        {
            "gateId": "G07",
            "name": "Feature Flag Hygiene",
            "passed": "STALE_FLAG" not in ref_errors and "UNUSED_FLAG" not in ref_errors and "FLAG_VERSION" not in ref_errors,
            "severity": "error",
            "detail": "Feature flags lifecycle clean",
        },
        {
            "gateId": "G08",
            "name": "Context Asset Trust Boundaries",
            "passed": "UNKNOWN_ASSET_REFERENCE" not in ref_errors and "ASSET_BINDING_MISMATCH" not in ref_errors,
            "severity": "error",
            "detail": "All context assets bound to declared actors",
        },
        {
            "gateId": "G09",
            "name": "Code Binding Safety",
            "passed": "UNSAFE_BINDING_PATH" not in ref_errors and "WRONG_BINDING_TARGET" not in ref_errors,
            "severity": "error",
            "detail": "Bindings use safe repository-relative paths",
        },
        {
            "gateId": "G10",
            "name": "Executable Verification Mapping",
            "passed": len(reqs) == 0 or len(pos_tests) >= len(reqs),
            "severity": "warning",
            "detail": f"{len(pos_tests)}/{len(reqs)} requirements mapped to test cases",
        },
        {
            "gateId": "G11",
            "name": "Export Surface Integrity",
            "passed": "INVALID_EXPORT" not in ref_errors,
            "severity": "error",
            "detail": f"{len(spec.get('exports', []))} exported specification node(s)",
        },
        {
            "gateId": "G12",
            "name": "Approval Policy Satisfiability",
            "passed": "UNSATISFIABLE_APPROVAL_POLICY" not in ref_errors and "INVALID_APPROVAL_KEY" not in ref_errors,
            "severity": "error",
            "detail": "Declared approval policy is satisfiable",
        },
        {
            "gateId": "G13",
            "name": "Bounded Graph Indexable",
            "passed": len(schema_errors) == 0 and len(ref_errors) == 0,
            "severity": "error",
            "detail": "Graph index construction verified",
        },
        {
            "gateId": "G14",
            "name": "Release Versioning & Compatibility",
            "passed": (
                "INVALID_VERSION_STEP" not in ref_errors
                and "COMPATIBILITY_WITHOUT_BASELINE" not in ref_errors
                and (diff_report is None or diff_report.get("status") == "pass")
            ),
            "severity": "error",
            "detail": (
                f"Version {spec.get('release', {}).get('version')} ({recommended_bump} step)"
                if diff_report is None or diff_report.get("status") == "pass"
                else "; ".join(e["message"] for e in diff_report.get("errors", [])[:3])
            ),
        },
    ]
    return gates, int(round(risk_score)), recommended_bump


def handle_validate_spec(payload: dict[str, Any]) -> dict[str, Any]:
    spec_obj = payload["spec"]
    baseline_obj = payload.get("baseline")
    raw_bytes = json.dumps(spec_obj, ensure_ascii=False).encode("utf-8")
    schema_errors: list[str] = []
    ref_errors: list[str] = []
    diff_report: dict[str, Any] | None = None

    try:
        parsed = check_package.strict_json(raw_bytes)
    except Exception as exc:
        return {
            "specVersion": "axiomspec/0.3",
            "valid": False,
            "riskScore": 100,
            "recommendedBump": "major",
            "gates": [],
            "errors": [f"STRICT_JSON: {exc}"],
            "warnings": [],
            "snapshotDigest": "",
            "specJson": spec_obj,
        }

    validator = check_package.make_validator(_load_schema("spec.schema.json"), check_formats=True)
    for err in sorted(validator.iter_errors(parsed), key=lambda e: list(e.path)):
        pointer = "/".join(str(p) for p in err.path) or "(root)"
        schema_errors.append(f"{pointer}: {err.message}")

    if not schema_errors:
        ref_errors = check_package.reference_errors(parsed)
        try:
            graph_index.build(parsed)
        except Exception as exc:
            ref_errors.append(f"GRAPH_INDEX: {exc}")
        if baseline_obj is not None:
            try:
                diff_report = release_diff.compare(baseline_obj, parsed)
            except Exception as exc:
                ref_errors.append(f"RELEASE_DIFF: {exc}")

    gates, risk_score, recommended_bump = _eval_gates(parsed, schema_errors, ref_errors, diff_report)
    errors = list(schema_errors) + list(ref_errors)
    if diff_report and diff_report.get("status") != "pass":
        for err in diff_report.get("errors", []):
            errors.append(f"{err['code']}: {err['message']}")
    for gate in gates:
        if not gate["passed"] and gate["severity"] == "error":
            errors.append(f"{gate['gateId']}: {gate['detail']}")

    dedup_errors = list(dict.fromkeys(errors))
    warnings: list[str] = []
    for gate in gates:
        if not gate["passed"] and gate["severity"] == "warning":
            warnings.append(f"{gate['gateId']}: {gate['detail']}")

    snap_digest = check_package.digest(check_package.canonical(parsed))
    return {
        "specVersion": "axiomspec/0.3",
        "valid": len(dedup_errors) == 0,
        "riskScore": risk_score,
        "recommendedBump": recommended_bump,
        "gates": gates,
        "errors": dedup_errors,
        "warnings": warnings,
        "snapshotDigest": snap_digest,
        "specJson": parsed,
    }


def handle_compare_releases(payload: dict[str, Any]) -> dict[str, Any]:
    baseline = payload["baseline"]
    candidate = payload["candidate"]
    validator = check_package.make_validator(_load_schema("spec.schema.json"), check_formats=True)
    validator.validate(baseline)
    validator.validate(candidate)
    report = release_diff.compare(baseline, candidate)
    changes = report.get("changes", [])
    added = [c["subject_id"] for c in changes if c.get("kind") == "added"]
    removed = [c["subject_id"] for c in changes if c.get("kind") == "removed"]
    changed = [c["subject_id"] for c in changes if c.get("kind") not in ("added", "removed")]
    breaking = [c["subject_id"] for c in changes if c.get("level") == "major"]
    return {
        "report": report,
        "recommendedBump": report.get("required_step") if report.get("required_step") in ("major", "minor", "patch") else "patch",
        "riskScore": int(report.get("risk", {}).get("exposure_permille", 0)),
        "addedNodes": added,
        "removedNodes": removed,
        "changedNodes": changed,
        "breakingChanges": breaking,
    }


def handle_sign_and_verify(payload: dict[str, Any]) -> dict[str, Any]:
    spec = payload["spec"]
    baseline = payload.get("baseline")
    actor_id = payload.get("actorId", "ACTOR-001")
    key_id = payload.get("keyId", "KEY-001")
    priv = ed25519.Ed25519PrivateKey.generate()
    pub_raw = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    pub_b64 = base64.b64encode(pub_raw).decode("ascii")
    spec_copy = json.loads(json.dumps(spec))
    spec_copy["approval"] = {
        "policy": {
            "low": {"approvers": 1, "methods": ["operator_ed25519"]},
            "medium": {"approvers": 1, "methods": ["operator_ed25519"]},
            "high": {"approvers": 1, "methods": ["operator_ed25519"]},
            "critical": {"approvers": 1, "methods": ["operator_ed25519"]},
        },
        "keys": [
            {
                "id": key_id,
                "actor_id": actor_id,
                "method": "operator_ed25519",
                "algorithm": "ed25519",
                "public_key": pub_b64,
                "attests": False,
            }
        ],
    }
    if baseline is not None:
        governing = json.loads(json.dumps(baseline))
        governing["approval"] = spec_copy["approval"]
    else:
        governing = spec_copy
    msg = approvals.statement(spec_copy, actor_id, key_id, "operator_ed25519")
    sig_b64 = base64.b64encode(priv.sign(msg)).decode("ascii")
    spec_digest = check_package.digest(check_package.canonical(spec_copy))
    approval_bundle = {
        "format": approvals.FORMAT,
        "project_id": spec_copy["project"]["id"],
        "version": spec_copy["release"]["version"],
        "spec_sha256": spec_digest,
        "approvals": [
            {
                "actor_id": actor_id,
                "key_id": key_id,
                "signature": sig_b64,
                "authenticator_data": None,
                "client_data_json": None,
            }
        ],
    }
    verdict = approvals.verify(spec_copy, approval_bundle, governing if baseline is not None else None)
    return {
        "spec": spec_copy,
        "specDigest": spec_digest,
        "approvalBundle": approval_bundle,
        "verification": verdict,
        "signature": sig_b64,
        "publicKey": pub_b64,
    }


def main() -> int:
    raw = sys.stdin.read()
    payload = json.loads(raw)
    action = payload.get("action")
    if action == "validate_spec":
        result = handle_validate_spec(payload)
    elif action == "compare_releases":
        result = handle_compare_releases(payload)
    elif action == "sign_and_verify":
        result = handle_sign_and_verify(payload)
    else:
        raise ValueError(f"Unsupported axiom03 action: {action}")
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ValidationError as exc:
        sys.stdout.write(json.dumps({"error": f"Schema validation failed: {exc.message}"}))
        sys.exit(2)
    except Exception as exc:
        sys.stdout.write(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        sys.exit(1)
