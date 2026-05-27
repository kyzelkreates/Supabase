/**
 * providerTester.js — Live AI Provider Test Engine (RUN 7.4)
 *
 * Runs live "ping" prompts against each AI provider and returns
 * structured TestResult objects with latency, status, and response.
 *
 * Cloud provider tests route via the local agent (/test-provider) so
 * API keys stay server-side. Ollama is tested directly (no key needed).
 *
 * SSOT Rules:
 * ✔ Cloud tests go through agent (keys never in PWA)
 * ✔ Ollama tested directly from PWA (local, no key)
 * ✔ Returns TestResult — providerStore.setProviderStatus() owns the write
 * ✔ All tests time-bounded (5s Ollama, 15s cloud)
 * ❌ Never reads API keys from localStorage
 * ❌ Never stores test responses
 */

import { sendToAgent }       from "./apiBridge.js";
import { setProviderStatus } from "./providerStore.js";

const TEST_PROMPT = "Respond with exactly the word: OK";

// ─── Single Provider Test ─────────────────────────────────────────────────────

/**
 * Test one provider and write the result to the store.
 *
 * @param {string} providerId
 * @param {object} [providerCfg]  - From providerStore.getProvider()
 * @returns {Promise<TestResult>}
 *
 * @typedef {object} TestResult
 * @property {string}  provider
 * @property {"ok"|"fail"|"timeout"|"no_key"|"offline"} status
 * @property {number}  latencyMs
 * @property {string}  [response]   - Trimmed first 120 chars
 * @property {string}  [error]
 */
export async function testProvider(providerId, providerCfg = {}) {
  const startMs = Date.now();

  let result;
  if (providerId === "ollama") {
    result = await _testOllama(providerCfg);
  } else {
    result = await _testCloudProvider(providerId);
  }

  const latencyMs = Date.now() - startMs;
  const full = { provider: providerId, latencyMs, ...result };

  // Persist status to store
  setProviderStatus(providerId, full.status, latencyMs);

  return full;
}

// ─── Batch Test ───────────────────────────────────────────────────────────────

/**
 * Test all enabled providers in parallel.
 *
 * @param {object[]} providers  - From providerStore.getOrderedProviders()
 * @param {function} [onResult] - (TestResult) => void — called as each result arrives
 * @returns {Promise<TestResult[]>}
 */
export async function testAllProviders(providers, onResult = null) {
  const enabled = providers.filter((p) => p.enabled);
  const results = await Promise.allSettled(
    enabled.map(async (p) => {
      const r = await testProvider(p.id, p);
      if (onResult) onResult(r);
      return r;
    })
  );
  return results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
}

// ─── Ollama (Direct — no agent needed) ───────────────────────────────────────

async function _testOllama(cfg) {
  const baseUrl = cfg.baseUrl || "http://localhost:11434";
  const model   = cfg.model   || "llama3";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(`${baseUrl}/api/generate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ model, prompt: TEST_PROMPT, stream: false }),
      signal:  controller.signal
    });

    clearTimeout(timer);

    if (!res.ok) {
      return { status: res.status === 404 ? "fail" : "offline", error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    const response = (data.response || "").trim().slice(0, 120);
    return { status: "ok", response, model };

  } catch (err) {
    if (err.name === "AbortError") return { status: "timeout", error: "Timed out after 10s" };
    const offline = err.message?.includes("ECONNREFUSED") || err.message?.includes("Failed to fetch");
    return { status: offline ? "offline" : "fail", error: err.message };
  }
}

// ─── Cloud Providers (via agent — keys stay server-side) ─────────────────────

async function _testCloudProvider(providerId) {
  const res = await sendToAgent("test-provider", { provider: providerId, prompt: TEST_PROMPT }, { timeout: 20_000 });

  if (!res.ok) {
    const reason = res.reason === "network" ? "offline" : res.reason === "auth" ? "fail" : "fail";
    return { status: reason, error: res.error };
  }

  const data = res.data;
  if (data?.noKey)    return { status: "no_key",  error: "API key not set — save it in AI Settings" };
  if (!data?.ok)      return { status: "fail",    error: data?.error || "Provider test failed" };

  return { status: "ok", response: (data.response || "").trim().slice(0, 120) };
}
