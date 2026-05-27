/**
 * providerStore.js — AI Provider Local State Engine (RUN 7.4)
 *
 * Single source of truth for AI provider config in the PWA layer.
 * Persists to localStorage under "av_ai_providers".
 * Syncs to agent on write if agent is reachable (best-effort, non-blocking).
 *
 * SSOT Rules:
 * ✔ API keys NEVER stored in localStorage — vault only (vaultWrapper.saveAIKey)
 * ✔ localStorage holds non-sensitive config: enabled, order, model, baseUrl
 * ✔ Syncs to agent via apiBridge on every write (best-effort)
 * ✔ Falls back to ssot/aiProviderConfig.json defaults if no local state
 * ✔ Returns typed, null-safe config objects — never raw JSON
 * ❌ Never stores apiKey values in any returned object
 */

import { saveAIKey as vaultSaveAIKey, getSecret } from "./vaultWrapper.js";
import { sendToAgent }                              from "./apiBridge.js";

const STORAGE_KEY  = "av_ai_providers";
const PROVIDER_IDS = ["ollama", "groq", "openrouter", "together", "huggingface"];

// ─── Default Config ───────────────────────────────────────────────────────────

function _defaults() {
  return {
    activeProvider: "ollama",
    fallbackOrder:  ["ollama", "groq", "openrouter", "together", "huggingface"],
    providers: {
      ollama:      { enabled: true,  status: "unknown", baseUrl: "http://localhost:11434", model: "llama3",                          label: "Ollama (Local)",  local: true  },
      groq:        { enabled: false, status: "unknown", model: "llama3-70b-8192",          label: "Groq",          local: false },
      openrouter:  { enabled: false, status: "unknown", model: "meta-llama/llama-3-70b",   label: "OpenRouter",    local: false },
      together:    { enabled: false, status: "unknown", model: "Llama-3-70b-chat-hf",      label: "Together AI",   local: false },
      huggingface: { enabled: false, status: "unknown", model: "Meta-Llama-3-8B-Instruct", label: "HuggingFace",   local: false }
    },
    updatedAt: null
  };
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Get the full provider config (merged defaults + stored).
 * Never includes apiKey values.
 */
export function getConfig() {
  try {
    const raw  = localStorage.getItem(STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) : {};
    return _merge(_defaults(), stored);
  } catch {
    return _defaults();
  }
}

/**
 * Get a single provider's config.
 *
 * @param {string} name
 * @returns {object}
 */
export function getProvider(name) {
  return getConfig().providers?.[name] || {};
}

/**
 * Get the list of providers ordered by fallbackOrder, with active first.
 */
export function getOrderedProviders() {
  const cfg = getConfig();
  return cfg.fallbackOrder
    .filter((id) => PROVIDER_IDS.includes(id))
    .map((id) => ({ id, ...cfg.providers[id], isActive: id === cfg.activeProvider }));
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Save the full config to localStorage and sync to agent.
 */
export function saveConfig(config) {
  // Strip any accidental apiKey leakage before storing
  const safe = _stripKeys(config);
  safe.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  _syncToAgent(safe);
  return safe;
}

/**
 * Update one or more fields on a provider.
 *
 * @param {string} name
 * @param {object} updates  — MUST NOT include apiKey
 */
export function updateProvider(name, updates) {
  if (!PROVIDER_IDS.includes(name)) return getConfig();
  const { apiKey: _stripped, ...safeUpdates } = updates; // strip if accidentally passed
  const cfg = getConfig();
  cfg.providers[name] = { ...(cfg.providers[name] || {}), ...safeUpdates };
  return saveConfig(cfg);
}

/**
 * Set the active provider and sync to agent.
 */
export function setActiveProvider(name) {
  if (!PROVIDER_IDS.includes(name)) return getConfig();
  const cfg = getConfig();
  cfg.activeProvider = name;
  return saveConfig(cfg);
}

/**
 * Set the fallback order.
 */
export function setFallbackOrder(order) {
  const valid = order.filter((id) => PROVIDER_IDS.includes(id));
  const cfg   = getConfig();
  cfg.fallbackOrder = valid;
  return saveConfig(cfg);
}

/**
 * Update a provider's live status (after a test run).
 */
export function setProviderStatus(name, status, latencyMs = null) {
  return updateProvider(name, {
    status,
    ...(latencyMs !== null ? { latencyMs } : {}),
    lastTested: new Date().toISOString()
  });
}

// ─── Key Management (vault-only) ──────────────────────────────────────────────

/**
 * Save an API key to the vault (never to localStorage).
 * Also sends key to agent session via apiBridge.
 *
 * @param {string} provider
 * @param {string} key
 */
export async function saveProviderKey(provider, key) {
  if (!key?.trim()) throw new Error("Key is empty");
  await vaultSaveAIKey(provider, key);
  // Push to agent session (best-effort)
  sendToAgent("set-ai-key", { provider, apiKey: key }).catch(() => {});
}

/**
 * Check if a vault key exists for a provider (returns boolean, not the key).
 */
export async function hasProviderKey(provider) {
  try {
    const key = await getSecret(`ai_key_${provider}`);
    return !!key;
  } catch { return false; }
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

async function _syncToAgent(cfg) {
  try {
    await sendToAgent("set-ai-provider", { provider: cfg.activeProvider });
  } catch { /* non-fatal — agent may be offline */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _merge(defaults, stored) {
  const result = { ...defaults, ...stored };
  result.providers = {};
  for (const id of PROVIDER_IDS) {
    result.providers[id] = { ...(defaults.providers[id] || {}), ...(stored.providers?.[id] || {}) };
  }
  return result;
}

function _stripKeys(cfg) {
  const safe = { ...cfg };
  if (safe.providers) {
    safe.providers = {};
    for (const [id, p] of Object.entries(cfg.providers || {})) {
      const { apiKey: _k, ...rest } = p;
      safe.providers[id] = rest;
    }
  }
  return safe;
}
