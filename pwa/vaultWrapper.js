/**
 * vaultWrapper.js — Secure Vault Public API (RUN 6)
 *
 * The ONLY module that application code (aiPanel, installPanel, settings.js)
 * should use to read/write sensitive data.
 *
 * Provides named, typed accessors for all system secrets:
 *   - AI provider keys (replaces plaintext ai-vault.js for sensitive writes)
 *   - Supabase project credentials
 *   - Generic secure config values
 *
 * SSOT Rules:
 * ✔ All reads/writes delegated to secureVault.js
 * ✔ Key naming is canonicalized here — one source of truth for key names
 * ✔ Returns typed, null-safe results
 * ❌ Never stores values in plaintext
 * ❌ Never exposes session key or CryptoKey objects
 */

import {
  saveSecure,
  getSecure,
  deleteSecure,
  listSecureKeys,
  isUnlocked
} from "./secureVault.js";

// ─── Key Name Registry ────────────────────────────────────────────────────────
// All vault key names live here — never hardcoded in callers

const KEY = {
  aiProvider:   (name)    => `ai_key_${name.toLowerCase()}`,
  supabaseRef:  (project) => `sb_ref_${project}`,
  supabasePwd:  (project) => `sb_pwd_${project}`,
  customSecret: (name)    => `custom_${name}`
};

// ─── AI Provider Keys ─────────────────────────────────────────────────────────

/**
 * Save an AI provider API key (encrypted).
 *
 * @param {string} provider - e.g. "groq", "openrouter", "deepseek"
 * @param {string} apiKey
 * @returns {Promise<void>}
 */
export async function saveAIKey(provider, apiKey) {
  _assertString(provider, "provider");
  _assertString(apiKey,   "apiKey");
  await saveSecure(KEY.aiProvider(provider), { apiKey, provider, savedAt: new Date().toISOString() });
}

/**
 * Retrieve an AI provider API key.
 *
 * @param {string} provider
 * @returns {Promise<string|null>} The raw API key string, or null
 */
export async function getAIKey(provider) {
  _assertString(provider, "provider");
  const record = await getSecure(KEY.aiProvider(provider));
  return record?.apiKey ?? null;
}

/**
 * Delete an AI provider key from the vault.
 *
 * @param {string} provider
 */
export async function deleteAIKey(provider) {
  _assertString(provider, "provider");
  await deleteSecure(KEY.aiProvider(provider));
}

/**
 * Get all AI keys as a provider → apiKey map.
 * Used by aiRouter.js to build its key bundle for dispatch.
 *
 * @returns {Promise<Record<string, string>>}
 */
export async function getAllAIKeys() {
  const keys     = await listSecureKeys();
  const aiKeys   = keys.filter((k) => k.startsWith("ai_key_"));
  const result   = {};
  for (const k of aiKeys) {
    const record = await getSecure(k);
    if (record?.apiKey && record?.provider) {
      result[record.provider] = record.apiKey;
    }
  }
  return result;
}

/**
 * List provider names that have keys stored (not the keys themselves).
 *
 * @returns {Promise<string[]>}
 */
export async function listAIKeyProviders() {
  const keys = await listSecureKeys();
  return keys
    .filter((k) => k.startsWith("ai_key_"))
    .map((k) => k.replace("ai_key_", ""));
}

// ─── Supabase Project Credentials ────────────────────────────────────────────

/**
 * Save a Supabase project's ref and DB password (encrypted).
 *
 * @param {string} projectName
 * @param {string} ref         - Supabase project reference ID
 * @param {string} [password]  - DB password (optional)
 */
export async function saveSupabaseCredentials(projectName, ref, password = null) {
  _assertString(projectName, "projectName");
  _assertString(ref, "ref");
  await saveSecure(KEY.supabaseRef(projectName), { ref, projectName, savedAt: new Date().toISOString() });
  if (password) {
    await saveSecure(KEY.supabasePwd(projectName), { password, projectName, savedAt: new Date().toISOString() });
  }
}

/**
 * Retrieve Supabase credentials for a project.
 *
 * @param {string} projectName
 * @returns {Promise<{ ref: string, password: string|null } | null>}
 */
export async function getSupabaseCredentials(projectName) {
  _assertString(projectName, "projectName");
  const refRecord = await getSecure(KEY.supabaseRef(projectName));
  if (!refRecord) return null;
  const pwdRecord = await getSecure(KEY.supabasePwd(projectName));
  return {
    ref:      refRecord.ref,
    password: pwdRecord?.password ?? null
  };
}

/**
 * Delete all Supabase credentials for a project.
 */
export async function deleteSupabaseCredentials(projectName) {
  await deleteSecure(KEY.supabaseRef(projectName));
  await deleteSecure(KEY.supabasePwd(projectName));
}

// ─── Generic Secure Config ────────────────────────────────────────────────────

/**
 * Save any named secret value.
 *
 * @param {string} name
 * @param {any}    value
 */
export async function saveSecret(name, value) {
  _assertString(name, "name");
  await saveSecure(KEY.customSecret(name), value);
}

/**
 * Retrieve a named secret value.
 *
 * @param {string} name
 * @returns {Promise<any|null>}
 */
export async function getSecret(name) {
  _assertString(name, "name");
  return getSecure(KEY.customSecret(name));
}

// ─── Vault Status ─────────────────────────────────────────────────────────────

/**
 * Check if vault is currently unlocked and ready for reads/writes.
 */
export { isUnlocked };

/**
 * Get a summary of what's stored (no sensitive values).
 *
 * @returns {Promise<VaultSummary>}
 *
 * @typedef {object} VaultSummary
 * @property {string[]} aiProviders    - Provider names with stored keys
 * @property {string[]} supabaseProjects - Project names with stored refs
 * @property {string[]} customSecrets  - Custom secret names
 * @property {boolean}  unlocked
 * @property {number}   totalKeys
 */
export async function getVaultSummary() {
  const unlocked = isUnlocked();
  if (!unlocked) {
    return { aiProviders: [], supabaseProjects: [], customSecrets: [], unlocked: false, totalKeys: 0 };
  }

  const keys = await listSecureKeys();

  const aiProviders    = keys.filter((k) => k.startsWith("ai_key_")).map((k) => k.replace("ai_key_",""));
  const supabaseRefs   = keys.filter((k) => k.startsWith("sb_ref_")).map((k) => k.replace("sb_ref_",""));
  const customSecrets  = keys.filter((k) => k.startsWith("custom_")).map((k) => k.replace("custom_",""));

  return { aiProviders, supabaseProjects: supabaseRefs, customSecrets, unlocked: true, totalKeys: keys.length };
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _assertString(val, name) {
  if (!val || typeof val !== "string" || !val.trim()) {
    throw new Error(`vaultWrapper: "${name}" must be a non-empty string`);
  }
}
