/**
 * aiProviderManager.js — Multi-Provider AI Routing Engine (RUN 7.3)
 *
 * Smart AI dispatch with Ollama-first routing and automatic fallback.
 * Each provider is tried in fallbackOrder until one succeeds.
 * Keys loaded from vault (via agent .env or vaultWrapper when available).
 *
 * Provider priority (configurable in ssot/aiProviderConfig.json):
 *   1. ollama       — local, offline-first, zero API key
 *   2. groq         — fast cloud inference
 *   3. openrouter   — aggregated providers
 *   4. together     — open model cloud
 *   5. huggingface  — inference API
 *
 * SSOT Rules:
 * ✔ Config loaded from ssot/aiProviderConfig.json (hot-reload per call)
 * ✔ Keys loaded from process.env (set by vault export or .env file)
 * ✔ Returns ProviderResult — never throws to caller
 * ✔ Every attempt is logged with provider + duration
 * ✔ Ollama is ALWAYS tried first if enabled
 * ❌ Never caches keys in memory across calls
 */

import fs   from "fs";
import path from "path";
import { callOllama, checkOllamaHealth } from "./ollamaClient.js";

const CONFIG_PATH = path.resolve("./ssot/aiProviderConfig.json");

// ─── Config Loader ────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return { activeProvider: "ollama", fallbackOrder: ["ollama"], ollama: { enabled: true } };
  }
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Run an AI prompt through the configured provider chain.
 * Always tries Ollama first if enabled, then falls back in order.
 *
 * @param {string}  prompt
 * @param {object}  [options]
 * @param {string}  [options.taskType]      - "schema"|"plan"|"validate"|"fix"
 * @param {string}  [options.forceProvider] - Skip fallback, use this provider only
 * @returns {Promise<ProviderResult>}
 *
 * @typedef {object} ProviderResult
 * @property {boolean}  ok
 * @property {string}   response
 * @property {string}   provider      - Which provider succeeded
 * @property {boolean}  usedFallback  - True if active provider failed
 * @property {Attempt[]} attempts     - Log of all attempts
 * @property {number}   durationMs
 * @property {string}   [error]       - Set if ALL providers failed
 *
 * @typedef {object} Attempt
 * @property {string}  provider
 * @property {boolean} ok
 * @property {number}  durationMs
 * @property {string}  [error]
 */
export async function runAI(prompt, options = {}) {
  const cfg     = loadConfig();
  const startMs = Date.now();
  const attempts = [];

  // Build the ordered provider list
  let order = cfg.fallbackOrder?.filter((p) => cfg[p]?.enabled !== false) || ["ollama"];

  // Force a specific provider if requested (testing / override)
  if (options.forceProvider) order = [options.forceProvider];

  // Always put Ollama first if it's enabled and in the list (SSOT rule)
  if (!options.forceProvider && cfg.ollama?.enabled && order.includes("ollama")) {
    order = ["ollama", ...order.filter((p) => p !== "ollama")];
  }

  console.log(`[aiProviderManager] Routing (${options.taskType || "general"}): ${order.join(" → ")}`);

  for (const provider of order) {
    const attempt = await _callProvider(provider, prompt, cfg);
    attempts.push({ provider, ok: attempt.ok, durationMs: attempt.durationMs, error: attempt.error });

    if (attempt.ok) {
      const used = order.indexOf(provider) > 0;
      console.log(`[aiProviderManager] ✔ ${provider} succeeded (${attempt.durationMs}ms)${used ? " [fallback]" : ""}`);
      return {
        ok:          true,
        response:    attempt.response,
        provider,
        usedFallback: provider !== order[0],
        attempts,
        durationMs:  Date.now() - startMs
      };
    }

    console.warn(`[aiProviderManager] ✘ ${provider} failed: ${attempt.error}`);
  }

  // All providers failed
  const errorSummary = attempts.map((a) => `${a.provider}: ${a.error}`).join(" | ");
  console.error(`[aiProviderManager] All providers exhausted: ${errorSummary}`);

  return {
    ok:          false,
    response:    "",
    provider:    "none",
    usedFallback: true,
    attempts,
    durationMs:  Date.now() - startMs,
    error:       `All AI providers failed. ${errorSummary}`
  };
}

// ─── Provider Dispatchers ─────────────────────────────────────────────────────

