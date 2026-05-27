/**
 * projectAnalyzer.js — Project File Scanner + Summarizer (RUN 7.2)
 *
 * Scans an extracted project directory and builds a structured
 * representation of its contents for the SQL generator.
 *
 * Two outputs:
 *   scanProject()      → flat list of all file paths
 *   summarizeProject() → categorized summary with signal files
 *   readProjectContext() → file contents for AI prompt (size-bounded)
 *
 * SSOT Rules:
 * ✔ Pure I/O analysis — no AI calls, no SQL generation
 * ✔ Enforces hard limits on file reading (never reads > MAX_FILE_BYTES)
 * ✔ Returns structured data — zipController and sqlGenerator own usage
 * ❌ Never writes to any directory
 * ❌ Never calls RUN 0–7 modules
 */

import fs   from "fs";
import path from "path";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES   = 8_000;    // Max bytes read per file for AI context
const MAX_CONTEXT_FILES = 40;      // Max files included in AI prompt context
const MAX_WALK_DEPTH   = 12;       // Max directory depth during walk

// Files and directories to always skip during scanning
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "dist", "build", ".next", ".nuxt", "out",
  ".turbo", ".cache", ".yarn", "coverage", ".nyc_output"
]);

const SKIP_FILES = new Set([
  ".DS_Store", "Thumbs.db", ".gitignore", ".gitkeep",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"
]);

// Extension → category mapping
const EXT_CATEGORIES = {
  // Schema / data model signals (highest priority for SQL gen)
  ".prisma":  "schema",
  ".sql":     "schema",
  ".dbml":    "schema",
  // Config / environment
  ".env":     "config",    // contents redacted
  ".json":    "config",
  ".yaml":    "config",
  ".yml":     "config",
  ".toml":    "config",
  // Code
  ".ts":      "code",
  ".tsx":     "code",
  ".js":      "code",
  ".jsx":     "code",
  ".mjs":     "code",
  ".cjs":     "code",
  // Markup / UI
  ".html":    "markup",
  ".css":     "style",
  ".scss":    "style",
  ".sass":    "style",
  // Docs
  ".md":      "docs",
  ".txt":     "docs",
  // Binary / media — never read
  ".png":     "binary",
  ".jpg":     "binary",
  ".jpeg":    "binary",
  ".gif":     "binary",
  ".webp":    "binary",
  ".svg":     "binary",
  ".ico":     "binary",
  ".woff":    "binary",
  ".woff2":   "binary",
  ".ttf":     "binary",
  ".eot":     "binary",
  ".mp4":     "binary",
  ".mp3":     "binary",
  ".pdf":     "binary",
  ".zip":     "binary"
};

// Signal files that heavily indicate schema structure
const SCHEMA_SIGNAL_FILES = [
  "schema.prisma", "schema.sql", "schema.dbml",
  "supabase/migrations", "migrations/", "db/schema",
  "database/schema", "models/", "entities/", "types/index.ts",
  "types/database.ts", "types/supabase.ts", "lib/db", "lib/database",
  "src/db", "src/database"
];

// ─── Scan ─────────────────────────────────────────────────────────────────────

/**
 * Walk a directory and return all readable file paths.
 * Skips ignored dirs/files and enforces depth limit.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function scanProject(dir) {
  const files = [];
  _walk(dir, dir, 0, files);
  return files;
}

function _walk(rootDir, current, depth, files) {
  if (depth > MAX_WALK_DEPTH) return;
  if (!fs.existsSync(current)) return;

  let entries;
  try { entries = fs.readdirSync(current, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) _walk(rootDir, full, depth + 1, files);
    } else if (entry.isFile()) {
      if (!SKIP_FILES.has(entry.name)) files.push(full);
    }
  }
}

// ─── Summarize ────────────────────────────────────────────────────────────────

/**
 * Produce a categorized summary of the project.
 *
 * @param {string[]} files
 * @param {string}   rootDir
 * @returns {ProjectSummary}
 *
 * @typedef {object} ProjectSummary
 * @property {number}   totalFiles
 * @property {object}   byCategory      - { schema: n, code: n, config: n, … }
 * @property {string[]} schemaFiles     - Files with schema signals
 * @property {string[]} configFiles     - .env, package.json, tsconfig, etc.
 * @property {string[]} topLevelDirs    - First-level directories
 * @property {string[]} signalMatches   - Files matching SCHEMA_SIGNAL_FILES
 * @property {string}   projectType     - "nextjs"|"react"|"node"|"unknown"
 * @property {string[]} detectedORM     - e.g. ["prisma","drizzle"]
 */
