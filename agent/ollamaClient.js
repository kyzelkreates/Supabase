/**
 * ollamaClient.js — Local Ollama AI Client (RUN 7.3)
 *
 * Communicates with a locally running Ollama instance.
 * Ollama is the PRIMARY AI engine — offline-first, zero API key needed.
 *
 * Supports:
 *   - Single-shot generation (callOllama)
 *   - Streaming generation (callOllamaStream)
 *   - Model listing and health check
 *   - Configurable model, context window, temperature, keep-alive
 *
 * SSOT Rules:
 * ✔ Config loaded from ssot/aiProviderConfig.json on each call (hot-reload)
 * ✔ Returns structured OllamaResult — never throws to caller
 * ✔ All timeouts enforced via AbortController
 * ❌ Never reads vault or API keys (Ollama is local — no auth needed)
 * ❌ Never called directly from PWA (agentRouter → aiProviderManager owns routing)
 */

import fs   from "fs";
import path from "path";

const CONFIG_PATH = path.resolve("./ssot/aiProviderConfig.json");

// ─── Config Loader ────────────────────────────────────────────────────────────

function loadOllamaConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    return {
      baseUrl:     cfg.ollama?.baseUrl     || "http://localhost:11434",
      model:       cfg.ollama?.model       || "llama3",
      timeout:     cfg.ollama?.timeout     || 60_000,
      keepAlive:   cfg.ollama?.keepAlive   || "5m",
      temperature: cfg.ollama?.temperature ?? 0.2,
      numCtx:      cfg.ollama?.numCtx      || 8192
    };
  } catch {
    return { baseUrl: "http://localhost:11434", model: "llama3", timeout: 60_000, keepAlive: "5m", temperature: 0.2, numCtx: 8192 };
  }
}

// ─── Main Call ────────────────────────────────────────────────────────────────

/**
 * Send a prompt to Ollama and return the generated text.
 *
 * @param {string}  prompt
 * @param {object}  [overrides]  - { model, temperature, numCtx } — override config
 * @returns {Promise<OllamaResult>}
 *
 * @typedef {object} OllamaResult
 * @property {boolean} ok
 * @property {string}  [response]     - Full generated text
 * @property {string}  [model]        - Model that was used
 * @property {number}  [evalCount]    - Tokens generated
 * @property {number}  [durationMs]
 * @property {string}  [error]
 * @property {"offline"|"timeout"|"model_not_found"|"parse"|"unknown"} [reason]
 */
export async function callOllama(prompt, overrides = {}) {
  const cfg      = loadOllamaConfig();
  const model    = overrides.model       || cfg.model;
  const timeout  = overrides.timeout     || cfg.timeout;
  const temp     = overrides.temperature ?? cfg.temperature;
  const numCtx   = overrides.numCtx      || cfg.numCtx;
  const baseUrl  = cfg.baseUrl;
  const startMs  = Date.now();

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream:     false,
        keep_alive: cfg.keepAlive,
        options:    { temperature: temp, num_ctx: numCtx }
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (res.status === 404) {
      // Ollama is up but the model isn't pulled
      return { ok: false, error: `Model "${model}" not found. Run: ollama pull ${model}`, reason: "model_not_found" };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Ollama HTTP ${res.status}: ${text.slice(0, 200)}`, reason: "unknown" };
    }

    let data;
    try { data = await res.json(); }
    catch (e) { return { ok: false, error: `Ollama response parse error: ${e.message}`, reason: "parse" }; }

    const response = data.response || data.message?.content || "";
    if (!response.trim()) {
      return { ok: false, error: "Ollama returned empty response", reason: "unknown" };
    }

    return {
      ok:         true,
      response:   response.trim(),
      model,
      evalCount:  data.eval_count || 0,
      promptTokens: data.prompt_eval_count || 0,
      durationMs: Date.now() - startMs
    };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { ok: false, error: `Ollama timed out after ${timeout / 1000}s`, reason: "timeout" };
    }
    if (err.message?.includes("ECONNREFUSED") || err.message?.includes("fetch")) {
      return { ok: false, error: `Ollama is offline — start it with: ollama serve`, reason: "offline" };
    }
    return { ok: false, error: err.message, reason: "unknown" };
  }
}

/**
 * Stream a prompt response from Ollama, calling onToken for each chunk.
 *
 * @param {string}   prompt
 * @param {function} onToken  - (token: string) => void
 * @param {object}   [overrides]
 * @returns {Promise<OllamaResult>}
 */
export async function callOllamaStream(prompt, onToken, overrides = {}) {
  const cfg     = loadOllamaConfig();
  const model   = overrides.model || cfg.model;
  const timeout = overrides.timeout || cfg.timeout;
  const startMs = Date.now();

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${cfg.baseUrl}/api/generate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: true, keep_alive: cfg.keepAlive }),
      signal: controller.signal
    });

    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `Ollama HTTP ${res.status}`, reason: "unknown" };

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText  = "";
    let evalCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value, { stream: true }).split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const chunk = JSON.parse(line);
          if (chunk.response) { fullText += chunk.response; onToken(chunk.response); }
          if (chunk.eval_count) evalCount = chunk.eval_count;
        } catch { /* partial line */ }
      }
    }

    return { ok: true, response: fullText, model, evalCount, durationMs: Date.now() - startMs };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return { ok: false, error: `Stream timed out`, reason: "timeout" };
    return { ok: false, error: err.message, reason: "unknown" };
  }
}

// ─── Health + Model Management ────────────────────────────────────────────────

/**
 * Check if Ollama is running and return available models.
 *
 * @returns {Promise<{ ok: boolean, models: string[], error?: string }>}
 */
export async function checkOllamaHealth() {
  const cfg = loadOllamaConfig();
  try {
    const res = await fetch(`${cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, models: [], error: `Ollama HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
    return { ok: true, models, activeModel: cfg.model };
  } catch (err) {
    const offline = err.message?.includes("ECONNREFUSED") || err.message?.includes("fetch");
    return { ok: false, models: [], error: offline ? "Ollama not running — start with: ollama serve" : err.message };
  }
}
