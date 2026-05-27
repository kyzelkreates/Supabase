/**
 * supabaseAdapter.js — Supabase Deployment Adapter (RUN 7.3)
 *
 * Takes compiled SQL from schemaCompilerAI and optionally deploys it
 * to a Supabase project via the RUN 3 install pipeline.
 *
 * Two modes:
 *   "save"   — write migration file only (no install)
 *   "deploy" — write file + trigger RUN 3 installProject()
 *
 * SSOT Rules:
 * ✔ Deployment always goes through RUN 3 installController (never raw CLI)
 * ✔ Migration file written via RUN 3 migrationEngine (never raw fs)
 * ✔ Returns AdapterResult — never throws to caller
 * ✔ "deploy" mode requires explicit trigger (never auto-deploys)
 * ❌ Never calls RUN 7 orchestrator (adapter is not an orchestrator)
 */

import path from "path";

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * @param {SupabaseAdapterRequest} request
 * @returns {Promise<AdapterResult>}
 *
 * @typedef {object} SupabaseAdapterRequest
 * @property {string} sql             - Compiled SQL from schemaCompilerAI
 * @property {string} projectName
 * @property {string} [ref]           - Supabase project ref (required for deploy)
 * @property {string} [password]      - DB password (required for deploy)
 * @property {"save"|"deploy"} [mode] - Default: "save"
 *
 * @typedef {object} AdapterResult
 * @property {boolean} ok
 * @property {string}  mode
 * @property {string}  [migrationFile]
 * @property {string}  [installStatus]
 * @property {string}  [error]
 */
export async function runSupabaseAdapter(request) {
  const { sql, projectName, ref, password, mode = "save" } = request;
  if (!sql?.trim())      return { ok: false, mode, error: "No SQL provided" };
  if (!projectName)      return { ok: false, mode, error: "projectName required" };

  try {
    // 1. Write migration via RUN 3 migrationEngine
    const { writeMigration } = await import("../../server/migrationEngine.js");
    const migrationFile = writeMigration(projectName, "ai-compiled-schema", sql);

    if (mode === "save") {
      console.log(`[supabaseAdapter] Migration saved: ${migrationFile}`);
      return { ok: true, mode: "save", migrationFile };
    }

    // 2. Deploy via RUN 3 installController
    if (!ref) return { ok: false, mode, error: "Supabase project ref required for deploy mode" };

    const { installProject } = await import("../../server/installController.js");
    const installResult = await installProject({ name: projectName, ref, password });

    return {
      ok:            installResult.success,
      mode:          "deploy",
      migrationFile,
      installStatus: installResult.success ? "installed" : "failed",
      error:         installResult.error
    };

  } catch (err) {
    return { ok: false, mode, error: err.message };
  }
}
