/**
 * retryLoop.js — Retry Loop Engine (RUN 3)
 *
 * Runs an async action, validates the result, and retries until
 * schema is valid or maxRetries is exceeded.
 *
 * SSOT Rules:
 * ✔ Validation always delegated to schemaValidator.js
 * ✔ Retry state written to ssot/installState.json
 * ✔ Returns structured result — never throws on exhaustion
 * ❌ Never executes migrations directly (migrationEngine owns that)
 * ❌ Never calls AI (RUN 2 owns that)
 */

import { validateSchema, runFullValidation } from "./schemaValidator.js";
import { loadInstallState, saveInstallState } from "./installController.js";

// ─── Core Retry Loop ──────────────────────────────────────────────────────────

/**
 * Retry an async action until schema validation passes or maxRetries hit.
 *
 * @param {function(): Promise<any>} action - The async operation to retry
 * @param {object} [opts]
 * @param {number}   [opts.maxRetries=3]          - Max attempts
 * @param {number}   [opts.delayMs=2000]           - Delay between retries (ms)
 * @param {object}   [opts.expectations]           - Passed to runFullValidation
 * @param {string}   [opts.projectName]            - For state tracking
 * @param {function} [opts.onRetry]                - Callback: (attempt, error) => void
 * @returns {Promise<RetryResult>}
 */
export async function retryUntilValid(action, opts = {}) {
  const {
    maxRetries = 3,
    delayMs = 2000,
    expectations = {},
    projectName = "unknown",
    onRetry = null
  } = opts;

  const state = loadInstallState();
  state.retryCount = 0;
  saveInstallState(state);

  let lastError = null;
  let lastValidation = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[retryLoop] Attempt ${attempt}/${maxRetries} for "${projectName}"`);

    // Update SSOT state
    _updateRetryState(projectName, attempt, "running");

    try {
      await action();
    } catch (err) {
      lastError = err;
      console.warn(`[retryLoop] Action threw on attempt ${attempt}: ${err.message}`);
    }

    // Validate regardless of action success/failure
    lastValidation = Object.keys(expectations).length > 0
      ? runFullValidation(expectations)
      : _simpleValidation();

    console.log(`[retryLoop] Validation ${attempt}: ${lastValidation.passed ? "PASS ✔" : "FAIL ✘"}`);
    if (lastValidation.summary?.length) {
      console.log(`[retryLoop] Summary: ${lastValidation.summary.join(" | ")}`);
    }

    if (lastValidation.passed) {
      _updateRetryState(projectName, attempt, "success");
      return {
        success: true,
        attempts: attempt,
        validation: lastValidation,
        error: null
      };
    }

    if (attempt < maxRetries) {
      if (onRetry) onRetry(attempt, lastError);
      await _delay(delayMs);
    }
  }

  _updateRetryState(projectName, maxRetries, "failed");

  return {
    success: false,
    attempts: maxRetries,
    validation: lastValidation,
    error: lastError?.message || "Schema validation failed after max retries",
    issues: lastValidation?.issues || lastValidation?.schemaSync?.issues || []
  };
}

// ─── Simple Retry (no expectations) ─────────────────────────────────────────

/**
 * Retry with basic schema diff only (no table/column expectations).
 * Convenience wrapper for quick usage.
 */
export async function retrySimple(action, maxRetries = 3, delayMs = 2000) {
  return retryUntilValid(action, { maxRetries, delayMs });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _simpleValidation() {
  const schema = validateSchema();
  return {
    passed: schema.valid,
    summary: schema.valid ? ["Schema diff: PASS"] : [`Schema diff: FAIL — ${schema.issues?.join("; ") || schema.error}`],
    schemaSync: schema,
    timestamp: new Date().toISOString()
  };
}

function _updateRetryState(projectName, attempt, status) {
  try {
    const state = loadInstallState();
    state.retryCount = attempt;
    state.status = status === "running" ? "installing" : status === "success" ? "installed" : "failed";
    state.currentProject = projectName;
    saveInstallState(state);
  } catch {
    // State persistence failure should never abort a retry
  }
}

function _delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
