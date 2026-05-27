/**
 * projectClient.js — Project API Client (RUN 7.2)
 *
 * High-level client for all project-related agent operations.
 * Used by orchestrationPanel, installPanel, and zipUploader flows.
 *
 * Wraps apiBridge calls with typed, named methods so panels never
 * deal with raw endpoint strings or JSON shapes.
 *
 * SSOT Rules:
 * ✔ All calls go through apiBridge.js — never raw fetch
 * ✔ Returns typed results — no raw response objects exposed
 * ✔ Combines ZIP upload + analyze + SQL gen into pipeline convenience methods
 * ❌ Never calls server/ modules directly
 * ❌ Never reads/writes SSOT files
 */

import { sendToAgent, getFromAgent, checkAgentStatus, uploadZipToAgent } from "./apiBridge.js";
import { uploadZip } from "./zipUploader.js";

// ─── Agent Status ─────────────────────────────────────────────────────────────

/**
 * Get the live status of the local agent.
 */
export async function getAgentHealth() {
  return checkAgentStatus(true); // force = no cache
}

// ─── ZIP → SQL Pipeline ───────────────────────────────────────────────────────

/**
 * Full ZIP → Analyze → SQL pipeline in one call.
 *
 * @param {File}     zipFile
 * @param {object}   [options]
 * @param {boolean}  [options.useAI=true]
 * @param {string}   [options.projectName]
 * @param {function} [options.onProgress]  - (phase, pct) => void
 * @returns {Promise<ZipToSQLResult>}
 *
 * @typedef {object} ZipToSQLResult
 * @property {boolean} ok
 * @property {string}  [projectId]
 * @property {string}  [projectPath]
 * @property {object}  [analysis]
 * @property {string}  [sql]
 * @property {boolean} [sqlIsStub]
 * @property {string}  [provider]
 * @property {string}  [error]
 */
export async function uploadAndGenerateSQL(zipFile, options = {}) {
  const { useAI = true, projectName, onProgress } = options;
  const progress = (phase, pct) => { if (onProgress) onProgress(phase, pct); };

  // 1. Upload + extract ZIP
  progress("uploading", 0);
  const upload = await uploadZip(zipFile, (phase, pct) => progress(`upload_${phase}`, pct * 0.5));

  if (!upload.ok) return { ok: false, error: upload.error };
  progress("uploading", 50);

  // 2. Generate SQL
  progress("generating", 50);
  const sqlRes = await sendToAgent("generate-sql", {
    projectPath: upload.projectPath,
    projectName: projectName || upload.projectId,
    useAI
  });
  progress("generating", 100);

  if (!sqlRes.ok) {
    return {
      ok:         false,
      projectId:  upload.projectId,
      projectPath: upload.projectPath,
      analysis:   upload.summary,
      error:      sqlRes.error
    };
  }

  return {
    ok:          true,
    projectId:   upload.projectId,
    projectPath: upload.projectPath,
    analysis:    sqlRes.data?.analysis || upload.summary,
    sql:         sqlRes.data?.sql || "",
    sqlIsStub:   sqlRes.data?.isStub ?? true,
    provider:    sqlRes.data?.provider || "unknown",
    duration:    sqlRes.data?.duration
  };
}

// ─── SQL Generation (from existing extracted project) ────────────────────────

/**
 * Generate SQL from an already-extracted project.
 *
 * @param {string}  projectPath
 * @param {string}  [projectName]
 * @param {boolean} [useAI=true]
 * @returns {Promise<{ok, sql, analysis, provider, isStub, error}>}
 */
export async function generateSQL(projectPath, projectName, useAI = true) {
  const res = await sendToAgent("generate-sql", { projectPath, projectName, useAI });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, ...res.data };
}

// ─── Full Pipeline (AI → Install) ─────────────────────────────────────────────

/**
 * Trigger the full RUN 7 pipeline via the agent.
 *
 * @param {object} params
 * @param {string} params.projectName
 * @param {string} params.ref           - Supabase project ref
 * @param {string} [params.password]
 * @param {string} params.prompt
 * @param {boolean} [params.dryRun]
 * @param {boolean} [params.skipValidation]
 * @returns {Promise<{ok, pipelineId, status, stages, formattedTrace, generatedSQL, error}>}
 */
export async function runPipeline(params) {
  const res = await sendToAgent("run-pipeline", params, { timeout: 300_000 }); // 5 min timeout
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: res.data?.success ?? false, ...res.data };
}

// ─── Wiring Check ─────────────────────────────────────────────────────────────

/**
 * Trigger a wiring check (or repair) on the agent.
 *
 * @param {"check"|"repair"} [mode="check"]
 */
export async function getWiringReport(mode = "check") {
  const res = await getFromAgent("wiring", { mode });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, ...res.data };
}

// ─── Project Registry ─────────────────────────────────────────────────────────

/**
 * List all extracted projects from the agent's registry.
 * The agent doesn't have a dedicated endpoint for this yet (RUN 7.3 will add it),
 * so we use the status endpoint and fall back gracefully.
 */
export async function listProjects() {
  // Placeholder — RUN 7.3 will expose a /projects endpoint
  return { ok: true, projects: [], note: "Project listing available in RUN 7.3" };
}
