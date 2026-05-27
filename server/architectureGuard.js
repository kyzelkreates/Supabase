/**
 * architectureGuard.js — Architecture Guard Main Controller (RUN 7.1)
 *
 * The top-level entry point for wiring validation and repair.
 * Orchestrates wiringValidator → autoRepairEngine → wiringState.json.
 *
 * Can be run in two modes:
 *   "check"  — validate only, no modifications
 *   "repair" — validate then apply safe auto-fixes
 *
 * SSOT Rules:
 * ✔ SOLE writer of ssot/wiringState.json
 * ✔ Delegates analysis to wiringValidator.js
 * ✔ Delegates fixes to autoRepairEngine.js
 * ✔ Never modifies RUN 0–7 logic modules directly
 * ✔ Persists full audit result to SSOT after every run
 * ❌ Never bypasses RUN 4.1 gate (check is read-only, not an execution action)
 */

import fs   from "fs";
import path from "path";
import { validateWiring }                 from "./wiringValidator.js";
import { autoRepair }                     from "./autoRepairEngine.js";

const WIRING_STATE_PATH = path.resolve("./ssot/wiringState.json");

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Run a full wiring check (and optionally repair).
 *
 * @param {"check"|"repair"} [mode="check"]
 * @returns {ArchGuardResult}
 *
 * @typedef {object} ArchGuardResult
 * @property {"PASS"|"FIXED"|"FAIL"|"PARTIAL"} status
 * @property {boolean}      systemReady
 * @property {WiringReport} validation
 * @property {RepairReport} [repair]
 * @property {string}       summary
 * @property {string}       duration
 * @property {string}       timestamp
 */
export function runWiringCheck(mode = "check") {
  const startMs = Date.now();
  console.log(`\n[architectureGuard] ═══ WIRING CHECK (mode: ${mode}) ═══`);

  // 1. Validate
  const validation = validateWiring();

  // 2. Optionally repair
  let repair = null;
  if (mode === "repair" && !validation.systemReady) {
    const autoFixable = validation.findings.filter((f) => f.autoFixable);
    if (autoFixable.length > 0) {
      console.log(`[architectureGuard] Attempting repair on ${autoFixable.length} auto-fixable finding(s)…`);
      repair = autoRepair(autoFixable);
    } else {
      console.log("[architectureGuard] No auto-fixable issues — all require manual review");
      repair = { applied: [], skipped: validation.findings, anyApplied: false, summary: "No auto-fixable issues", timestamp: new Date().toISOString() };
    }
  }

  // 3. Determine final status
  let status;
  if (validation.systemReady) {
    status = "PASS";
  } else if (repair?.anyApplied) {
    // Re-validate after repair to confirm fixes worked
    const recheck = validateWiring();
    status = recheck.systemReady ? "FIXED" : "PARTIAL";
    // Use the post-repair validation for the final state
    Object.assign(validation, { postRepairFindings: recheck.findings, postRepairSummary: recheck.summary });
  } else {
    status = "FAIL";
  }

  const duration  = `${((Date.now() - startMs) / 1000).toFixed(2)}s`;
  const timestamp = new Date().toISOString();

  const result = {
    status,
    systemReady: status === "PASS" || status === "FIXED",
    validation,
    ...(repair ? { repair } : {}),
    summary:  `${status} — ${validation.summary}${repair ? ` | Repair: ${repair.summary}` : ""}`,
    duration,
    timestamp
  };

  // 4. Persist to SSOT
  _persistWiringState(result);

  console.log(`[architectureGuard] ═══ DONE: ${result.status} | ${result.summary} (${duration}) ═══\n`);
  return result;
}

/**
 * Run check-only (no repairs). Alias for runWiringCheck("check").
 */
export function checkWiring() {
  return runWiringCheck("check");
}

/**
 * Run check + repair. Alias for runWiringCheck("repair").
 */
export function repairWiring() {
  return runWiringCheck("repair");
}

/**
 * Read the last persisted wiring state without re-running validation.
 */
export function getLastWiringState() {
  try {
    return JSON.parse(fs.readFileSync(WIRING_STATE_PATH, "utf-8"));
  } catch {
    return { status: "unknown", systemReady: false, lastCheck: null };
  }
}

// ─── Persist ──────────────────────────────────────────────────────────────────

function _persistWiringState(result) {
  try {
    // Load existing to preserve history
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(WIRING_STATE_PATH, "utf-8")); } catch {}

    const history = existing.checkHistory || [];
    history.unshift({
      timestamp:  result.timestamp,
      status:     result.status,
      errorCount: result.validation.findings.filter((f) => f.severity === "ERROR").length,
      warnCount:  result.validation.findings.filter((f) => f.severity === "WARN").length,
      fixCount:   result.repair?.applied?.length || 0
    });
    if (history.length > 10) history.splice(10);

    const state = {
      status:              result.status,
      systemReady:         result.systemReady,
      lastCheck:           result.timestamp,
      duration:            result.duration,
      summary:             result.summary,

      // Findings breakdown
      brokenLinks:         result.validation.brokenLinks.map(_summarizeFinding),
      frontendViolations:  result.validation.frontendViolations.map(_summarizeFinding),
      backendViolations:   result.validation.backendViolations.map(_summarizeFinding),
      bypassDetected:      result.validation.bypassDetected,
      totalFindings:       result.validation.findings.length,
      errorCount:          result.validation.findings.filter((f) => f.severity === "ERROR").length,
      warnCount:           result.validation.findings.filter((f) => f.severity === "WARN").length,

      // Repair summary
      ...(result.repair ? {
        repairApplied: result.repair.applied.length,
        repairSkipped: result.repair.skipped.length,
        repairSummary: result.repair.summary
      } : {}),

      checkHistory: history
    };

    fs.writeFileSync(WIRING_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
    console.log("[architectureGuard] wiringState.json updated");
  } catch (err) {
    console.error(`[architectureGuard] Failed to persist wiring state: ${err.message}`);
  }
}

function _summarizeFinding(f) {
  return { id: f.id, severity: f.severity, file: f.file, message: f.message };
}