export function summarizeProject(files, rootDir) {
  const relFiles = files.map((f) => path.relative(rootDir, f).replace(/\\/g, "/"));

  // Category counts
  const byCategory = {};
  for (const f of relFiles) {
    const ext = path.extname(f).toLowerCase();
    const cat = EXT_CATEGORIES[ext] || "other";
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }

  // Schema files
  const schemaFiles = relFiles.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return ext === ".prisma" || ext === ".sql" || ext === ".dbml";
  });

  // Config files (safe ones only)
  const configFiles = relFiles.filter((f) => {
    const base = path.basename(f);
    return ["package.json", "tsconfig.json", "tsconfig.base.json", "supabase.json", ".supabaserc"].includes(base);
  });

  // Top-level dirs
  const topLevelDirs = [...new Set(
    relFiles.map((f) => f.split("/")[0]).filter((p) => p && !p.includes("."))
  )];

  // Signal matches
  const signalMatches = relFiles.filter((f) =>
    SCHEMA_SIGNAL_FILES.some((sig) => f.toLowerCase().includes(sig.toLowerCase()))
  );

  // Project type detection
  const projectType = _detectProjectType(relFiles);

  // ORM detection
  const detectedORM = _detectORM(relFiles, rootDir);

  return {
    totalFiles: files.length,
    byCategory,
    schemaFiles,
    configFiles,
    topLevelDirs,
    signalMatches,
    projectType,
    detectedORM
  };
}

// ─── Context Builder (for AI prompt) ─────────────────────────────────────────

/**
 * Build an AI-ready context object from a project directory.
 * Prioritises schema files, then signal files, then code files.
 * Redacts .env values. Enforces file count and byte limits.
 *
 * @param {string}   rootDir
 * @param {string[]} files       - From scanProject()
 * @param {object}   [summary]   - From summarizeProject()
 * @returns {ProjectContext}
 *
 * @typedef {object} ProjectContext
 * @property {ContextFile[]} files
 * @property {number}        totalFiles
 * @property {number}        includedFiles
 * @property {number}        totalBytes
 * @property {string}        projectType
 * @property {string[]}      detectedORM
 *
 * @typedef {object} ContextFile
 * @property {string} file
 * @property {string} category
 * @property {string} content    - Truncated file content
 * @property {number} bytes
 * @property {boolean} truncated
 */
export function readProjectContext(rootDir, files, summary) {
  const BINARY_CATS = new Set(["binary"]);

  // Priority order: schema > signal files > code > config > docs
  const scored = files.map((f) => {
    const rel  = path.relative(rootDir, f).replace(/\\/g, "/");
    const ext  = path.extname(f).toLowerCase();
    const cat  = EXT_CATEGORIES[ext] || "other";
    let score  = 0;
    if (cat === "schema")  score = 100;
    else if (summary?.signalMatches?.includes(rel)) score = 80;
    else if (cat === "code")   score = 50;
    else if (cat === "config") score = 40;
    else if (cat === "docs")   score = 20;
    return { full: f, rel, cat, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const contextFiles = [];
  let totalBytes = 0;

  for (const { full, rel, cat } of scored) {
    if (contextFiles.length >= MAX_CONTEXT_FILES) break;
    if (BINARY_CATS.has(cat)) continue;

    let content  = "";
    let truncated = false;
    let bytes    = 0;

    try {
      const raw = fs.readFileSync(full, "utf-8");
      // Redact .env key values
      const safe = rel.includes(".env") ? _redactEnv(raw) : raw;
      if (safe.length > MAX_FILE_BYTES) {
        content   = safe.slice(0, MAX_FILE_BYTES);
        truncated = true;
      } else {
        content = safe;
      }
      bytes = content.length;
    } catch {
      content = "[unreadable]";
    }

    contextFiles.push({ file: rel, category: cat, content, bytes, truncated });
    totalBytes += bytes;
  }

  return {
    files:         contextFiles,
    totalFiles:    files.length,
    includedFiles: contextFiles.length,
    totalBytes,
    projectType:   summary?.projectType || "unknown",
    detectedORM:   summary?.detectedORM || []
  };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function _detectProjectType(relFiles) {
  const joined = relFiles.join(" ");
  if (joined.includes("next.config"))         return "nextjs";
  if (joined.includes("vite.config"))         return "vite";
  if (joined.includes("nuxt.config"))         return "nuxtjs";
  if (joined.includes("remix.config"))        return "remix";
  if (relFiles.some((f) => f.includes("src/app") && f.endsWith(".tsx"))) return "nextjs-app-router";
  if (joined.includes("react") && joined.includes("index.tsx")) return "react";
  if (relFiles.some((f) => f === "package.json")) return "node";
  return "unknown";
}

function _detectORM(relFiles, rootDir) {
  const orms = [];
  const joined = relFiles.join(" ").toLowerCase();

  if (joined.includes("schema.prisma") || joined.includes("@prisma/client")) orms.push("prisma");
  if (joined.includes("drizzle.config") || joined.includes("drizzle-orm"))   orms.push("drizzle");
  if (joined.includes("typeorm") || joined.includes("@typeorm"))             orms.push("typeorm");
  if (joined.includes("sequelize"))                                           orms.push("sequelize");
  if (joined.includes("knex"))                                               orms.push("knex");
  if (joined.includes("mikro-orm") || joined.includes("mikro_orm"))         orms.push("mikro-orm");

  // Check package.json for direct dependency evidence
  const pkgPath = path.join(rootDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      if (deps.includes("@supabase/supabase-js")) orms.push("supabase-js");
    } catch {}
  }

  return [...new Set(orms)];
}

function _redactEnv(content) {
  // Replace values after = with [REDACTED], preserve keys
  return content.replace(/^([A-Z_][A-Z0-9_]*)=.+$/gm, "$1=[REDACTED]");
}
