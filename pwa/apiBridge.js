/**
 * apiBridge.js — PWA → Local Agent HTTP Bridge (RUN 7.2)
 *
 * The ONLY module in the PWA that communicates with the local agent.
 * All other PWA modules call this — never fetch the agent directly.
 *
 * Features:
 *   - Configurable base URL (defaults to http://localhost:4000)
 *   - Bearer token auth (stored in vault via vaultWrapper)
 *   - Request timeout (30s default, configurable per-call)
 *   - Structured error handling — always returns { ok, error? }
 *   - Connection status caching (avoids repeated /status pings)
 *
 * SSOT Rules:
 * ✔ Single outbound HTTP surface — all agent calls go through here
 * ✔ Auth token loaded from vault (never hardcoded)
 * ✔ Never imports server/ modules
 * ✔ Returns typed, null-safe results
 * ❌ Never exposes raw fetch responses to callers
 */

import { isUnlocked } from "./vaultWrapper.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://localhost:4000";
const DEFAULT_TIMEOUT  = 30_000;  // 30s
const STATUS_CACHE_MS  = 8_000;   // Re-use /status response for 8s

let _baseURL      = DEFAULT_BASE_URL;
let _agentToken   = "";           // Loaded from vault on first call
let _statusCache  = null;         // { result, expiry }

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Override the agent base URL (e.g. for a remote or tunnelled agent).
 * Persisted in sessionStorage so it survives page navigation.
 *
 * @param {string} url
 */
export function setAgentURL(url) {
  _baseURL = url.replace(/\/$/, "");
  sessionStorage.setItem("av_agent_url", _baseURL);
  _statusCache = null; // Invalidate cache on URL change
}

/**
 * Get the current agent base URL.
 */
export function getAgentURL() {
  const stored = sessionStorage.getItem("av_agent_url");
  if (stored) _baseURL = stored;
  return _baseURL;
}

/**
 * Set the Bearer token for agent auth.
 * Called by settings.js after saving an agent token to the vault.
 */
export function setAgentToken(token) {
  _agentToken = token || "";
}

// ─── Core Request ─────────────────────────────────────────────────────────────

/**
 * Send a JSON POST to the agent.
 *
 * @param {string} endpoint   - e.g. "generate-sql"
 * @param {object} payload
 * @param {object} [options]  - { timeout, signal }
 * @returns {Promise<BridgeResult>}
 *
 * @typedef {object} BridgeResult
 * @property {boolean} ok
 * @property {any}     [data]    - Parsed response body on success
 * @property {string}  [error]   - Error message on failure
 * @property {"network"|"timeout"|"auth"|"agent_error"|"parse"} [reason]
 */
export async function sendToAgent(endpoint, payload = {}, options = {}) {
  const url     = `${getAgentURL()}/${endpoint.replace(/^\//, "")}`;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    await _loadTokenIfNeeded();

    const headers = { "Content-Type": "application/json" };
    if (_agentToken) headers["Authorization"] = `Bearer ${_agentToken}`;

    const res = await fetch(url, {
      method:  "POST",
      headers,
      body:    JSON.stringify(payload),
      signal:  options.signal || controller.signal
    });

    clearTimeout(timer);

    if (res.status === 401) {
      return { ok: false, error: "Agent auth failed — check your agent token in Settings", reason: "auth" };
    }

    let body;
    try { body = await res.json(); }
    catch { return { ok: false, error: "Agent returned invalid JSON", reason: "parse" }; }

    if (!res.ok) {
      return { ok: false, error: body?.error || `Agent returned HTTP ${res.status}`, reason: "agent_error", data: body };
    }

    return { ok: true, data: body };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { ok: false, error: `Agent request timed out after ${timeout / 1000}s`, reason: "timeout" };
    }
    if (err.message.includes("fetch")) {
      return { ok: false, error: `Cannot reach agent at ${getAgentURL()} — is it running?`, reason: "network" };
    }
    return { ok: false, error: err.message, reason: "network" };
  }
}

