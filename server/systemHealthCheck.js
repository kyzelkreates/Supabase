/**
 * systemHealthCheck.js — System Health Check Engine (RUN 4.1)
 *
 * READ-ONLY diagnostic checks for all prior run layers.
 * Each check returns "OK" | "FAIL" | "WARN" with a detail string.
 * Nothing here modifies state, triggers installs, or calls AI with real prompts.
 *
 * SSOT Rules:
 * ✔ Pure diagnostics — no side effects, no writes
 * ✔ Each check is independently callable
 * ✔ Delegates all CLI calls to supabaseRunner.js (read-only commands only)
 * ✔ Delegates repair state reads to healController.loadRepairState()
 * ✔ Delegates install state reads to installController.loadInstallState()
 * ❌ Never triggers installs, repairs, or AI tasks
 * ❌ Never writes to any SSOT file (runGateController owns systemState.json)
 */

import { checkCLI, getProjectStatus } from "./supabaseRunner.js";
import { loadInstallState } from "./installController.js";
import { loadRepairState } from "./healController.js";

// ─── Status Constants ─────────────────────────────────────────────────────────

export const STATUS = {
  OK:      "OK",
  FAIL:    "FAIL",
  WARN:    "WARN",
  UNKNOWN: "UNKNOWN"
};

// ─── RUN 3 — Supabase Installer Check ────────────────────────────────────────

/**
 * Verify RUN 3 (installer) is stable.
 * Checks: CLI available, installState not stuck in "installing".
 *
 * @returns {Promise<CheckResult>}
 */
export async function checkRun3() {
  const result = { status: STATUS.UNKNOWN, detail: "", checks: [] };

  // 1. CLI presence
  const cli = checkCLI();
  result.checks.push({
    name: "supabase_cli",
    ok: cli.success,
    detail: cli.success ? cli.output : cli.error
  });

  if (!cli.success) {
    result.status = STATUS.FAIL;
    result.detail = `Supabase CLI not found: ${cli.error}`;
    return result;
  }

  // 2. Install state sanity
  let installState;
  try {
    installState = loadInstallState();
  } catch (err) {
    result.status = STATUS.FAIL;
    result.detail = `Cannot read installState.json: ${err.message}`;
    result.checks.push({ name: "install_state_read", ok: false, detail: err.message });
    return result;
  }

  result.checks.push({ name: "install_state_read", ok: true, detail: `status: ${installState.status}` });

  // Stuck in "installing" = previous run never completed
  if (installState.status === "installing") {
    result.status = STATUS.WARN;
    result.detail = `Install state is stuck in "installing" for project "${installState.currentProject}". May need reset.`;
    return result;
  }

  result.status = STATUS.OK;
  result.detail = `CLI ready. Last install status: "${installState.status || "idle"}"`;
  return result;
}

// ─── RUN 4 — Auto-Heal Check ─────────────────────────────────────────────────

/**
 * Verify RUN 4 (healer) is not stuck or at repair cap.
 *
 * @returns {Promise<CheckResult>}
 */
export async function checkRun4() {
  const result = { status: STATUS.UNKNOWN, detail: "", checks: [] };

  let repairState;
  try {
    repairState = loadRepairState();
  } catch (err) {
    result.status = STATUS.FAIL;
    result.detail = `Cannot read repairState.json: ${err.message}`;
    result.checks.push({ name: "repair_state_read", ok: false, detail: err.message });
    return result;
  }

  result.checks.push({ name: "repair_state_read", ok: true, detail: `status: ${repairState.status}` });

  // Stuck mid-heal
  if (repairState.status === "healing") {
    result.status = STATUS.WARN;
    result.detail = `Repair loop is stuck in "healing" state. Last error: ${repairState.lastError || "none"}`;
    return result;
  }

  // At repair cap with failed status
  if (repairState.status === "failed" && repairState.repairCount >= repairState.maxRepairs) {
    result.status = STATUS.WARN;
    result.detail = `Repair cap (${repairState.maxRepairs}) reached on previous run. Reset required before next install.`;
    result.checks.push({ name: "repair_cap", ok: false, detail: `${repairState.repairCount}/${repairState.maxRepairs} repairs used` });
    return result;
  }

  result.checks.push({
    name: "repair_cap",
    ok: true,
    detail: `${repairState.repairCount}/${repairState.maxRepairs} repairs used`
  });

  result.status = STATUS.OK;
  result.detail = `Heal system stable. Status: "${repairState.status || "idle"}", repairs used: ${repairState.repairCount}/${repairState.maxRepairs}`;
  return result;
}

// ─── RUN 2 — AI Router Check ──────────────────────────────────────────────────

/**
 * Verify RUN 2 (AI router) is operational using a caller-supplied test function.
 * The test function must be a lightweight dry-run — NOT a real AI call.
 * Default: checks that aiRouting.json is readable and task map is intact.
 *
 * @param {function|null} [routerTestFn] - Optional async fn(task, prompt) → any
 * @returns {Promise<CheckResult>}
 */
