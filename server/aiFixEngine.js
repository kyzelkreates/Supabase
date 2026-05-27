/**
 * aiFixEngine.js — AI Fix + Re-run Engine (RUN 4)
 *
 * Orchestrates a single fix cycle:
 *   1. Classify error (errorAnalyzer)
 *   2. Generate fixed SQL (recoveryPlanner → aiRouter)
 *   3. Write fixed SQL as a new migration (migrationEngine)
 *   4. Re-run migrations
 *
 * Called by healController.js inside its repair loop.
 *
 * SSOT Rules:
 * ✔ Uses errorAnalyzer for classification
 * ✔ Uses recoveryPlanner for AI fix generation
 * ✔ Uses migrationEngine for file writes (never writes SQL directly)
 * ✔ Uses supabaseRunner via migrationEngine — never calls CLI directly
 * ❌ Never manages retry state (healController owns that)
 * ❌ Never calls AI directly (always via recoveryPlanner → aiRouter)
 */

import { analyzeError } from "./errorAnalyzer.js";
import { generateFix } from "./recoveryPlanner.js";
import { writeMigration, runMigrations } from "./migrationEngine.js";

// ─── Main Fix Cycle ───────────────────────────────────────────────────────────

/**
 * Execute one AI fix cycle for a failed migration.
 *
 * @param {object} failureContext
 * @param {string}  failureContext.errorLog    - Raw error string from the failed migration
 * @param {string}  failureContext.sql         - The SQL that failed
 * @param {string}  failureContext.projectName - Project name (used for migration folder)
 * @param {number}  [failureContext.attempt]   - Which repair attempt this is (for labelling)
 * @returns {Promise<FixCycleResult>}
 *
 * @typedef {object} FixCycleResult
 * @property {boolean} success       - Whether migrations ran cleanly after fix
 * @property {string}  errorType     - Classified error type
 * @property {string}  fixedSQL      - The SQL produced by AI
 * @property {string}  migrationFile - Path of the written migration file
 * @property {string}  provider      - AI provider that generated the fix
 * @property {boolean} aiOk          - Whether AI response was real (not fallback)
 * @property {object}  migrationResult - Raw result from runMigrations
 * @property {string}  [error]       - Error message if migrations still failed
 */
export async function fixAndRetry(failureContext) {
  const {
    errorLog,
    sql,
    projectName,
    attempt = 1
  } = failureContext;

  console.log(`\n[aiFixEngine] ── Fix Cycle ${attempt} for "${projectName}" ──`);

  // STEP 1 — Classify the error
  const errorReport = analyzeError(errorLog);
  console.log(`[aiFixEngine] Error classified: ${errorReport.type} (severity: ${errorReport.severity}, fixable: ${errorReport.fixable})`);

  if (!errorReport.fixable) {
    console.warn(`[aiFixEngine] Error type "${errorReport.type}" is not AI-fixable. Hint: ${errorReport.hint}`);
    return {
      success: false,
      errorType: errorReport.type,
      fixedSQL: "",
      migrationFile: "",
      provider: "none",
      aiOk: false,
      migrationResult: null,
      error: `Not fixable: ${errorReport.hint}`
    };
  }

  // STEP 2 — Generate fixed SQL via AI
  console.log(`[aiFixEngine] Requesting AI fix...`);
  const fixResult = await generateFix(errorReport, sql);
  console.log(`[aiFixEngine] Fix received from provider "${fixResult.provider}" (ok: ${fixResult.aiOk})`);

  if (!fixResult.ok || !fixResult.sql?.trim()) {
    console.warn(`[aiFixEngine] AI returned fallback or empty fix. Aborting fix cycle.`);
    return {
      success: false,
      errorType: errorReport.type,
      fixedSQL: fixResult.sql || "",
      migrationFile: "",
      provider: fixResult.provider,
      aiOk: false,
      migrationResult: null,
      error: "AI fix was empty or in fallback mode"
    };
  }

  // STEP 3 — Write fixed SQL as a new timestamped migration
  const description = `ai-fix-${errorReport.type.toLowerCase().replace(/_/g, "-")}-attempt-${attempt}`;
  let migrationFile = "";
  try {
    migrationFile = writeMigration(projectName, description, fixResult.sql);
    console.log(`[aiFixEngine] Migration written: ${migrationFile}`);
  } catch (writeErr) {
    return {
      success: false,
      errorType: errorReport.type,
      fixedSQL: fixResult.sql,
      migrationFile: "",
      provider: fixResult.provider,
      aiOk: fixResult.ok,
      migrationResult: null,
      error: `Failed to write migration file: ${writeErr.message}`
    };
  }

  // STEP 4 — Re-run migrations
  console.log(`[aiFixEngine] Re-running migrations for "${projectName}"...`);
  let migrationResult = null;
  let runError = null;
  try {
    migrationResult = runMigrations(projectName);
    console.log(`[aiFixEngine] ✔ Migrations ran: ${migrationResult.ran.length} files`);
  } catch (runErr) {
    runError = runErr.message;
    console.error(`[aiFixEngine] ✘ Migrations still failing after fix: ${runError}`);
  }

  return {
    success: runError === null,
    errorType: errorReport.type,
    fixedSQL: fixResult.sql,
    migrationFile,
    provider: fixResult.provider,
    aiOk: fixResult.ok,
    migrationResult,
    error: runError || null
  };
}
