/**
 * HF cache directory scanner and deletion — ported from hf_cache/cache.py.
 * Self-contained: node:fs/promises + node:os + node:path only, no external deps.
 */

import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Default HF cache location. */
const DEFAULT_CACHE_DIR = path.join(homedir(), ".cache", "huggingface", "hub");

/** OS helper files to skip. */
const FILES_TO_IGNORE = new Set([".DS_Store"]);

/** Valid repo types. */
const VALID_REPO_TYPES = new Set(["model", "dataset", "space"]);

export interface Revision {
  commit_hash: string;
  snapshot_path: string;
  size_on_disk: number;
  refs: string[];
  nb_files: number;
  last_modified: number;
}

export interface RepoInfo {
  repo_id: string;
  repo_type: string;
  repo_path: string;
  size_on_disk: number;
  nb_files: number;
  revisions: Revision[];
  last_accessed: number;
  last_modified: number;
}

/** Expand a leading "~" the way Path.expanduser() does. */
function expandUser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** Resolve the HF cache directory from env or default. */
export function getCacheDir(): string {
  const env = process.env.HF_HUB_CACHE;
  if (env) {
    return path.resolve(expandUser(env));
  }
  return path.resolve(DEFAULT_CACHE_DIR);
}

/**
 * Parse a cache directory name like "models--owner--repo" into { type, id }.
 * Returns null if the name is not a valid HF cache directory.
 */
export function parseRepoDirName(name: string): { type: string; id: string } | null {
  const idx = name.indexOf("--");
  if (idx === -1) return null;
  const prefix = name.slice(0, idx);
  const rest = name.slice(idx + 2);
  // "models" -> "model", "datasets" -> "dataset", "spaces" -> "space"
  const repoType = prefix.slice(0, -1);
  if (!VALID_REPO_TYPES.has(repoType)) return null;
  const repoId = rest.split("--").join("/");
  return { type: repoType, id: repoId };
}

// Recursively collect file paths under dir (directories are descended into;
// everything that is not a directory is listed, mirroring the Python
// recursive glob plus is_dir() filtering). Read errors are ignored,
// like the Python try/except.
async function collectFiles(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, out);
    } else {
      out.push(full);
    }
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read the refs directory (e.g. refs/main -> commit_hash) into a
 * hash -> sorted-ref-names map. Unreadable files are skipped, matching the
 * Python OSError / UnicodeError catch.
 */
async function readRefs(refsPath: string): Promise<Map<string, string[]>> {
  const refsByHash = new Map<string, Set<string>>();
  if (!(await isDirectory(refsPath))) return new Map();
  const refFiles: string[] = [];
  await collectFiles(refsPath, refFiles);
  for (const refFile of refFiles) {
    if (FILES_TO_IGNORE.has(path.basename(refFile))) continue;
    const refName = path.relative(refsPath, refFile);
    let text: string;
    try {
      text = await readFile(refFile, "utf8");
    } catch {
      continue;
    }
    const commitHash = text.trim();
    let set = refsByHash.get(commitHash);
    if (set === undefined) {
      set = new Set<string>();
      refsByHash.set(commitHash, set);
    }
    set.add(refName);
  }
  const sorted = new Map<string, string[]>();
  for (const [hash, names] of refsByHash) {
    sorted.set(hash, [...names].sort());
  }
  return sorted;
}

/**
 * Collect the unique blobs a revision references: resolve each snapshot
 * file to its blob and record blob stats. Unresolvable files are skipped.
 */
async function collectRevisionBlobs(
  revisionPath: string,
  blobStats: Map<string, Stats>,
): Promise<Set<string>> {
  const cachedFiles = new Set<string>();
  const revFiles: string[] = [];
  await collectFiles(revisionPath, revFiles);
  for (const filePath of revFiles) {
    let blobPath: string;
    try {
      // HF snapshot files are symlinks into ../../blobs/
      blobPath = await realpath(filePath);
    } catch {
      continue;
    }
    if (!blobStats.has(blobPath)) {
      try {
        blobStats.set(blobPath, await stat(blobPath));
      } catch {
        continue;
      }
    }
    cachedFiles.add(blobPath);
  }
  return cachedFiles;
}

/**
 * A revision's size (unique blobs only) and last-modified time, falling
 * back to the revision directory's mtime when it has no blobs.
 */
