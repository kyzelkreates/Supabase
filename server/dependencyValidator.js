/**
 * dependencyValidator.js — Dependency Validation Layer (RUN 4.1)
 *
 * Aggregates all system health checks into a single validation report.
 * Determines overall systemReady status from individual check results.
 *
 * SSOT Rules:
 * ✔ Pure aggregator — only calls systemHealthCheck.js functions
 * ✔ Returns structured SystemValidationReport — never throws
 * ✔ Defines "ready" logic in ONE place (here, not in the gate)
 * ❌ Never writes state (runGateController owns that)
 * ❌ Never triggers installs, repairs, or AI tasks
 */

import {
  checkRun3,
  checkRun4,
  checkAIRouter,
  checkVault,
  STATUS
} from "./systemHealthCheck.js";

// ─── What counts as "system ready" ───────────────────────────────────────────
// WARN is treated as non-blocking for run3/run4 (system degraded but can proceed)
// FAIL is always blocking
// AI router WARN is blocking (can't route without valid SSOT)
// Vault FAIL is blocking; WARN is non-blocking (local fallback possible)

const BLOCKING_RULES = {
  run3:       [STATUS.FAIL],            // WARN = degraded but allowed
  run4:       [STATUS.FAIL],            // WARN = repair needed but not blocking
  ai_router:  [STATUS.FAIL, STATUS.WARN], // Router must be fully OK
  vault:      [STATUS.FAIL]             // WARN = might work; FAIL = blocked
};

// ─── Main Validator ───────────────────────────────────────────────────────────

/**
 * Run all dependency checks and return an aggregated validation report.
 *
 * @param {object} [deps]
 * @param {function|null} [deps.aiRouterTest]  - Optional live AI router test fn
 * @param {function|null} [deps.vaultReadTest] - Optional live vault read fn
 * @returns {Promise<SystemValidationReport>}
 *
 * @typedef {object} SystemValidationReport
 * @property {string}  run3_installer  - "OK" | "FAIL" | "WARN"
 * @property {string}  run4_healer     - "OK" | "FAIL" | "WARN"
 * @property {string}  ai_router       - "OK" | "FAIL" | "WARN"
 * @property {string}  vault           - "OK" | "FAIL" | "WARN"
 * @property {boolean} systemReady     - True only if no blocking failures
 * @property {string[]} blockingIssues - Human-readable reasons for blocks
 * @property {string[]} warnings       - Non-blocking issues to surface in UI
 * @property {object}  rawChecks       - Full per-check detail objects
 * @property {string}  timestamp       - ISO timestamp of this check
 */
export async function validateSystem(deps = {}) {
  const { aiRouterTest = null, vaultReadTest = null } = deps;

  console.log("[dependencyValidator] Running full system validation...");

  // Run all checks in parallel for speed
  const [run3Result, run4Result, aiResult, vaultResult] = await Promise.all([
    checkRun3(),
    checkRun4(),
    checkAIRouter(aiRouterTest),
    checkVault(vaultReadTest)
  ]);

  const statusMap = {
    run3_installer: run3Result.status,
    run4_healer:    run4Result.status,
    ai_router:      aiResult.status,
    vault:          vaultResult.status
  };

  const rawChecks = {
    run3:       run3Result,
    run4:       run4Result,
    ai_router:  aiResult,
    vault:      vaultResult
  };

  // Determine blocking issues
  const blockingIssues = [];
  const warnings = [];

  for (const [key, status] of Object.entries(statusMap)) {
    const blocking = BLOCKING_RULES[key] || [STATUS.FAIL];
    if (blocking.includes(status)) {
      blockingIssues.push(`[${key.toUpperCase()}] ${rawChecks[key.replace("_installer","").replace("_healer","").replace("_router","").replace("run3","run3").replace("run4","run4")?.detail || rawChecks.run3.detail}`);
    } else if (status === STATUS.WARN) {
      warnings.push(`[${key.toUpperCase()}] ${_getDetail(rawChecks, key)}`);
    }
  }

  // Build cleaner blocking messages
  const cleanBlocking = [
    ...(BLOCKING_RULES.run3.includes(statusMap.run3_installer) ? [`RUN 3 (Installer): ${run3Result.detail}`] : []),
    ...(BLOCKING_RULES.run4.includes(statusMap.run4_healer)    ? [`RUN 4 (Healer): ${run4Result.detail}`]    : []),
    ...(BLOCKING_RULES.ai_router.includes(statusMap.ai_router) ? [`AI Router: ${aiResult.detail}`]           : []),
    ...(BLOCKING_RULES.vault.includes(statusMap.vault)         ? [`Vault: ${vaultResult.detail}`]            : [])
  ];

  const cleanWarnings = [
    ...(!BLOCKING_RULES.run3.includes(statusMap.run3_installer) && statusMap.run3_installer === STATUS.WARN ? [`RUN 3: ${run3Result.detail}`] : []),
    ...(!BLOCKING_RULES.run4.includes(statusMap.run4_healer)    && statusMap.run4_healer === STATUS.WARN    ? [`RUN 4: ${run4Result.detail}`] : []),
    ...(!BLOCKING_RULES.vault.includes(statusMap.vault)         && statusMap.vault === STATUS.WARN          ? [`Vault: ${vaultResult.detail}`] : [])
  ];

  const systemReady = cleanBlocking.length === 0;

  console.log(`[dependencyValidator] System ready: ${systemReady}. Blocking issues: ${cleanBlocking.length}. Warnings: ${cleanWarnings.length}.`);

  return {
    ...statusMap,
    systemReady,
    blockingIssues: cleanBlocking,
    warnings: cleanWarnings,
    rawChecks,
    timestamp: new Date().toISOString()
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _getDetail(rawChecks, key) {
  const map = { run3_installer: "run3", run4_healer: "run4", ai_router: "ai_router", vault: "vault" };
  const checkKey = map[key] || key;
  return rawChecks[checkKey]?.detail || "";
}
