#!/usr/bin/env python3
# Spec: knowledge/components/openshell.md
"""OpenShell 0.1.8 & hardened Docker sandbox driver for quarantined aeion-spec projects."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
OPENSHELL_STATE_DIR = REPO_ROOT / "app" / ".aeion" / "openshell"
OBSERVABILITY_BIN = (
    REPO_ROOT.parent
    / "aeion-observability"
    / "demo"
    / ".local"
    / "openshell"
    / "bin"
    / "openshell"
)


def find_openshell_binary() -> str | None:
    if OBSERVABILITY_BIN.exists():
        return str(OBSERVABILITY_BIN)
    return shutil.which("openshell")


def openshell_env() -> dict[str, str]:
    OPENSHELL_STATE_DIR.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["OPENSHELL_TELEMETRY_ENABLED"] = "false"
    env["XDG_CONFIG_HOME"] = str(OPENSHELL_STATE_DIR / "config")
    env["XDG_DATA_HOME"] = str(OPENSHELL_STATE_DIR / "data")
    return env


def probe_runtime() -> dict[str, Any]:
    openshell_bin = find_openshell_binary()
    docker_bin = shutil.which("docker")
    openshell_gateway_ready = False
    docker_ready = False
    agent_image_present = False

    if openshell_bin:
        try:
            proc = subprocess.run(
                [openshell_bin, "status"],
                env=openshell_env(),
                capture_output=True,
                text=True,
                timeout=4,
            )
            openshell_gateway_ready = proc.returncode == 0
        except Exception:
            openshell_gateway_ready = False

    if docker_bin:
        try:
            proc = subprocess.run(
                [docker_bin, "info", "--format", "{{.ServerVersion}}"],
                capture_output=True,
                text=True,
                timeout=4,
            )
            docker_ready = proc.returncode == 0
            if docker_ready:
                img = subprocess.run(
                    [docker_bin, "images", "-q", "aeion-openshell-agent:local"],
                    capture_output=True,
                    text=True,
                    timeout=4,
                )
                agent_image_present = bool(img.stdout.strip())
        except Exception:
            docker_ready = False

    if openshell_gateway_ready:
        mode = "openshell"
    elif docker_ready:
        mode = "docker-hardened"
    else:
        mode = "quarantine-readonly"

    return {
        "mode": mode,
        "openshellBinary": openshell_bin,
        "openshellGatewayReady": openshell_gateway_ready,
        "dockerReady": docker_ready,
        "agentImagePresent": agent_image_present,
        "networkMode": "none",
        "landlockActive": openshell_gateway_ready,
        "telemetryDisabled": True,
    }


def materialize_snapshot(project_id: str, files: dict[str, str], root_digest: str) -> dict[str, Any]:
    """Write quarantined read-only files under app/.aeion/openshell/workspaces/<project_id>."""
    ws_dir = OPENSHELL_STATE_DIR / "workspaces" / project_id
    if ws_dir.exists():
        shutil.rmtree(ws_dir)
    ws_dir.mkdir(parents=True, exist_ok=True)
    for rel, content in files.items():
        target = (ws_dir / rel).resolve()
        if not target.is_relative_to(ws_dir.resolve()):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        os.chmod(target, 0o444)
    (ws_dir.parent / f"{project_id}.digest").write_text(root_digest, encoding="utf-8")
    return probe_runtime()


def main() -> int:
    payload = json.loads(sys.stdin.read())
    action = payload.get("action")
    if action == "probe":
        result = probe_runtime()
    elif action == "materialize":
        result = materialize_snapshot(
            payload["projectId"],
            payload.get("files", {}),
            payload.get("rootDigest", ""),
        )
    else:
        raise ValueError(f"Unsupported sandbox action: {action}")
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        sys.stdout.write(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        sys.exit(1)
