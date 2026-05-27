/**
 * migrationEngine.js — Migration Execution Layer (RUN 3)
 *
 * Discovers, orders, and runs SQL migration files per project.
 * Maintains a migration log to prevent re-running completed migrations.
 *
 * SSOT Rules:
 * ✔ All SQL execution goes through supabaseRunner.js
 * ✔ Migration state is tracked in ssot/installState.json
 * ✔ Files are named <timestamp>_<description>.sql for deterministic ordering
 * ❌ Never generates SQL (AI tasks own that — RUN 2)
 * ❌ Never calls providers or vault directly
 */

import fs from "fs";
import path from "path";
import { executeSQLFile } from "./supabaseRunner.js";
import { loadInstallState, saveInstallState } from "./installController.js";

const MIGRATIONS_ROOT = path.resolve("./migrations");

// ─── Main Entry ──────────────────────────────────────────────────────────────

/**
 * Run all pending migrations for a given project.
 *
 * @param {string} projectName - Matches folder name under migrations/
 * @returns {{ ran: MigrationResult[], skipped: string[], failed: string | null }}
 */
export function runMigrations(projectName) {
  const folder = path.join(MIGRATIONS_ROOT, projectName);

  if (!fs.existsSync(folder)) {
    throw new Error(`[migrationEngine] No migration folder found for project: "${projectName}". Expected: ${folder}`);
  }

  const files = fs
    .readdirSync(folder)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // Lexicographic = timestamp-ordered

  if (files.length === 0) {
    console.warn(`[migrationEngine] No .sql files found in ${folder}`);
    return { ran: [], skipped: [], failed: null };
  }

  const state = loadInstallState();
  const alreadyRan = new Set(state.completedMigrations?.[projectName] || []);

  const ran = [];
  const skipped = [];

  for (const file of files) {
    if (alreadyRan.has(file)) {
      console.log(`[migrationEngine] ⏭  Skipping already-ran migration: ${file}`);
      skipped.push(file);
      continue;
    }

    const filePath = path.join(folder, file);
    console.log(`[migrationEngine] ▶  Running migration: ${file}`);

    const result = executeSQLFile(filePath);

    const entry = {
      file,
      success: result.success,
      timestamp: result.timestamp,
      error: result.error || null
    };

    ran.push(entry);

    if (!result.success) {
      console.error(`[migrationEngine] ✘ Migration failed: ${file} — ${result.error}`);
      // Persist progress before throwing
      _persistProgress(state, projectName, ran.filter((r) => r.success).map((r) => r.file), file);
      throw new Error(`Migration failed: ${file} — ${result.error}`);
    }

    console.log(`[migrationEngine] ✔ Migration complete: ${file}`);
  }

  // Persist all newly ran migrations
  _persistProgress(state, projectName, ran.map((r) => r.file), null);

  return { ran, skipped, failed: null };
}

// ─── Migration File Generator ─────────────────────────────────────────────────

/**
 * Write a new migration SQL file for a project.
 * Called by installController when AI generates schema SQL.
 *
 * @param {string} projectName
 * @param {string} description - Short kebab-case label, e.g. "create-users-table"
 * @param {string} sql         - Raw SQL content
 * @returns {string} Full path of created file
 */
export function writeMigration(projectName, description, sql) {
  const folder = path.join(MIGRATIONS_ROOT, projectName);
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${timestamp}_${description.replace(/\s+/g, "-").toLowerCase()}.sql`;
  const filePath = path.join(folder, filename);

  fs.writeFileSync(filePath, sql.trim() + "\n", "utf-8");
  console.log(`[migrationEngine] 📝 Migration file created: ${filePath}`);
  return filePath;
}

/**
 * List all migration files for a project (ran + pending).
 */
export function listMigrations(projectName) {
  const folder = path.join(MIGRATIONS_ROOT, projectName);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((f) => f.endsWith(".sql")).sort();
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _persistProgress(state, projectName, completedFiles, failedFile) {
  if (!state.completedMigrations) state.completedMigrations = {};
  const existing = new Set(state.completedMigrations[projectName] || []);
  for (const f of completedFiles) existing.add(f);
  state.completedMigrations[projectName] = [...existing];
  state.lastMigration = failedFile || completedFiles[completedFiles.length - 1] || state.lastMigration;
  saveInstallState(state);
}
