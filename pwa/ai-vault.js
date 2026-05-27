/**
 * ai-vault.js
 * Secure API key vault layer — all AI keys go through here.
 * Keys are NEVER used directly in other modules.
 * RUN 1: Vault read/write. Encryption upgrade in RUN 2.
 */

import { openDB } from "./vault.js";

const KEY_STORE = "ai_keys";
const KEY_RECORD_ID = "global_keys";

/**
 * Save AI provider keys to the vault.
 * Accepts a partial object — only keys provided are updated (others preserved).
 */
export async function saveAIKeys(keys) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, "readwrite");
    const store = tx.objectStore(KEY_STORE);

    // Merge with existing to avoid overwriting unrelated keys
    const getReq = store.get(KEY_RECORD_ID);
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      const updated = {
        ...existing,
        id: KEY_RECORD_ID,
        ...keys,
        updatedAt: new Date().toISOString()
      };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Retrieve all stored AI keys from the vault.
 * Returns an empty object if none are stored.
 */
export async function getAIKeys() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, "readonly");
    const req = tx.objectStore(KEY_STORE).get(KEY_RECORD_ID);
    req.onsuccess = () => resolve(req.result || {});
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get a single provider's key by name.
 * Returns null if not set.
 */
export async function getKeyForProvider(providerName) {
  const keys = await getAIKeys();
  return keys[providerName] || null;
}

/**
 * Clear a specific provider's key from the vault.
 */
export async function clearKeyForProvider(providerName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, "readwrite");
    const store = tx.objectStore(KEY_STORE);
    const getReq = store.get(KEY_RECORD_ID);
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      delete existing[providerName];
      existing.updatedAt = new Date().toISOString();
      const putReq = store.put(existing);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Check which providers currently have a key stored.
 * Returns array of provider names.
 */
export async function getKeyedProviders() {
  const keys = await getAIKeys();
  const reserved = ["id", "updatedAt"];
  return Object.keys(keys).filter(
    (k) => !reserved.includes(k) && keys[k] && keys[k].trim() !== ""
  );
}
