/**
 * projectRunner.js — Public Entry Point for Pipeline Execution (RUN 7)
 *
 * The single import that UI code and external callers use to run pipelines.
 * Validates inputs, resolves project credentials from the secure vault,
 * and passes a clean PipelineRequest to pipelineEngine.js.
 *
 * Also exposes convenience methods for partial runs (plan-only, dry-run).
 *
 * SSOT Rules:
 * ✔ Public API surface — all implementation in pipelineEngine / systemKernel
 * ✔ Credentials resolved from vaultWrapper (never plaintext in calls)
 * ✔ Input validation lives here — keeps pipelineEngine clean
 * ❌ Never calls RUN 0–6 modules directly
 * ❌ Never reads executionState.json (pipelineEngine owns that)
 */

import { runPipeline, getPipelineStatus, forceUnlockPipeline } from "./pipelineEngine.js";

// vaultWrapper is a PWA module — graceful fallback for server-only context
let _vault = null;
async function getVault() {
  if (_vault) return _vault;
  try {
    _vault = await import("../pwa/vaultWrapper.js");
  } catch {
    // Server context without PWA modules — use empty credential resolver
    _vault = { getSupabaseCredentials: async () => null, isUnlocked: () => true };
  }
  return _vault;
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Run a full end-to-end pipeline for a project.
 *
 * @param {RunProjectRequest} request
 * @returns {Promise<PipelineReport>}
 *
 * @typedef {object} RunProjectRequest
 * @property {string}  projectName     - Must match a project in the IndexedDB projects store
 * @property {string}  ref             - Supabase project ref (or resolved from vault)
 * @property {string}  [password]      - DB password (or resolved from vault)
 * @property {string}  prompt          - Natural language description of what to build
 * @property {object}  [expectations]  - { tables: string[], columns: {} }
 * @property {boolean} [dryRun]        - Plan + build only, skip install
 * @property {boolean} [skipValidation]
 * @property {string}  [mode]          - "manual" | "auto"
 */
export async function runProject(request) {
  const { projectName, prompt, ref, password, ...rest } = request;

  if (!projectName?.trim()) throw new Error("runProject: projectName is required");
  if (!prompt?.trim())      throw new Error("runProject: prompt is required");

  // Resolve credentials: caller-provided > vault > error
  let resolvedRef      = ref;
  let resolvedPassword = password;

  if (!resolvedRef) {
    const vault = await getVault();
    const creds = await vault.getSupabaseCredentials(projectName);
    if (creds?.ref) {
      resolvedRef      = creds.ref;
      resolvedPassword = resolvedPassword ?? creds.password;
    }
  }

  if (!resolvedRef) {
    throw new Error(
      `runProject: No Supabase ref for project "${projectName}". ` +
      `Provide ref directly or save credentials via vaultWrapper.saveSupabaseCredentials().`
    );
  }

  const project = { name: projectName, ref: resolvedRef, password: resolvedPassword ?? null };

  return runPipeline({ project, prompt, ...rest });
}

// ─── Convenience Wrappers ─────────────────────────────────────────────────────

/**
 * Dry-run only — plan + build SQL without installing.
 * Useful for previewing what the AI would generate.
 */
export async function planOnly(projectName, prompt) {
  return runProject({ projectName, prompt, ref: "_dry_run", dryRun: true, skipValidation: true });
}

/**
 * Re-run just the heal cycle on a known failed project.
 * Does not go through the full pipeline.
 */
export async function healProject(projectName, ref, errorLog, sql) {
  const { handleFailure } = await import("./healController.js");
  return handleFailure({ errorLog, sql: sql || "", project: { name: projectName, ref }, force: false });
}

// ─── Status Helpers ───────────────────────────────────────────────────────────

/**
 * Get current pipeline execution status.
 */
export function getStatus() {
  return getPipelineStatus();
}

/**
 * Force-unlock a stuck pipeline.
 */
export function forceUnlock() {
  return forceUnlockPipeline();
}

export { onStageEvent } from "./pipelineEngine.js";
