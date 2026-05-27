/**
 * runGateController.js — RUN 5 Gate Controller (RUN 4.1)
 *
 * The hard gate that blocks RUN 5 UI actions until all system checks pass.
 * Writes results to ssot/systemState.json after every preflight run.
 *
 * The gate can be in three states:
 *   OPEN   — all checks passed, RUN 5 may proceed
 *   CLOSED — one or more blocking failures, RUN 5 is blocked
 *   WARN   — non-blocking issues present, RUN 5 allowed but flagged
 *
 * SSOT Rules:
 * ✔ SOLE writer of ssot/systemState.json
 * ✔ Delegates all checks to dependencyValidator.js
 * ✔ Throws on CLOSED gate so callers get a clear signal
 * ✔ Never modifies run0–4 state files
 * ❌ Never triggers installs, repairs, or AI tasks
 */

import fs from "fs";
import path from "path";
import { validateSystem } from "./dependencyValidator.js";

const SYSTEM_STATE_PATH = path.resolve("./ssot/systemState.json");

// ─── Gate States ──────────────────────────────────────────────────────────────

export const GATE = {
  OPEN:   "OPEN",
  CLOSED: "CLOSED",
  WARN:   "WARN"
};

// ─── Main Preflight Gate ──────────────────────────────────────────────────────

/**
 * Run the full preflight validation and update systemState.json.
 * Throws GateBlockedError if the system is not ready.
 *
 * @param {object} [deps] - Optional live test functions
 * @param {function|null} [deps.aiRouterTest]
 * @param {function|null} [deps.vaultReadTest]
 * @param {object} [opts]
 * @param {boolean} [opts.throwOnBlock=true] - If false, returns report instead of throwing
 * @returns {Promise<GateResult>}
 *
 * @typedef {object} GateResult
 * @property {"OPEN"|"CLOSED"|"WARN"}  gate
 * @property {"READY"|"BLOCKED"|"DEGRADED"} status
 * @property {boolean}   systemReady
 * @property {boolean}   blockRun5
 * @property {string[]}  blockingIssues
 * @property {string[]}  warnings
 * @property {object}    checks         - Per-system check statuses
 * @property {string}    lastCheck      - ISO timestamp
 * @property {string}    [blockedReason] - Why gate is closed (if applicable)
 */
export async function runPreflightGate(deps = {}, opts = {}) {
  const { throwOnBlock = true } = opts;

  console.log("[runGateController] Running preflight gate...");
  const startTime = Date.now();

  // Run full dependency validation
  const report = await validateSystem(deps);

  // Determine gate state
  let gate = GATE.OPEN;
  let status = "READY";

  if (!report.systemReady) {
    gate = GATE.CLOSED;
    status = "BLOCKED";
  } else if (report.warnings.length > 0) {
    gate = GATE.WARN;
    status = "DEGRADED";
  }

  const gateResult = {
    gate,
    status,
    systemReady: report.systemReady,
    blockRun5: !report.systemReady,
    blockingIssues: report.blockingIssues,
    warnings: report.warnings,
    checks: {
      run3_installer: report.run3_installer,
      run4_healer:    report.run4_healer,
      ai_router:      report.ai_router,
      vault:          report.vault
    },
    lastCheck: report.timestamp,
    duration: `${Date.now() - startTime}ms`,
    ...(gate === GATE.CLOSED ? { blockedReason: report.blockingIssues.join(" | ") } : {})
  };

  // Always persist to SSOT — even on failure (so UI can display last check)
  _persistSystemState(gateResult, report);

  console.log(`[runGateController] Gate: ${gate} | Status: ${status} | Duration: ${gateResult.duration}`);

  // Throw on blocked gate (default behaviour — lets callers fail fast)
  if (gate === GATE.CLOSED && throwOnBlock) {
    throw new GateBlockedError(gateResult);
  }

  return gateResult;
}

/**
 * Read the last persisted gate result without re-running checks.
 * Safe to call from UI on page load for cached status display.
 *
 * @returns {object} Last systemState.json contents
 */
export function getLastGateResult() {
  try {
    const raw = fs.readFileSync(SYSTEM_STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      gate: GATE.CLOSED,
      status: "UNKNOWN",
      systemReady: false,
      blockRun5: true,
      lastCheck: null,
      message: "systemState.json not found or unreadable"
    };
  }
}

/**
 * Check if RUN 5 is currently gated (from last persisted state).
 * Fast synchronous check — does NOT re-run validation.
 */
export function isRun5Blocked() {
  const state = getLastGateResult();
  return state.blockRun5 !== false;
}

// ─── Custom Error ─────────────────────────────────────────────────────────────

export class GateBlockedError extends Error {
  constructor(gateResult) {
    super(`SYSTEM NOT READY — RUN 5 BLOCKED\n${gateResult.blockingIssues.join("\n")}`);
    this.name = "GateBlockedError";
    this.gateResult = gateResult;
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _persistSystemState(gateResult, report) {
  try {
    // Read existing state to preserve checkHistory
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(SYSTEM_STATE_PATH, "utf-8"));
    } catch { /* fresh write */ }

    const history = existing.checkHistory || [];
    // Keep last 10 check summaries
    history.push({
      timestamp: gateResult.lastCheck,
      gate: gateResult.gate,
      status: gateResult.status,
      blockingCount: gateResult.blockingIssues.length,
      warningCount: gateResult.warnings.length
    });
    if (history.length > 10) history.splice(0, history.length - 10);

    const state = {
      run3_installer: report.run3_installer,
      run4_healer:    report.run4_healer,
      ai_router:      report.ai_router,
      vault:          report.vault,
      gate:           gateResult.gate,
      status:         gateResult.status,
      systemReady:    gateResult.systemReady,
      blockRun5:      gateResult.blockRun5,
      blockingIssues: gateResult.blockingIssues,
      warnings:       gateResult.warnings,
      lastCheck:      gateResult.lastCheck,
      checkHistory:   history
    };

    fs.writeFileSync(SYSTEM_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
    console.log(`[runGateController] systemState.json updated`);
  } catch (err) {
    // State persistence failure must never crash the gate check itself
    console.error(`[runGateController] Failed to write systemState.json: ${err.message}`);
  }
}