async function revisionSizeAndMtime(
  cachedFiles: Set<string>,
  blobStats: Map<string, Stats>,
  revisionPath: string,
): Promise<{ size: number; mtime: number }> {
  let size = 0;
  let mtime = 0;
  for (const b of cachedFiles) {
    const s = blobStats.get(b);
    if (s === undefined) continue;
    size += s.size;
    const m = s.mtimeMs / 1000;
    if (m > mtime) mtime = m;
  }
  if (cachedFiles.size === 0) {
    try {
      mtime = (await stat(revisionPath)).mtimeMs / 1000;
    } catch {
      mtime = 0;
    }
  }
  return { size, mtime };
}

/**
 * Scan one snapshot (revision) directory and return the revision info.
 */
async function scanRevision(
  revisionPath: string,
  commitHash: string,
  refsByHash: Map<string, string[]>,
  blobStats: Map<string, Stats>,
): Promise<Revision> {
  const cachedFiles = await collectRevisionBlobs(revisionPath, blobStats);
  const { size, mtime } = await revisionSizeAndMtime(
    cachedFiles,
    blobStats,
    revisionPath,
  );
  return {
    commit_hash: commitHash,
    snapshot_path: revisionPath,
    size_on_disk: size,
    refs: refsByHash.get(commitHash) ?? [],
    nb_files: cachedFiles.size,
    last_modified: mtime,
  };
}

/**
 * Repo-level size and access/modification times from the blob stats, falling
 * back to the repo directory's own stats when there are no blobs.
 */
async function repoStats(
  blobStats: Map<string, Stats>,
  repoPath: string,
): Promise<{ size: number; lastAccessed: number; lastModified: number }> {
  let size = 0;
  let lastAccessed = 0;
  let lastModified = 0;
  if (blobStats.size > 0) {
    for (const s of blobStats.values()) {
      size += s.size;
      const atime = s.atimeMs / 1000;
      const mtime = s.mtimeMs / 1000;
      if (atime > lastAccessed) lastAccessed = atime;
      if (mtime > lastModified) lastModified = mtime;
    }
    return { size, lastAccessed, lastModified };
  }
  try {
    const s = await stat(repoPath);
    return { size: 0, lastAccessed: s.atimeMs / 1000, lastModified: s.mtimeMs / 1000 };
  } catch {
    return { size: 0, lastAccessed: 0, lastModified: 0 };
  }
}

/** Scan a single cached repo directory and return info, or null if invalid. */
export async function scanRepo(repoPath: string): Promise<RepoInfo | null> {
  if (!(await isDirectory(repoPath))) return null;

  const parsed = parseRepoDirName(path.basename(repoPath));
  if (parsed === null) return null;
  const { type: repoType, id: repoId } = parsed;

  const snapshotsPath = path.join(repoPath, "snapshots");
  if (!(await isDirectory(snapshotsPath))) return null;

  const refsByHash = await readRefs(path.join(repoPath, "refs"));

  // Walk snapshots
  const revisions: Revision[] = [];
  const blobStats = new Map<string, Stats>(); // blob_path -> stat

  let entries: Dirent[];
  try {
    entries = await readdir(snapshotsPath, { withFileTypes: true });
  } catch {
    entries = [];
  }
  // Deterministic revision order (Python's iterdir order is OS-dependent).
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (FILES_TO_IGNORE.has(entry.name)) continue;
    if (entry.isFile()) continue;
    const revisionPath = path.join(snapshotsPath, entry.name);
    revisions.push(
      await scanRevision(revisionPath, entry.name, refsByHash, blobStats),
    );
  }

  const stats = await repoStats(blobStats, repoPath);
  return {
    repo_id: repoId,
    repo_type: repoType,
    repo_path: repoPath,
    size_on_disk: stats.size,
    nb_files: blobStats.size,
    revisions,
    last_accessed: stats.lastAccessed,
    last_modified: stats.lastModified,
  };
}

/** Entry names to skip when listing the cache directory. */
const CACHE_DIR_IGNORE = new Set([".locks", "CACHEDIR.TAG"]);

/** List the repo directories inside a cache directory. */
async function listRepoDirs(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (CACHE_DIR_IGNORE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (await isDirectory(full)) dirs.push(full);
  }
  return dirs;
}

/** Scan the HF cache directory and return a list of repo info. */
export async function scanCacheDir(cacheDir?: string): Promise<RepoInfo[]> {
  const dirs = await listRepoDirs(cacheDir ?? getCacheDir());
  const repos: RepoInfo[] = [];
  for (const full of dirs) {
    const info = await scanRepo(full);
    if (info !== null) repos.push(info);
  }
  return repos;
}

/** Delete an entire cached repo directory. */
export async function deleteRepo(repoPath: string): Promise<void> {
  await rm(repoPath, { recursive: true, force: true });
}
