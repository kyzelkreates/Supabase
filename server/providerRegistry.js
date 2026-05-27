/**
 * providerRegistry.js
 * Server-side provider registry stub — optional future use.
 * RUN 1: Structure only. Active in RUN 2+ with Supabase integration.
 *
 * SSOT RULE: This file never reads or stores keys.
 * Keys live in the client vault only.
 */

/**
 * Returns the list of registered provider names.
 * In RUN 2+, this will read from Supabase for multi-user deployments.
 */
export function listProviders() {
  return [
    "groq",
    "openrouter",
    "together",
    "huggingface",
    "ollama",
    "deepseek"
  ];
}

/**
 * Validate a provider config object against the SSOT schema.
 * Returns { valid: boolean, errors: string[] }
 */
export function validateProvider(config) {
  const required = ["type", "enabled", "authType", "endpoint", "models"];
  const validTypes = ["cloud", "router", "inference", "local"];
  const validAuthTypes = ["apiKey", "none"];
  const errors = [];

  for (const field of required) {
    if (!(field in config)) errors.push(`Missing required field: ${field}`);
  }
  if (config.type && !validTypes.includes(config.type)) {
    errors.push(`Invalid type: ${config.type}. Must be one of: ${validTypes.join(", ")}`);
  }
  if (config.authType && !validAuthTypes.includes(config.authType)) {
    errors.push(`Invalid authType: ${config.authType}. Must be one of: ${validAuthTypes.join(", ")}`);
  }
  if (config.models && !Array.isArray(config.models)) {
    errors.push("models must be an array");
  }

  return { valid: errors.length === 0, errors };
}

// RUN 2: Add Supabase sync layer here
// RUN 4: Add routing preference storage here
