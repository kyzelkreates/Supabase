/**
 * preflight-check.js — PWA Preflight Gate (RUN 4.1)
 *
 * Runs the system gate check from the browser context.
 * Wires up client-side test functions (vault read, AI router dry-run)
 * and calls runPreflightGate with them.
 *
 * Called automatically before any RUN 5 dashboard action fires.
 *
 * SSOT Rules:
 * ✔ Client-side entry point only — no server logic here
 * ✔ Passes live test functions into the gate (never hardcodes results)
 * ✔ Returns structured PreflightResult for health-dashboard.js to render
 * ❌ Never calls AI directly (only provides a test fn to the gate)
 * ❌ Never writes to SSOT (server-side gate owns that)
 */

import { getAIKeys } from "./ai-vault.js";

// ─── Client-Side Test Functions ───────────────────────────────────────────────

/**
 * Vault read test: attempts to read from ai_keys store.
 * Returns the keys object (or empty {}) — truthy means vault is readable.
 */
async function vaultReadTest() {
  return getAIKeys(); // Returns {} if empty — still truthy (vault accessible)
}

/**
 * AI router dry-run test.
 * In PWA context we can't call the server-side router directly,
 * so we verify the routing SSOT JSON is fetchable as a static asset.
 */
async function aiRouterTest(task, _prompt) {
  try {
    const res = await fetch("../ssot/aiRouting.json");
    if (!res.ok) return null;
    const json = await res.json();
    return json.tasks?.[task] || null; // Returns provider name or null
  } catch {
    return null;
  }
}

// ─── Main Preflight Function ──────────────────────────────────────────────────

/**
 * Run the full client-side preflight check.
 * Calls the server-side gate via a dynamic import (works in module context).
 *
 * Falls back to a static SSOT file check if the server module isn't available
 * (e.g. purely static PWA deployment without a Node backend).
 *
 * @returns {Promise<PreflightResult>}
 *
 * @typedef {object} PreflightResult
 * @property {boolean}  systemReady
 * @property {boolean}  blockRun5
 * @property {string}   gate         - "OPEN" | "CLOSED" | "WARN"
 * @property {string}   status       - "READY" | "BLOCKED" | "DEGRADED"
 * @property {string[]} blockingIssues
 * @property {string[]} warnings
 * @property {object}   checks
 * @property {string}   source       - "server" | "ssot_static" | "error"
 * @property {string}   [error]
 */
export async function preflight() {
  // Try server-side gate first (Node/Deno context or bundled server)
  try {
    const { runPreflightGate } = await import("../server/runGateController.js");
    const result = await runPreflightGate(
      { aiRouterTest, vaultReadTest },
      { throwOnBlock: false } // Never throw in PWA — return result for UI to handle
    );
    return { ...result, source: "server" };
  } catch (serverImportErr) {
    // Server module not available in this environment — fall back to static check
    console.warn("[preflight-check] Server gate unavailable, falling back to static SSOT check:", serverImportErr.message);
  }

  // Static fallback: read last persisted systemState.json
  try {
    const res = await fetch("../ssot/systemState.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = await res.json();

    // Supplement with a live vault check
    let vaultOk = false;
    try {
      const keys = await vaultReadTest();
      vaultOk = keys !== null && keys !== undefined;
    } catch { /* vault unreadable */ }

    return {
      systemReady: state.systemReady && vaultOk,
      blockRun5: state.blockRun5 || !vaultOk,
      gate: (state.systemReady && vaultOk) ? (state.warnings?.length > 0 ? "WARN" : "OPEN") : "CLOSED",
      status: (state.systemReady && vaultOk) ? "READY" : "BLOCKED",
      blockingIssues: [
        ...(state.blockingIssues || []),
        ...(!vaultOk ? ["Vault: could not read ai_keys store in this browser session"] : [])
      ],
      warnings: state.warnings || [],
      checks: {
        run3_installer: state.run3_installer || "unknown",
        run4_healer:    state.run4_healer    || "unknown",
        ai_router:      state.ai_router      || "unknown",
        vault:          vaultOk ? "OK" : "FAIL"
      },
      lastCheck: state.lastCheck || null,
      source: "ssot_static"
    };
  } catch (staticErr) {
    return {
      systemReady: false,
      blockRun5: true,
      gate: "CLOSED",
      status: "BLOCKED",
      blockingIssues: [`Cannot reach system state: ${staticErr.message}`],
      warnings: [],
      checks: {
        run3_installer: "unknown",
        run4_healer:    "unknown",
        ai_router:      "unknown",
        vault:          "unknown"
      },
      lastCheck: null,
      source: "error",
      error: staticErr.message
    };
  }
}
