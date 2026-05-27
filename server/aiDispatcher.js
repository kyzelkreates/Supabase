/**
 * aiDispatcher.js — Execution Layer (RUN 2)
 *
 * Handles the actual HTTP calls to AI providers.
 * Consumed exclusively by aiRouter.js — never called directly from the app.
 *
 * SSOT Rules:
 * ✔ Reads provider config from RUN 1 (ssot/aiProviders.json)
 * ✔ Receives keys from router — never reads vault directly
 * ❌ Never stores state
 * ❌ Never defines fallback logic (aiFallback.js owns that)
 */

import PROVIDERS from "../ssot/aiProviders.json" assert { type: "json" };

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Dispatch a prompt to a named provider.
 *
 * @param {string} name     - Provider name (must exist in ssot/aiProviders.json)
 * @param {string} prompt   - User prompt
 * @param {object} keys     - Key map from vault { groq: "...", deepseek: "...", ... }
 * @param {string} [model]  - Optional model override (defaults to provider's first model)
 * @returns {Promise<string>} - Raw text response from the provider
 */
export async function callProvider(name, prompt, keys, model) {
  const provider = PROVIDERS.providers[name];
  if (!provider) throw new Error(`[aiDispatcher] Unknown provider: "${name}"`);

  const selectedModel = model || provider.models[0];
  const apiKey = keys[name] || "";

  switch (provider.type) {
    case "local":
      return callOllama(provider, prompt, selectedModel);

    case "inference":
      return callHuggingFace(provider, apiKey, prompt, selectedModel);

    case "cloud":
    case "router":
    default:
      return callOpenAICompat(provider, apiKey, prompt, selectedModel);
  }
}

// ─── OpenAI-compatible (Groq, OpenRouter, DeepSeek, Together) ────────────────

async function callOpenAICompat(provider, apiKey, prompt, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(provider.endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter requires this for attribution
        ...(provider.endpoint.includes("openrouter") && {
          "HTTP-Referer": "https://ai-vault-os.local",
          "X-Title": "AI Vault OS"
        })
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`[aiDispatcher] ${provider.endpoint} → HTTP ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`[aiDispatcher] Empty or unexpected response from ${model}`);
  return content;
}

// ─── Ollama (local) ───────────────────────────────────────────────────────────

async function callOllama(provider, prompt, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${provider.endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`[aiDispatcher] Ollama → HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data.response) throw new Error("[aiDispatcher] Ollama returned no response");
  return data.response;
}

// ─── HuggingFace Inference API ────────────────────────────────────────────────

async function callHuggingFace(provider, apiKey, prompt, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  const endpoint = `${provider.endpoint}/${model}`;

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ inputs: prompt }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`[aiDispatcher] HuggingFace → HTTP ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  // HF returns array or object depending on task
  if (Array.isArray(data)) return data[0]?.generated_text || "";
  return data?.generated_text || JSON.stringify(data);
}
