/**
 * healController.js — Self-Heal Orchestrator (RUN 4)
 *
 * The main entry point for the auto-heal system.
 * Activated when installController.js reports a failed install.
 *
 * Repair loop:
 *   1. Load repair state (ssot/repairState.json)
 *   2. Check repair cap (maxRepairs)
 *   3. Run aiFixEngine fix cycle
 *   4. Validate result
 *   5. Persist state + return HealReport
 *
 * SSOT Rules:
 * ✔ Owns repairState.json (sole reader/writer)
 * ✔ Delegates all fix logic to aiFixEngine.js
 * ✔ Respects maxRepairs cap — never infinite loops
 * ✔ Emits structured HealReport every time
 * ❌ Never calls AI directly
 * ❌ Never writes SQL or migration files directly
 * ❌ Never modifies installState.json (RUN 3 owns that)
 */

import fs from "fs";
import path from "path";
import { fixAndRetry } from "./aiFixEngine.js";
import { validateSchema } from "./schemaValidator.js";

const REPAIR_STATE_PATH = path.resolve("./ssot/repairState.json");

// ─── Repair State Management ──────────────────────────────────────────────────

export function loadRepairState() {
  try {
    const raw = fs.readFileSync(REPAIR_STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      status: "idle",
      lastError: null,
      repairCount: 0,
      maxRepairs: 3,
      currentFixPrompt: null,
      repairHistory: []
    };
  }
}

export function saveRepairState(state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(REPAIR_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export function resetRepairState() {
  const fresh = {
    status: "idle",
    lastError: null,
    repairCount: 0,
    maxRepairs: 3,
    currentFixPrompt: null,
    repairHistory: [],
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(REPAIR_STATE_PATH, JSON.stringify(fresh, null, 2), "utf-8");
  return fresh;
}

// ─── Main Heal Entry Point ────────────────────────────────────────────────────

/**
 * Activate the self-heal loop for a failed project install.
 *
 * @param {HealRequest} request
 * @returns {Promise<HealReport>}
 *
 * @typedef {object} HealRequest
 * @property {string}   errorLog    - The error string from the failed install
 * @property {string}   sql         - The SQL that caused the failure
 * @property {object}   project     - { name: string, ref: string }
 * @property {boolean}  [force]     - Reset repair counter before starting
 *
 * @typedef {object} HealReport
 * @property {boolean}  healed          - True if schema is valid after repairs
 * @property {string}   project         - Project name
 * @property {number}   totalAttempts   - How many fix cycles ran
 * @property {object[]} history         - Per-attempt results
 * @property {object}   finalValidation - Schema validation result
 * @property {string}   [abortReason]   - Why healing stopped without success
 * @property {string}   duration        - Total elapsed time
 */
export async function handleFailure(request) {
  const { errorLog, sql, project, force = false } = request;
  const startTime = Date.now();

  console.log(`\n[healController] ═══ HEAL ACTIVATED: ${project.name} ═══`);

  // Load + optionally reset repair state
  const state = force ? resetRepairState() : loadRepairState();

  if (state.repairCount >= state.maxRepairs) {
    console.error(`[healController] ✘ Repair cap reached (${state.maxRepairs}). Aborting.`);
    return _buildReport({
      healed: false,
      project: project.name,
      history: state.repairHistory || [],
      finalValidation: validateSchema(),
      abortReason: `Repair cap of ${state.maxRepairs} reached. Manual intervention required.`,
      startTime
    });
  }

  // Mark healing active
  state.status = "healing";
  state.lastError = (errorLog || "").slice(0, 300);
  saveRepairState(state);

  const history = state.repairHistory || [];
  let currentSQL = sql;
  let currentError = errorLog;

  // ─── Repair Loop ───────────────────────────────────────────────────────────
  while (state.repairCount < state.maxRepairs) {
    const attempt = state.repairCount + 1;
    console.log(`\n[healController] Repair attempt ${attempt}/${state.maxRepairs}`);

    // Run one fix cycle
    const cycleResult = await fixAndRetry({
      errorLog: currentError,
      sql: currentSQL,
      projectName: project.name,
      attempt
    });

    const historyEntry = {
      attempt,
      timestamp: new Date().toISOString(),
      errorType: cycleResult.errorType,
      provider: cycleResult.provider,
      aiOk: cycleResult.aiOk,
      migrationFile: cycleResult.migrationFile,
      success: cycleResult.success,
      error: cycleResult.error || null
    };

    history.push(historyEntry);

    // Persist after each attempt
    state.repairCount = attempt;
    state.repairHistory = history;
    state.currentFixPrompt = null;
    state.lastError = cycleResult.error || null;
    saveRepairState(state);

    // Non-fixable error — stop immediately, don't waste retries
    if (!cycleResult.aiOk && !cycleResult.fixedSQL) {
      console.warn(`[healController] Non-fixable error type. Stopping repair loop.`);
      state.status = "failed";
      saveRepairState(state);
      return _buildReport({
        healed: false,
        project: project.name,
        history,
        finalValidation: validateSchema(),
        abortReason: cycleResult.error || "Non-fixable error — manual intervention required",
        startTime
      });
    }

    // Validate after fix
    const validation = validateSchema();
    console.log(`[healController] Post-fix validation: ${validation.valid ? "PASS ✔" : "FAIL ✘"}`);

    if (validation.valid) {
      state.status = "healed";
      saveRepairState(state);
      console.log(`[healController] ═══ HEAL SUCCESS after ${attempt} attempt(s) ═══\n`);
      return _buildReport({
        healed: true,
        project: project.name,
        history,
        finalValidation: validation,
        startTime
      });
    }

    // Carry forward the new error for the next cycle
    if (cycleResult.error) currentError = cycleResult.error;
    if (cycleResult.fixedSQL) currentSQL = cycleResult.fixedSQL;
  }

  // Exhausted all repair attempts
  state.status = "failed";
  saveRepairState(state);

  console.error(`[healController] ═══ HEAL FAILED after ${state.maxRepairs} attempts ═══\n`);

  return _buildReport({
    healed: false,
    project: project.name,
    history,
    finalValidation: validateSchema(),
    abortReason: `All ${state.maxRepairs} repair attempts exhausted without achieving a valid schema`,
    startTime
  });
}

// ─── Status Check ─────────────────────────────────────────────────────────────

/**
 * Check current heal state without triggering anything.
 */
export function getHealStatus() {
  return loadRepairState();
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _buildReport({ healed, project, history, finalValidation, abortReason, startTime }) {
  return {
    healed,
    project,
    totalAttempts: history.length,
    history,
    finalValidation,
    ...(abortReason ? { abortReason } : {}),
    duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
  };
}
