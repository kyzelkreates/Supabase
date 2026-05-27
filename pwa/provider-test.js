/**
 * provider-test.js
 * Health check + test system for AI providers.
 * Reads keys from vault — never from direct input.
 * RUN 1: Connectivity tests only. Routing logic added in RUN 4.
 */

import { getKeyForProvider } from "./ai-vault.js";

// Inline provider registry (mirrors ssot/aiProviders.json)
// Dynamic import of JSON with import assertions not universally supported —
// registry is maintained in sync with ssot/aiProviders.json until RUN 2 adds a loader.
const PROVIDERS = {
  groq: {
    type: "cloud",
    enabled: true,
    authType: "apiKey",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    models: ["llama-3.1-70b", "mixtral-8x7b"]
  },
  openrouter: {
    type: "router",
    enabled: true,
    authType: "apiKey",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    models: ["gpt-4o-mini", "claude-3-haiku", "deepseek/deepseek-chat"]
  },
  together: {
    type: "cloud",
    enabled: false,
    authType: "apiKey",
    endpoint: "https://api.together.xyz/v1/chat/completions",
    models: ["meta-llama/Llama-3-70b-chat-hf"]
  },
  huggingface: {
    type: "inference",
    enabled: false,
    authType: "apiKey",
    endpoint: "https://api-inference.huggingface.co/models",
    models: ["mistralai/Mistral-7B-Instruct-v0.2"]
  },
  ollama: {
    type: "local",
    enabled: true,
    authType: "none",
    endpoint: "http://localhost:11434",
    models: ["llama3", "mistral"]
  },
  deepseek: {
    type: "cloud",
    enabled: true,
    authType: "apiKey",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    models: ["deepseek-chat", "deepseek-coder"]
  }
};

/**
 * Test a single provider.
 * Returns one of: "DISABLED" | "NO_KEY" | "OK" | "FAIL" | "ERROR"
 */
export async function testProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) return "UNKNOWN";
  if (!provider.enabled) return "DISABLED";

  const key = provider.authType === "apiKey" ? await getKeyForProvider(name) : null;
  if (provider.authType === "apiKey" && !key) return "NO_KEY";

  // Ollama: just ping the base endpoint
  if (provider.type === "local") {
    try {
      const res = await fetch(`${provider.endpoint}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(4000)
      });
      return res.ok ? "OK" : "FAIL";
    } catch {
      return "ERROR";
    }
  }

  // Cloud / router / inference: minimal chat completion ping
  try {
    const res = await fetch(provider.endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: provider.models[0],
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1
      }),
      signal: AbortSignal.timeout(8000)
    });
    return res.ok ? "OK" : "FAIL";
  } catch {
    return "ERROR";
  }
}

/**
 * Test all enabled providers and return a status map.
 * { groq: "OK", deepseek: "NO_KEY", ollama: "ERROR", ... }
 */
export async function testAllProviders() {
  const results = {};
  await Promise.all(
    Object.keys(PROVIDERS).map(async (name) => {
      results[name] = await testProvider(name);
    })
  );
  return results;
}

/**
 * Get the live registry (mirrors SSOT — read-only).
 */
export function getProviderRegistry() {
  return structuredClone(PROVIDERS);
}
