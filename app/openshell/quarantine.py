#!/usr/bin/env python3
# Spec: knowledge/components/openshell.md
"""Zero-trust archive & GitHub repository quarantine, symlink guard, and secret scrubber."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

MAX_ARCHIVE_BYTES = 100 * 1024 * 1024  # 100 MiB compressed upload ceiling
MAX_EXPANDED_BYTES = 250 * 1024 * 1024  # 250 MiB uncompressed ceiling
MAX_FILES = 15_000
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_EXPANSION_RATIO = 25.0

GITHUB_REPO_RE = re.compile(
    r"^https://github\.com/([A-Za-z0-9_.-]{1,100})/([A-Za-z0-9_.-]{1,100})(?:\.git)?/?$"
)

SKIPPED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    "dist",
    "build",
    "target",
}

SECRET_PATTERNS = [
    (re.compile(r"sk-ant-[A-Za-z0-9_-]{16,}"), "[REDACTED_ANTHROPIC_KEY]"),
    (re.compile(r"sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}"), "[REDACTED_API_KEY]"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "[REDACTED_GITHUB_PAT]"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "[REDACTED_AWS_KEY]"),
    (
        re.compile(
            r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PRIVATE )?PRIVATE KEY-----[\s\S]*?-----END [^-]+-----"
        ),
        "[REDACTED_PRIVATE_KEY]",
    ),
]


def _validate_rel_path(raw_name: str) -> PurePosixPath | None:
    cleaned = raw_name.replace("\\", "/")
    if "\x00" in cleaned or cleaned.startswith("/") or ":" in cleaned:
        return None
    parts = [p for p in PurePosixPath(cleaned).parts if p not in ("", ".")]
    if not parts or ".." in parts:
        return None
    if any(part in SKIPPED_DIRS for part in parts):
        return None
    # Strip top-level archive folder if GitHub-style tarball/zip prefix isn't handled yet
    return PurePosixPath(*parts)


def _scrub_bytes(rel_path: str, raw: bytes) -> tuple[bytes, int, bool]:
    basename = PurePosixPath(rel_path).name.lower()
    if basename.startswith(".env") or basename.endswith((".pem", ".key", ".p12", ".pfx")):
        return b"# [QUARANTINED SENSITIVE FILE CONTENT REDACTED]\n", 1, True
    if b"\x00" in raw[:4096]:
        # Binary blob: skip storing inside text index unless small metadata
        return b"", 0, False
    text = raw.decode("utf-8", errors="replace")
    redactions = 0
    for pattern, replacement in SECRET_PATTERNS:
        text, count = pattern.subn(replacement, text)
        redactions += count
    return text.encode("utf-8"), redactions, False


def _add_file_to_snapshot(
    files: dict[str, str],
    rejected: list[str],
    rel_path: str,
    raw: bytes,
) -> tuple[int, int]:
    if len(raw) > MAX_FILE_BYTES:
        rejected.append(f"{rel_path}: exceeds 2 MiB per-file text limit")
        return 0, 0
    scrubbed, redactions, _is_env = _scrub_bytes(rel_path, raw)
    if not scrubbed:
        return 0, redactions
    files[rel_path] = scrubbed.decode("utf-8", errors="replace")
    return len(scrubbed), redactions


def _quarantine_zip(archive_path: Path) -> dict[str, Any]:
    compressed_bytes = archive_path.stat().st_size
    if compressed_bytes > MAX_ARCHIVE_BYTES:
        raise ValueError(f"Archive exceeds 100 MiB ceiling ({compressed_bytes} bytes).")

    files: dict[str, str] = {}
    rejected: list[str] = []
    expanded_total = 0
    redactions_total = 0

    with zipfile.ZipFile(archive_path, "r") as zf:
        infos = zf.infolist()
        if len(infos) > MAX_FILES:
            raise ValueError(f"Archive exceeds file count limit ({MAX_FILES}).")
        for info in infos:
            mode = (info.external_attr >> 16) & 0o170000
            if stat.S_ISLNK(mode):
                rejected.append(f"{info.filename}: symlink rejected")
                continue
            if info.is_dir():
                continue
            rel = _validate_rel_path(info.filename)
            if rel is None:
                if not any(part in SKIPPED_DIRS for part in info.filename.split("/")):
                    rejected.append(f"{info.filename}: unsafe or traversal path")
                continue
            expanded_total += info.file_size
            if expanded_total > MAX_EXPANDED_BYTES:
                raise ValueError("Zip bomb protection triggered: expanded size exceeds 250 MiB.")
            if compressed_bytes > 0 and (expanded_total / compressed_bytes) > MAX_EXPANSION_RATIO and expanded_total > 10 * 1024 * 1024:
                raise ValueError("Zip bomb protection triggered: abnormal compression ratio.")
            if len(files) >= MAX_FILES:
                rejected.append(f"{rel}: skipped past file count limit")
                continue
            with zf.open(info, "r") as fh:
                raw = fh.read(MAX_FILE_BYTES + 1)
            if len(raw) > MAX_FILE_BYTES:
                rejected.append(f"{rel}: file larger than 2 MiB")
                continue
            _stored, red = _add_file_to_snapshot(files, rejected, rel.as_posix(), raw)
            redactions_total += red

    return _finalize_snapshot(files, rejected, expanded_total, redactions_total)


def _quarantine_tar(archive_path: Path) -> dict[str, Any]:
    compressed_bytes = archive_path.stat().st_size
    if compressed_bytes > MAX_ARCHIVE_BYTES:
        raise ValueError(f"Archive exceeds 100 MiB ceiling ({compressed_bytes} bytes).")

    files: dict[str, str] = {}
    rejected: list[str] = []
    expanded_total = 0
    redactions_total = 0

    with tarfile.open(archive_path, "r:*") as tf:
        for member in tf:
            if len(files) >= MAX_FILES:
                rejected.append(f"{member.name}: file count limit reached")
                break
            if member.issym() or member.islnk() or member.ischr() or member.isblk() or member.isfifo():
                rejected.append(f"{member.name}: special/link entry rejected")
                continue
            if not member.isfile():
                continue
            rel = _validate_rel_path(member.name)
            if rel is None:
                if not any(part in SKIPPED_DIRS for part in member.name.split("/")):
                    rejected.append(f"{member.name}: unsafe or traversal path")
                continue
            expanded_total += member.size
            if expanded_total > MAX_EXPANDED_BYTES:
                raise ValueError("Archive bomb protection triggered: expanded size exceeds 250 MiB.")
            if compressed_bytes > 0 and (expanded_total / compressed_bytes) > MAX_EXPANSION_RATIO and expanded_total > 10 * 1024 * 1024:
                raise ValueError("Archive bomb protection triggered: abnormal compression ratio.")
            extracted = tf.extractfile(member)
            if extracted is None:
                continue
            raw = extracted.read(MAX_FILE_BYTES + 1)
            if len(raw) > MAX_FILE_BYTES:
                rejected.append(f"{rel}: file larger than 2 MiB")
                continue
            _stored, red = _add_file_to_snapshot(files, rejected, rel.as_posix(), raw)
            redactions_total += red

    return _finalize_snapshot(files, rejected, expanded_total, redactions_total)


def _quarantine_directory(root_dir: Path) -> dict[str, Any]:
    files: dict[str, str] = {}
    rejected: list[str] = []
    expanded_total = 0
    redactions_total = 0

    resolved_root = root_dir.resolve()
    for current, dirs, filenames in os.walk(resolved_root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIPPED_DIRS)
        cur_path = Path(current)
        for fname in sorted(filenames):
            fpath = cur_path / fname
            if fpath.is_symlink():
                rejected.append(f"{fname}: symlink rejected")
                continue
            rel_obj = fpath.relative_to(resolved_root)
            rel_posix = PurePosixPath(*rel_obj.parts).as_posix()
            try:
                fd = os.open(fpath, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            except OSError as exc:
                rejected.append(f"{rel_posix}: open blocked ({exc})")
                continue
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode):
                    rejected.append(f"{rel_posix}: non-regular file rejected")
                    continue
                if expanded_total + st.st_size > MAX_EXPANDED_BYTES:
                    raise ValueError("Repository exceeds 250 MiB quarantined ceiling.")
                raw = os.read(fd, MAX_FILE_BYTES + 1)
            finally:
                os.close(fd)
            expanded_total += len(raw)
            if len(raw) > MAX_FILE_BYTES:
                rejected.append(f"{rel_posix}: file larger than 2 MiB")
                continue
            _stored, red = _add_file_to_snapshot(files, rejected, rel_posix, raw)
            redactions_total += red
            if len(files) >= MAX_FILES:
                break

    return _finalize_snapshot(files, rejected, expanded_total, redactions_total)


def _finalize_snapshot(
    files: dict[str, str],
    rejected: list[str],
    expanded_total: int,
    redactions_total: int,
) -> dict[str, Any]:
    hasher = hashlib.sha256()
    for rel in sorted(files):
        hasher.update(rel.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(files[rel].encode("utf-8"))
        hasher.update(b"\0")
    return {
        "totalBytes": expanded_total,
        "fileCount": len(files),
        "quarantinedCount": len(files),
        "redactedSecretsCount": redactions_total,
        "rejectedEntries": rejected[:100],
        "rootDigest": hasher.hexdigest(),
        "files": files,
    }


def _quarantine_github(url: str, token: str | None) -> dict[str, Any]:
    match = GITHUB_REPO_RE.match(url.strip())
    if not match:
        raise ValueError(
            "Invalid GitHub repository URL. Must match https://github.com/<owner>/<repo>."
        )
    owner, repo = match.group(1), match.group(2)
    canonical_url = f"https://github.com/{owner}/{repo}.git"

    with tempfile.TemporaryDirectory(prefix="aeion-gh-") as tmp:
        dest = Path(tmp) / "checkout"
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_LFS_SKIP_SMUDGE": "1",
        }
        if token:
            basic = base64.b64encode(f"x-access-token:{token}".encode("utf-8")).decode("ascii")
            env["GIT_CONFIG_COUNT"] = "1"
            env["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader"
            env["GIT_CONFIG_VALUE_0"] = f"Authorization: Basic {basic}"

        proc = subprocess.run(
            [
                "git",
                "clone",
                "--depth=1",
                "--no-recurse-submodules",
                "--single-branch",
                canonical_url,
                str(dest),
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=90,
        )
        if proc.returncode != 0:
            err = proc.stderr.strip().replace(token or "__NO_TOKEN__", "[REDACTED]")
            raise ValueError(f"GitHub read-only clone failed: {err[:300]}")

        git_dir = dest / ".git"
        if git_dir.exists():
            shutil.rmtree(git_dir)
        return _quarantine_directory(dest)


def main() -> int:
    payload = json.loads(sys.stdin.read())
    action = payload.get("action")
    if action == "quarantine_archive":
        archive = Path(payload["archivePath"])
        name_lower = str(payload.get("filename", archive.name)).lower()
        if name_lower.endswith(".zip"):
            result = _quarantine_zip(archive)
        else:
            result = _quarantine_tar(archive)
    elif action == "quarantine_github":
        result = _quarantine_github(payload["repoUrl"], payload.get("token"))
    else:
        raise ValueError(f"Unknown quarantine action: {action}")
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        sys.stdout.write(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        sys.exit(1)