/**
 * Send a GET request to the agent.
 *
 * @param {string} endpoint
 * @param {object} [params]  - Query params
 * @returns {Promise<BridgeResult>}
 */
export async function getFromAgent(endpoint, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `${getAgentURL()}/${endpoint.replace(/^\//, "")}${qs ? `?${qs}` : ""}`;

  try {
    await _loadTokenIfNeeded();
    const headers = {};
    if (_agentToken) headers["Authorization"] = `Bearer ${_agentToken}`;

    const res = await fetch(url, { method: "GET", headers });

    if (res.status === 401) return { ok: false, error: "Agent auth failed", reason: "auth" };

    let body;
    try { body = await res.json(); }
    catch { return { ok: false, error: "Agent returned invalid JSON", reason: "parse" }; }

    return res.ok ? { ok: true, data: body } : { ok: false, error: body?.error || `HTTP ${res.status}`, reason: "agent_error" };

  } catch (err) {
    if (err.message.includes("fetch")) {
      return { ok: false, error: `Cannot reach agent at ${getAgentURL()}`, reason: "network" };
    }
    return { ok: false, error: err.message, reason: "network" };
  }
}

// ─── Convenience Methods ──────────────────────────────────────────────────────

/**
 * Check if the agent is reachable and healthy.
 * Result is cached for STATUS_CACHE_MS to avoid hammering the agent.
 *
 * @param {boolean} [force] - Bypass cache
 * @returns {Promise<AgentStatus>}
 *
 * @typedef {object} AgentStatus
 * @property {boolean} reachable
 * @property {string}  [version]
 * @property {string}  [pipelineStatus]
 * @property {string}  [wiringStatus]
 * @property {string}  [error]
 */
export async function checkAgentStatus(force = false) {
  if (!force && _statusCache && Date.now() < _statusCache.expiry) {
    return _statusCache.result;
  }

  const res = await getFromAgent("status");

  const result = res.ok
    ? {
        reachable:      true,
        version:        res.data?.version,
        pipelineStatus: res.data?.pipeline?.status,
        wiringStatus:   res.data?.wiring?.status,
        authMode:       res.data?.authMode,
        timestamp:      res.data?.timestamp
      }
    : {
        reachable: false,
        error:     res.error
      };

  _statusCache = { result, expiry: Date.now() + STATUS_CACHE_MS };
  return result;
}

/**
 * Upload a ZIP file to the agent.
 * Uses FormData (not JSON).
 *
 * @param {File}   file
 * @param {number} [timeout=120000]
 * @returns {Promise<BridgeResult>}
 */
export async function uploadZipToAgent(file, timeout = 120_000) {
  const url = `${getAgentURL()}/upload-zip`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    await _loadTokenIfNeeded();
    const headers = {};
    if (_agentToken) headers["Authorization"] = `Bearer ${_agentToken}`;

    const form = new FormData();
    form.append("zip", file);

    const res = await fetch(url, { method: "POST", headers, body: form, signal: controller.signal });
    clearTimeout(timer);

    if (res.status === 401) return { ok: false, error: "Agent auth failed", reason: "auth" };

    let body;
    try { body = await res.json(); }
    catch { return { ok: false, error: "Invalid JSON from agent", reason: "parse" }; }

    return res.ok ? { ok: true, data: body } : { ok: false, error: body?.error || `HTTP ${res.status}`, reason: "agent_error" };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return { ok: false, error: `Upload timed out after ${timeout / 1000}s`, reason: "timeout" };
    return { ok: false, error: err.message, reason: "network" };
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function _loadTokenIfNeeded() {
  if (_agentToken) return;
  // Try to load from vault (non-fatal if vault is locked or unavailable)
  try {
    const { getSecret } = await import("./vaultWrapper.js");
    const token = await getSecret("agent_token");
    if (token) _agentToken = token;
  } catch { /* vault unavailable — proceed without token */ }
}
