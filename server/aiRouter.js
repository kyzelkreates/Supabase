/**
 * aiRouter.js — AI Router Engine (RUN 2 CORE BRAIN)
 *
 * SSOT Rules enforced here:
 * ✔ Reads provider registry from RUN 1 (ssot/aiProviders.json)
 * ✔ Reads routing map from ssot/aiRouting.json
 * ✔ Reads keys from RUN 1 vault (pwa/ai-vault.js)
 * ✔ All AI execution delegated to aiDispatcher.js
 * ✔ All fallback delegated to aiFallback.js
 * ❌ Never stores keys
 * ❌ Never defines providers
 * ❌ Never calls AI directly
 */

import PROVIDERS from "../ssot/aiProviders.json" assert { type: "json" };
import ROUTING from "../ssot/aiRouting.json" assert { type: "json" };
import { callProvider } from "./aiDispatcher.js";
import { fallbackAI } from "./aiFallback.js";
import { getAIKeys } from "../pwa/ai-vault.js";

const { maxRetries, ifProviderFailsUseFallback } = ROUTING.rules;

/**
 * Route and execute an AI task by role name.
 *
 * @param {string} task     - One of: "planner" | "builder" | "validator" | "fixer"
 * @param {string} prompt   - The prompt to send to the AI
 * @param {object} [opts]   - Optional overrides: { providerOverride, model }
 * @returns {Promise<{ result: string, provider: string, task: string, retries: number }>}
 */
export async function runAITask(task, prompt, opts = {}) {
  const providerName = opts.providerOverride || ROUTING.tasks[task];

  if (!providerName) {
    throw new Error(`[aiRouter] No provider mapped for task: "${task}"`);
  }

  const provider = PROVIDERS.providers[providerName];

  // Provider missing or disabled → immediate fallback
  if (!provider || !provider.enabled) {
    console.warn(`[aiRouter] Provider "${providerName}" is disabled or unknown. Using fallback.`);
    const result = await fallbackAI(prompt, { reason: "PROVIDER_DISABLED", task, providerName });
    return { result, provider: "fallback", task, retries: 0 };
  }

  const keys = await getAIKeys();
  let lastError = null;

  // Retry loop
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await callProvider(providerName, prompt, keys, opts.model);
      return { result, provider: providerName, task, retries: attempt - 1 };
    } catch (err) {
      lastError = err;
      console.warn(`[aiRouter] Attempt ${attempt}/${maxRetries} failed for "${providerName}": ${err.message}`);
    }
  }

  // All retries exhausted
  if (ifProviderFailsUseFallback) {
    console.warn(`[aiRouter] All retries failed. Activating fallback.`);
    const result = await fallbackAI(prompt, {
      reason: "PROVIDER_FAILED",
      task,
      providerName,
      error: lastError?.message
    });
    return { result, provider: "fallback", task, retries: maxRetries };
  }

  throw new Error(
    `[aiRouter] Task "${task}" failed after ${maxRetries} retries on "${providerName}": ${lastError?.message}`
  );
}

/**
 * Resolve which provider is mapped to a task (read-only, no execution).
 * Useful for UI display and pre-flight checks.
 */
export function resolveProvider(task) {
  const name = ROUTING.tasks[task];
  if (!name) return null;
  const provider = PROVIDERS.providers[name];
  return provider ? { name, ...provider } : null;
}

/**
 * Get the full routing table (read-only snapshot).
 */
export function getRoutingMap() {
  return structuredClone(ROUTING);
}
