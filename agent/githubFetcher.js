/**
 * githubFetcher.js — GitHub Repository Ingestion (RUN 7.3)
 *
 * Fetches a GitHub repository's file tree and relevant file contents
 * via the GitHub REST API. No git clone required.
 *
 * Supports:
 *   - Public repos (no token needed)
 *   - Private repos (GITHUB_TOKEN env var)
 *   - Branch/tag/commit SHA selection
 *   - Recursive tree fetch with path filtering
 *
 * SSOT Rules:
 * ✔ Returns a NormalizedSource — projectNormalizer.js owns the merge
 * ✔ GITHUB_TOKEN loaded from process.env only (never vault directly)
 * ✔ Path filtering identical to projectAnalyzer.js SKIP_DIRS
 * ✔ Never clones or writes to disk — all in-memory
 * ❌ Never calls AI modules
 * ❌ Never writes SSOT files
 */

import path from "path";

const GITHUB_API    = "https://api.github.com";
const MAX_FILE_BYTES = 8_000;
const MAX_FILES      = 300;

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "out", ".turbo", ".cache", "coverage", ".nyc_output", ".yarn"
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mp3", ".pdf",
  ".zip", ".tar", ".gz", ".exe", ".dll"
]);

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Fetch a GitHub repo and return a NormalizedSource for projectNormalizer.
 *
 * @param {GitHubFetchRequest} request
 * @returns {Promise<GitHubFetchResult>}
 *
 * @typedef {object} GitHubFetchRequest
 * @property {string}  owner      - GitHub username or org
 * @property {string}  repo       - Repository name
 * @property {string}  [ref]      - Branch, tag, or commit SHA (default: default branch)
 * @property {string}  [token]    - Override GITHUB_TOKEN (optional)
 * @property {string[]} [include] - Only include these paths/extensions
 *
 * @typedef {object} GitHubFetchResult
 * @property {boolean}  ok
 * @property {string}   [repoFullName]
 * @property {string}   [defaultBranch]
 * @property {string}   [usedRef]
 * @property {SourceFile[]} [files]
 * @property {object}   [repoMeta]
 * @property {string}   [error]
 */
export async function fetchGitHubRepo(request) {
  const { owner, repo, ref, token, include } = request;
  const apiToken = token || process.env.GITHUB_TOKEN || "";
  const headers  = _headers(apiToken);

  try {
    // 1. Get repo metadata + default branch
    const repoRes = await _get(`${GITHUB_API}/repos/${owner}/${repo}`, headers);
    if (!repoRes.ok) {
      return { ok: false, error: repoRes.status === 404 ? `Repo ${owner}/${repo} not found or private (add GITHUB_TOKEN)` : `GitHub API error: ${repoRes.status}` };
    }
    const repoMeta    = await repoRes.json();
    const defaultBranch = repoMeta.default_branch || "main";
    const usedRef     = ref || defaultBranch;

    // 2. Fetch recursive file tree
    const treeRes = await _get(`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${usedRef}?recursive=1`, headers);
    if (!treeRes.ok) {
      return { ok: false, error: `Could not fetch tree for ${owner}/${repo}@${usedRef}: HTTP ${treeRes.status}` };
    }
    const treeData = await treeRes.json();

    if (treeData.truncated) {
      console.warn(`[githubFetcher] Tree truncated for ${owner}/${repo} — large repo, some files may be missing`);
    }

    // 3. Filter relevant files
    const blobs = (treeData.tree || []).filter((item) => {
      if (item.type !== "blob") return false;
      const parts = item.path.split("/");
      if (parts.some((p) => SKIP_DIRS.has(p))) return false;
      const ext = path.extname(item.path).toLowerCase();
      if (BINARY_EXTS.has(ext)) return false;
      if (include?.length && !include.some((pat) => item.path.includes(pat))) return false;
      return true;
    }).slice(0, MAX_FILES);

    // 4. Fetch file contents (parallel, capped at 10 concurrent)
    const files = await _fetchContents(blobs, owner, repo, usedRef, headers);

    console.log(`[githubFetcher] Fetched ${files.length} files from ${owner}/${repo}@${usedRef}`);

    return {
      ok:           true,
      repoFullName: `${owner}/${repo}`,
      defaultBranch,
      usedRef,
      repoMeta: {
        description: repoMeta.description,
        language:    repoMeta.language,
        topics:      repoMeta.topics,
        stars:       repoMeta.stargazers_count,
        updatedAt:   repoMeta.updated_at
      },
      files
    };

  } catch (err) {
    return { ok: false, error: `GitHub fetch failed: ${err.message}` };
  }
}

// ─── Content Fetcher ─────────────────────────────────────────────────────────

async function _fetchContents(blobs, owner, repo, ref, headers) {
  const CONCURRENCY = 10;
  const results = [];

  for (let i = 0; i < blobs.length; i += CONCURRENCY) {
    const batch = blobs.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((b) => _fetchBlob(b, owner, repo, ref, headers))
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) results.push(s.value);
    }
  }

  return results;
}

async function _fetchBlob(blob, owner, repo, ref, headers) {
  try {
    const res = await _get(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${blob.path}?ref=${ref}`,
      headers
    );
    if (!res.ok) return null;
    const data = await res.json();

    // GitHub returns base64 content
    let content = "";
    if (data.encoding === "base64" && data.content) {
      const raw = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
      content = raw.length > MAX_FILE_BYTES ? raw.slice(0, MAX_FILE_BYTES) : raw;
    }

    return {
      path:      blob.path,
      content,
      truncated: (data.size || 0) > MAX_FILE_BYTES,
      size:      data.size || 0
    };
  } catch { return null; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _headers(token) {
  const h = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

function _get(url, headers) {
  return fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
}
