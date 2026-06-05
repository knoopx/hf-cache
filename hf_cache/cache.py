"""HF cache directory scanner and deletion — stdlib only, no huggingface-hub."""

import os
import shutil
from pathlib import Path
from collections import defaultdict


# Default HF cache location
_DEFAULT_CACHE_DIR = Path.home() / ".cache" / "huggingface" / "hub"

# OS helper files to skip
_FILES_TO_IGNORE = {".DS_Store"}

# Valid repo types
_VALID_REPO_TYPES = {"model", "dataset", "space"}


def get_cache_dir() -> Path:
    """Resolve the HF cache directory from env or default."""
    env = os.environ.get("HF_HUB_CACHE")
    if env:
        return Path(env).expanduser().resolve()
    return _DEFAULT_CACHE_DIR.expanduser().resolve()


def _parse_repo_dir_name(name: str) -> tuple[str, str] | None:
    """Parse a cache directory name like 'models--owner--repo' into (type, id).

    Returns None if the name is not a valid HF cache directory.
    """
    if "--" not in name:
        return None
    prefix, rest = name.split("--", maxsplit=1)
    # "models" -> "model", "datasets" -> "dataset", "spaces" -> "space"
    repo_type = prefix[:-1]
    if repo_type not in _VALID_REPO_TYPES:
        return None
    repo_id = rest.replace("--", "/")
    return repo_type, repo_id


def _scan_repo(repo_path: Path) -> dict | None:
    """Scan a single cached repo directory and return info dict, or None if invalid."""
    if not repo_path.is_dir():
        return None

    parsed = _parse_repo_dir_name(repo_path.name)
    if parsed is None:
        return None

    repo_type, repo_id = parsed

    snapshots_path = repo_path / "snapshots"
    refs_path = repo_path / "refs"

    if not snapshots_path.is_dir():
        return None

    # Read refs (e.g. refs/main -> commit_hash)
    refs_by_hash: dict[str, set[str]] = defaultdict(set)
    if refs_path.is_dir():
        for ref_path in refs_path.glob("**/*"):
            if ref_path.is_dir() or ref_path.name in _FILES_TO_IGNORE:
                continue
            ref_name = str(ref_path.relative_to(refs_path))
            try:
                commit_hash = ref_path.read_text().strip()
                refs_by_hash[commit_hash].add(ref_name)
            except (OSError, UnicodeError):
                continue

    # Walk snapshots
    revisions: list[dict] = []
    blob_stats: dict[Path, os.stat_result] = {}  # blob_path -> stat

    for revision_path in snapshots_path.iterdir():
        if revision_path.name in _FILES_TO_IGNORE:
            continue
        if revision_path.is_file():
            continue

        commit_hash = revision_path.name
        cached_files: set[Path] = set()

        for file_path in revision_path.glob("**/*"):
            if file_path.is_dir():
                continue

            try:
                blob_path = file_path.resolve()
            except OSError:
                continue

            if not blob_path.exists():
                continue

            if blob_path not in blob_stats:
                try:
                    blob_stats[blob_path] = blob_path.stat()
                except OSError:
                    continue

            cached_files.add(blob_path)

        # Compute revision size (unique blobs only)
        rev_size = sum(blob_stats[b].st_size for b in cached_files if b in blob_stats)

        # Last modified: latest blob mtime or dir mtime if empty
        if cached_files and blob_stats:
            rev_mtime = max(
                blob_stats[b].st_mtime for b in cached_files if b in blob_stats
            )
        else:
            try:
                rev_mtime = revision_path.stat().st_mtime
            except OSError:
                rev_mtime = 0.0

        revisions.append({
            "commit_hash": commit_hash,
            "snapshot_path": revision_path,
            "size_on_disk": rev_size,
            "refs": frozenset(refs_by_hash.pop(commit_hash, set())),
            "nb_files": len(cached_files),
            "last_modified": rev_mtime,
        })

    # Compute repo-level stats
    if blob_stats:
        repo_size = sum(s.st_size for s in blob_stats.values())
        repo_last_accessed = max(s.st_atime for s in blob_stats.values())
        repo_last_modified = max(s.st_mtime for s in blob_stats.values())
    else:
        repo_size = 0
        try:
            stats = repo_path.stat()
            repo_last_accessed = stats.st_atime
            repo_last_modified = stats.st_mtime
        except OSError:
            repo_last_accessed = 0.0
            repo_last_modified = 0.0

    return {
        "repo_id": repo_id,
        "repo_type": repo_type,
        "repo_path": repo_path,
        "size_on_disk": repo_size,
        "nb_files": len(blob_stats),
        "revisions": revisions,
        "last_accessed": repo_last_accessed,
        "last_modified": repo_last_modified,
    }


def scan_cache_dir(cache_dir: Path | None = None) -> list[dict]:
    """Scan the HF cache directory and return a list of repo info dicts."""
    if cache_dir is None:
        cache_dir = get_cache_dir()

    if not cache_dir.exists():
        return []
    if cache_dir.is_file():
        return []

    repos: list[dict] = []
    for entry in cache_dir.iterdir():
        if entry.name == ".locks" or entry.name == "CACHEDIR.TAG":
            continue
        if not entry.is_dir():
            continue
        info = _scan_repo(entry)
        if info is not None:
            repos.append(info)

    return repos


def delete_repo(repo_path: Path) -> None:
    """Delete an entire cached repo directory."""
    shutil.rmtree(repo_path)
