/**
 * aiFallback.js — Fallback Engine (RUN 2)
 *
 * Activated when all retries on a mapped provider are exhausted,
 * or when the provider is disabled/unknown.
 *
 * SSOT Rules:
 * ✔ Owns all fallback logic — nowhere else handles this
 * ✔ Returns structured fallback response (never throws)
 * ❌ Never calls providers directly
 * ❌ Never stores state
 */

import PROVIDERS from "../ssot/aiProviders.json" assert { type: "json" };
import ROUTING from "../ssot/aiRouting.json" assert { type: "json" };

/**
 * Attempt the designated fallback provider, then degrade gracefully.
 *
 * @param {string} prompt - The original prompt
 * @param {object} context - { reason, task, providerName, error, keys }
 * @returns {Promise<string>}
 */
export async function fallbackAI(prompt, context = {}) {
  const { reason = "UNKNOWN", task = "unknown", providerName = "unknown", error, keys } = context;

  // Attempt the SSOT-designated fallback provider if keys are available
  if (keys) {
    const fallbackName = ROUTING.tasks.fallback;
    const fallbackProvider = PROVIDERS.providers[fallbackName];

    if (fallbackProvider?.enabled && fallbackProvider.authType === "none") {
      // Local provider — attempt without key
      try {
        const { callProvider } = await import("./aiDispatcher.js");
        return await callProvider(fallbackName, prompt, {});
      } catch {
        // Fall through to degraded response
      }
    } else if (fallbackProvider?.enabled && keys[fallbackName]) {
      try {
        const { callProvider } = await import("./aiDispatcher.js");
        return await callProvider(fallbackName, prompt, keys);
      } catch {
        // Fall through to degraded response
      }
    }
  }

  // Fully degraded — structured message for the UI to handle
  return buildDegradedResponse({ prompt, reason, task, providerName, error });
}

/**
 * Build a structured degraded-mode response string.
 * The UI can detect the [FALLBACK] marker and render it distinctly.
 */
function buildDegradedResponse({ prompt, reason, task, providerName, error }) {
  const timestamp = new Date().toISOString();
  const actionMap = {
    PROVIDER_DISABLED: `Enable "${providerName}" in Settings → AI Provider Vault`,
    PROVIDER_FAILED:   `Check your "${providerName}" API key in Settings → AI Provider Vault`,
    NO_KEY:            `Add an API key for "${providerName}" in Settings → AI Provider Vault`,
    UNKNOWN:           "Check provider settings and retry"
  };
  const action = actionMap[reason] || actionMap.UNKNOWN;

  return `[FALLBACK MODE ACTIVE]

Task:     ${task}
Provider: ${providerName}
Reason:   ${reason}
Time:     ${timestamp}
${error ? `Error:    ${error}\n` : ""}
─────────────────────────────
Original Prompt:
${prompt}
─────────────────────────────
Suggested Action:
→ ${action}
→ Or switch fallback provider in ssot/aiRouting.json
→ Then retry the task
`;
}

/**
 * Check if a string is a fallback response (for UI detection).
 */
export function isFallbackResponse(str) {
  return typeof str === "string" && str.startsWith("[FALLBACK MODE ACTIVE]");
}
