/**
 * providerTestBridge.js — Provider Test API Bridge (RUN 7.4)
 *
 * Thin wrapper around apiBridge.sendToAgent() scoped to provider testing.
 * Used by providerTester.js when testing cloud providers (so keys stay
 * on the agent, never in the PWA).
 *
 * Also handles the /test-provider agent route registration extension
 * (agentRoutes74.js imports this spec).
 *
 * SSOT Rules:
 * ✔ All cloud provider test calls go through this bridge
 * ✔ Never passes API keys — agent reads them from its own env/vault
 * ✔ Returns TestBridgeResult — providerTester.js owns status writes
 */

import { sendToAgent } from "../apiBridge.js";

/**
 * Request a live provider test from the agent.
 *
 * @param {string} providerId
 * @param {string} [prompt]
 * @returns {Promise<TestBridgeResult>}
 *
 * @typedef {object} TestBridgeResult
 * @property {boolean} ok
 * @property {boolean} [noKey]      - True when provider has no API key
 * @property {string}  [response]   - Trimmed response text
 * @property {number}  [latencyMs]
 * @property {string}  [error]
 */
export async function requestProviderTest(providerId, prompt = "Respond with exactly the word: OK") {
  return sendToAgent("test-provider", { provider: providerId, prompt }, { timeout: 20_000 });
}

/**
 * Request a batch test of all configured providers from the agent.
 */
export async function requestBatchTest() {
  return sendToAgent("test-all-providers", {}, { timeout: 60_000 });
}