async function _callProvider(provider, prompt, cfg) {
  const startMs = Date.now();
  const dur = () => Date.now() - startMs;

  try {
    switch (provider) {
      case "ollama":    return await _callOllamaProvider(prompt, cfg, dur);
      case "groq":      return await _callOpenAICompatible(prompt, cfg.groq, "groq",       process.env.GROQ_API_KEY,       "https://api.groq.com/openai/v1",      dur);
      case "openrouter":return await _callOpenAICompatible(prompt, cfg.openrouter, "openrouter", process.env.OPENROUTER_API_KEY, "https://openrouter.ai/api/v1",       dur);
      case "together":  return await _callOpenAICompatible(prompt, cfg.together, "together",   process.env.TOGETHER_API_KEY,   "https://api.together.xyz/v1",         dur);
      case "huggingface":return await _callHuggingFace(prompt, cfg.huggingface, dur);
      default:
        return { ok: false, error: `Unknown provider: ${provider}`, durationMs: dur() };
    }
  } catch (err) {
    return { ok: false, error: err.message, durationMs: dur() };
  }
}

async function _callOllamaProvider(prompt, cfg, dur) {
  const result = await callOllama(prompt, {
    model:       cfg.ollama?.model,
    temperature: cfg.ollama?.temperature,
    numCtx:      cfg.ollama?.numCtx,
    timeout:     cfg.ollama?.timeout
  });
  return result.ok
    ? { ok: true, response: result.response, durationMs: dur() }
    : { ok: false, error: result.error, durationMs: dur() };
}

async function _callOpenAICompatible(prompt, providerCfg, providerName, apiKey, defaultBaseUrl, dur) {
  if (!apiKey) return { ok: false, error: `No API key for ${providerName} (set ${providerName.toUpperCase()}_API_KEY)`, durationMs: dur() };

  const baseUrl = providerCfg?.baseUrl || defaultBaseUrl;
  const model   = providerCfg?.model;
  const timeout = providerCfg?.timeout || 45_000;
  const temp    = providerCfg?.temperature ?? 0.2;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages:    [{ role: "user", content: prompt }],
        temperature: temp,
        max_tokens:  4096
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return { ok: false, error: `${providerName} HTTP ${res.status}: ${err.slice(0, 150)}`, durationMs: dur() };
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    if (!text.trim()) return { ok: false, error: `${providerName} returned empty response`, durationMs: dur() };

    return { ok: true, response: text.trim(), durationMs: dur() };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return { ok: false, error: `${providerName} timed out`, durationMs: dur() };
    return { ok: false, error: err.message, durationMs: dur() };
  }
}

async function _callHuggingFace(prompt, providerCfg, dur) {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) return { ok: false, error: "No API key for HuggingFace (set HUGGINGFACE_API_KEY)", durationMs: dur() };

  const model   = providerCfg?.model || "meta-llama/Meta-Llama-3-8B-Instruct";
  const baseUrl = providerCfg?.baseUrl || "https://api-inference.huggingface.co/models";
  const timeout = providerCfg?.timeout || 60_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${baseUrl}/${model}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 2048, temperature: 0.2 } }),
      signal: controller.signal
    });

    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HuggingFace HTTP ${res.status}`, durationMs: dur() };

    const data = await res.json();
    const text = Array.isArray(data) ? data[0]?.generated_text || "" : data?.generated_text || "";
    if (!text.trim()) return { ok: false, error: "HuggingFace returned empty response", durationMs: dur() };

    // HF echoes the prompt — strip it
    const stripped = text.startsWith(prompt) ? text.slice(prompt.length).trim() : text.trim();
    return { ok: true, response: stripped, durationMs: dur() };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return { ok: false, error: "HuggingFace timed out", durationMs: dur() };
    return { ok: false, error: err.message, durationMs: dur() };
  }
}

// ─── Status Check ─────────────────────────────────────────────────────────────

/**
 * Check which providers are currently reachable/configured.
 *
 * @returns {Promise<ProviderStatus[]>}
 */
export async function checkAllProviders() {
  const cfg = loadConfig();
  const results = [];

  // Ollama — live health check
  const ollamaHealth = await checkOllamaHealth();
  results.push({
    provider:  "ollama",
    enabled:   cfg.ollama?.enabled ?? true,
    reachable: ollamaHealth.ok,
    models:    ollamaHealth.models,
    activeModel: cfg.ollama?.model,
    error:     ollamaHealth.error
  });

  // Cloud providers — just check if key is present
  for (const p of ["groq", "openrouter", "together", "huggingface"]) {
    const keyMap = { groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY", together: "TOGETHER_API_KEY", huggingface: "HUGGINGFACE_API_KEY" };
    results.push({
      provider:    p,
      enabled:     cfg[p]?.enabled ?? false,
      reachable:   !!process.env[keyMap[p]],
      activeModel: cfg[p]?.model,
      keyPresent:  !!process.env[keyMap[p]]
    });
  }

  return results;
}