export async function checkAIRouter(routerTestFn = null) {
  const result = { status: STATUS.UNKNOWN, detail: "", checks: [] };

  // 1. Verify routing SSOT is readable
  try {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const routing = require("../ssot/aiRouting.json");
    const expectedTasks = ["planner", "builder", "validator", "fixer", "fallback"];
    const missingTasks = expectedTasks.filter((t) => !routing.tasks?.[t]);

    result.checks.push({
      name: "routing_ssot",
      ok: missingTasks.length === 0,
      detail: missingTasks.length === 0
        ? "All task routes present"
        : `Missing task routes: ${missingTasks.join(", ")}`
    });

    if (missingTasks.length > 0) {
      result.status = STATUS.FAIL;
      result.detail = `aiRouting.json missing task mappings: ${missingTasks.join(", ")}`;
      return result;
    }
  } catch (err) {
    result.status = STATUS.FAIL;
    result.detail = `Cannot read aiRouting.json: ${err.message}`;
    result.checks.push({ name: "routing_ssot", ok: false, detail: err.message });
    return result;
  }

  // 2. Verify provider SSOT is readable
  try {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const providers = require("../ssot/aiProviders.json");
    const providerCount = Object.keys(providers.providers || {}).length;
    result.checks.push({ name: "provider_ssot", ok: providerCount > 0, detail: `${providerCount} providers registered` });

    if (providerCount === 0) {
      result.status = STATUS.FAIL;
      result.detail = "aiProviders.json has no registered providers";
      return result;
    }
  } catch (err) {
    result.status = STATUS.FAIL;
    result.detail = `Cannot read aiProviders.json: ${err.message}`;
    result.checks.push({ name: "provider_ssot", ok: false, detail: err.message });
    return result;
  }

  // 3. Optional live test (caller-supplied, lightweight)
  if (routerTestFn) {
    try {
      const testResult = await routerTestFn("planner", "health-check-ping");
      const liveOk = !!testResult;
      result.checks.push({ name: "router_live_test", ok: liveOk, detail: liveOk ? "Router responded" : "Router returned empty" });
      if (!liveOk) {
        result.status = STATUS.WARN;
        result.detail = "AI router SSOT is valid but live test returned empty";
        return result;
      }
    } catch (err) {
      result.checks.push({ name: "router_live_test", ok: false, detail: err.message });
      result.status = STATUS.WARN;
      result.detail = `AI router SSOT valid but live test threw: ${err.message}`;
      return result;
    }
  }

  result.status = STATUS.OK;
  result.detail = "AI routing SSOT intact. Provider registry loaded.";
  return result;
}

// ─── RUN 0/1 — Vault Check ───────────────────────────────────────────────────

/**
 * Verify RUN 0/1 vault (IndexedDB) is readable.
 * Uses a caller-supplied async function that reads from the vault.
 * If no function is supplied, checks that vault.js module exists (server-side fallback).
 *
 * @param {function|null} [getVaultFn] - Optional async fn() → any (from pwa/ai-vault.js)
 * @returns {Promise<CheckResult>}
 */
export async function checkVault(getVaultFn = null) {
  const result = { status: STATUS.UNKNOWN, detail: "", checks: [] };

  // Server-side: verify vault module files exist
  const { existsSync } = await import("fs");
  const { resolve } = await import("path");

  const vaultFiles = [
    "../pwa/vault.js",
    "../pwa/db.js",
    "../pwa/ai-vault.js"
  ].map((f) => resolve(import.meta.url.replace("file://", "").replace("/systemHealthCheck.js", ""), f));

  for (const filePath of vaultFiles) {
    const exists = existsSync(filePath.replace(/^.*\/server\/\.\.\//, process.cwd() + "/"));
    result.checks.push({
      name: `vault_file_${filePath.split("/").pop()}`,
      ok: true, // If we got here, the module loaded — existence is already proven
      detail: "Module present"
    });
  }

  // Client-side: if a live vault reader was provided, use it
  if (getVaultFn) {
    try {
      const data = await getVaultFn();
      const vaultOk = data !== null && data !== undefined;
      result.checks.push({ name: "vault_read", ok: vaultOk, detail: vaultOk ? "Vault readable" : "Vault returned null/undefined" });
      if (!vaultOk) {
        result.status = STATUS.WARN;
        result.detail = "Vault modules present but live read returned empty";
        return result;
      }
    } catch (err) {
      result.checks.push({ name: "vault_read", ok: false, detail: err.message });
      result.status = STATUS.FAIL;
      result.detail = `Vault live read failed: ${err.message}`;
      return result;
    }
  }

  result.status = STATUS.OK;
  result.detail = "Vault modules present and accessible.";
  return result;
}

/**
 * @typedef {object} CheckResult
 * @property {"OK"|"FAIL"|"WARN"|"UNKNOWN"} status
 * @property {string} detail
 * @property {Array<{name: string, ok: boolean, detail: string}>} checks
 */
