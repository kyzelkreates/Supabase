/**
 * zipController.js — ZIP Upload + Extraction Controller (RUN 7.2)
 *
 * Handles multipart ZIP uploads from the PWA.
 * Extracts to a sandboxed per-upload directory under agent/projects/.
 * Runs a safety scan before extraction (path traversal, file type, size).
 * Records upload metadata to the projects registry (agent/projects/registry.json).
 *
 * SSOT Rules:
 * ✔ All extraction in agent/projects/ — never in server/ or pwa/
 * ✔ Safety scan always runs before extraction (no bypass)
 * ✔ projectAnalyzer.js does the scanning — zipController owns I/O only
 * ✔ Returns structured { ok, projectId, projectPath, fileCount, summary }
 * ❌ Never calls RUN 0–7 execution modules
 * ❌ Never writes to ssot/ directly
 */

import fs            from "fs";
import path          from "path";
import StreamZip     from "node-stream-zip";
import { scanProject, summarizeProject } from "./projectAnalyzer.js";

const PROJECTS_DIR   = path.resolve("./agent/projects");
const REGISTRY_PATH  = path.resolve("./agent/projects/registry.json");
const MAX_FILES      = 2000;
const MAX_UNZIP_BYTES = 100 * 1024 * 1024; // 100 MB uncompressed

// ─── Upload Handler ───────────────────────────────────────────────────────────

/**
 * POST /upload-zip
 * multer puts the file at req.file.path
 */
export async function handleZipUpload(req, res) {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ ok: false, error: "No file uploaded — send multipart/form-data with field name 'zip'" });
  }

  const projectId   = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const projectPath = path.join(PROJECTS_DIR, projectId);

  try {
    // 1. Validate the ZIP before touching the filesystem
    const validation = await _validateZip(file.path);
    if (!validation.ok) {
      _cleanup(file.path);
      return res.status(422).json({ ok: false, error: validation.error });
    }

    // 2. Extract
    fs.mkdirSync(projectPath, { recursive: true });
    await _extractZip(file.path, projectPath, validation.entries);

    // 3. Scan extracted files
    const files   = scanProject(projectPath);
    const summary = summarizeProject(files, projectPath);

    // 4. Register
    const record = {
      projectId,
      projectPath,
      originalName:  file.originalname || "upload.zip",
      uploadedAt:    new Date().toISOString(),
      fileCount:     files.length,
      sizeBytes:     validation.totalUncompressedBytes,
      summary
    };
    _registerProject(record);

    // 5. Cleanup temp upload file
    _cleanup(file.path);

    console.log(`[zipController] Extracted ${files.length} files → ${projectPath}`);

    res.json({
      ok:          true,
      projectId,
      projectPath,
      fileCount:   files.length,
      summary,
      uploadedAt:  record.uploadedAt
    });

  } catch (err) {
    _cleanup(file.path);
    // Don't leave a half-extracted directory
    try { fs.rmSync(projectPath, { recursive: true, force: true }); } catch {}
    console.error("[zipController] Upload failed:", err.message);
    res.status(500).json({ ok: false, error: `Extraction failed: ${err.message}` });
  }
}

/**
 * POST /analyze
 * Analyze an already-extracted project (called after upload or standalone).
 */
export async function handleAnalyze(req, res) {
  const { projectPath, projectId } = req.body;

  if (!projectPath && !projectId) {
    return res.status(400).json({ ok: false, error: "Provide projectPath or projectId" });
  }

  const resolvedPath = projectId
    ? path.join(PROJECTS_DIR, projectId)
    : path.resolve(projectPath);

  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).json({ ok: false, error: `Project path not found: ${resolvedPath}` });
  }

  // Security: must be within PROJECTS_DIR
  if (!resolvedPath.startsWith(PROJECTS_DIR)) {
    return res.status(403).json({ ok: false, error: "Access denied — path outside projects directory" });
  }

  try {
    const files   = scanProject(resolvedPath);
    const summary = summarizeProject(files, resolvedPath);
    res.json({ ok: true, projectPath: resolvedPath, fileCount: files.length, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── ZIP Safety Validation ────────────────────────────────────────────────────

async function _validateZip(zipPath) {
  // Blocked extensions — executables and scripts that shouldn't be in a web project
  const BLOCKED_EXTS = new Set([".exe", ".dll", ".bat", ".cmd", ".sh", ".ps1", ".msi", ".app", ".hta", ".vbs"]);

  let zip;
  try {
    zip = new StreamZip.async({ file: zipPath });
  } catch (err) {
    return { ok: false, error: `Not a valid ZIP file: ${err.message}` };
  }

  try {
    const entries = await zip.entries();
    const entryList = Object.values(entries);

    if (entryList.length === 0) return { ok: false, error: "ZIP is empty" };
    if (entryList.length > MAX_FILES) return { ok: false, error: `ZIP contains too many files (${entryList.length} > ${MAX_FILES})` };

    let totalUncompressedBytes = 0;

    for (const entry of entryList) {
      // Path traversal guard
      const normalized = path.normalize(entry.name);
      if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
        return { ok: false, error: `Path traversal detected in ZIP entry: ${entry.name}` };
      }

      // Blocked extension check
      const ext = path.extname(entry.name).toLowerCase();
      if (BLOCKED_EXTS.has(ext)) {
        return { ok: false, error: `Blocked file type in ZIP: ${entry.name}` };
      }

      totalUncompressedBytes += entry.size || 0;
    }

    if (totalUncompressedBytes > MAX_UNZIP_BYTES) {
      return { ok: false, error: `ZIP uncompressed size too large (${Math.round(totalUncompressedBytes / 1024 / 1024)}MB > 100MB)` };
    }

    return { ok: true, entries: entryList, totalUncompressedBytes };
  } finally {
    await zip.close().catch(() => {});
  }
}

// ─── Extraction ───────────────────────────────────────────────────────────────

async function _extractZip(zipPath, targetDir, _entries) {
  const zip = new StreamZip.async({ file: zipPath });
  try {
    await zip.extract(null, targetDir);
  } finally {
    await zip.close().catch(() => {});
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

function _registerProject(record) {
  let registry = [];
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
    }
  } catch {}

  registry.unshift(record);
  if (registry.length > 50) registry.splice(50); // Keep last 50

  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf-8");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _cleanup(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}
