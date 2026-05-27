/**
 * secureVault.js — Encrypted IndexedDB Storage Layer (RUN 6)
 *
 * Wraps IndexedDB with AES-GCM encryption for all sensitive values.
 * The session key lives only in memory — never persisted.
 * Salt is persisted alongside ciphertext (not secret, required for decryption).
 *
 * Storage schema (IndexedDB "secure_store"):
 *   { key: string, ciphertext: string, iv: string, salt: string, version: number }
 *
 * SSOT Rules:
 * ✔ All crypto delegated to cryptoLayer.js
 * ✔ Session key is memory-only (cleared on lock/reload)
 * ✔ Returns structured { ok, error } on unlock — never throws to caller
 * ✔ openDB() sourced from db.js (RUN 0)
 * ❌ Never stores plaintext values
 * ❌ Never stores the passphrase or session key
 */

import { deriveKey, encryptData, decryptData, generateSalt, encodeSalt, decodeSalt, hashPassword, CryptoDecryptError } from "./cryptoLayer.js";
import { openDB } from "./db.js";

const STORE_NAME    = "secure_store";
const VAULT_META_KEY = "__vault_meta__"; // Stores salt + password hash for verification

// ─── Session State (memory-only) ──────────────────────────────────────────────

let _sessionKey  = null;  // CryptoKey — derived from passphrase on unlock
let _sessionSalt = null;  // Uint8Array — loaded from vault meta on unlock

// ─── Vault Initialisation ─────────────────────────────────────────────────────

/**
 * Initialise the vault with a new passphrase.
 * Must be called once on first use (before any unlock).
 * Stores a password hash + salt for future verification.
 *
 * @param {string} password
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function initVault(password) {
  if (!password || password.length < 6) {
    return { ok: false, error: "Passphrase must be at least 6 characters" };
  }

  try {
    const salt    = generateSalt();
    const hash    = await hashPassword(password, salt);
    const key     = await deriveKey(password, salt);

    // Encrypt the verification hash (proves key correctness on future unlocks)
    const payload = await encryptData({ hash, initialized: true }, key);

    const db = await openDB();
    await _idbPut(db, STORE_NAME, {
      key:        VAULT_META_KEY,
      ciphertext: payload.ciphertext,
      iv:         payload.iv,
      salt:       encodeSalt(salt),
      version:    1
    });

    // Activate session
    _sessionKey  = key;
    _sessionSalt = salt;

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Check if the vault has been initialised (meta record exists).
 *
 * @returns {Promise<boolean>}
 */
export async function isVaultInitialised() {
  try {
    const db  = await openDB();
    const rec = await _idbGet(db, STORE_NAME, VAULT_META_KEY);
    return !!rec;
  } catch { return false; }
}

// ─── Unlock / Lock ────────────────────────────────────────────────────────────

/**
 * Unlock the vault with a passphrase.
 * Derives a session key and verifies it against the stored hash.
 *
 * @param {string} password
 * @returns {Promise<UnlockResult>}
 *
 * @typedef {object} UnlockResult
 * @property {boolean} ok
 * @property {string}  [error]
 * @property {"wrong_password"|"not_initialised"|"corrupted"|"unknown"} [reason]
 */
export async function unlockVault(password) {
  if (!password) return { ok: false, error: "Passphrase required", reason: "wrong_password" };

  try {
    const db  = await openDB();
    const rec = await _idbGet(db, STORE_NAME, VAULT_META_KEY);

    if (!rec) {
      return { ok: false, error: "Vault not initialised — call initVault() first", reason: "not_initialised" };
    }

    const salt = decodeSalt(rec.salt);
    const key  = await deriveKey(password, salt);

    // Verify: try to decrypt the meta payload
    let meta;
    try {
      meta = await decryptData({ ciphertext: rec.ciphertext, iv: rec.iv }, key);
    } catch (e) {
      if (e instanceof CryptoDecryptError) {
        return { ok: false, error: "Wrong passphrase", reason: "wrong_password" };
      }
      return { ok: false, error: `Vault data corrupted: ${e.message}`, reason: "corrupted" };
    }

    if (!meta?.initialized) {
      return { ok: false, error: "Vault meta invalid", reason: "corrupted" };
    }

    // Activate session key
    _sessionKey  = key;
    _sessionSalt = salt;

    return { ok: true };

  } catch (err) {
    return { ok: false, error: err.message, reason: "unknown" };
  }
}

/**
 * Lock the vault — clears session key from memory.
 * All subsequent reads/writes will fail until unlocked again.
 */
export function lockVault() {
  _sessionKey  = null;
  _sessionSalt = null;
}

/**
 * Check if vault is currently unlocked (session key in memory).
 */
export function isUnlocked() {
  return _sessionKey !== null;
}

// ─── Secure Read / Write ──────────────────────────────────────────────────────

/**
 * Encrypt and save a value under a key.
 *
 * @param {string} key   - Logical key name
 * @param {any}    value - Any JSON-serializable value
 * @returns {Promise<void>}
 * @throws {Error} if vault is locked
 */
export async function saveSecure(key, value) {
  _assertUnlocked();
  if (!key || typeof key !== "string") throw new Error("saveSecure: key must be a non-empty string");

  const payload = await encryptData(value, _sessionKey);
  const db = await openDB();

  await _idbPut(db, STORE_NAME, {
    key,
    ciphertext: payload.ciphertext,
    iv:         payload.iv,
    salt:       encodeSalt(_sessionSalt),
    version:    payload.version
  });
}

/**
 * Retrieve and decrypt a value by key.
 *
 * @param {string} key
 * @returns {Promise<any|null>} Decrypted value or null if not found
 * @throws {Error} if vault is locked or decryption fails
 */
export async function getSecure(key) {
  _assertUnlocked();

  const db  = await openDB();
  const rec = await _idbGet(db, STORE_NAME, key);
  if (!rec) return null;

  return decryptData({ ciphertext: rec.ciphertext, iv: rec.iv }, _sessionKey);
}

/**
 * Delete a secure record by key.
 *
 * @param {string} key
 */
export async function deleteSecure(key) {
  _assertUnlocked();
  const db = await openDB();
  await _idbDelete(db, STORE_NAME, key);
}

/**
 * List all stored secure keys (not values — safe to expose).
 *
 * @returns {Promise<string[]>}
 */
export async function listSecureKeys() {
  _assertUnlocked();
  const db  = await openDB();
  const all = await _idbGetAll(db, STORE_NAME);
  return all.map((r) => r.key).filter((k) => k !== VAULT_META_KEY);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _assertUnlocked() {
  if (!_sessionKey) throw new Error("Vault is locked — call unlockVault() first");
}

function _idbPut(db, store, value) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, "readwrite").objectStore(store).put(value);
    req.onsuccess = () => res();
    req.onerror   = (e) => rej(e.target.error);
  });
}

function _idbGet(db, store, key) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = (e) => res(e.target.result || null);
    req.onerror   = (e) => rej(e.target.error);
  });
}

function _idbDelete(db, store, key) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, "readwrite").objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror   = (e) => rej(e.target.error);
  });
}

function _idbGetAll(db, store) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = (e) => res(e.target.result || []);
    req.onerror   = (e) => rej(e.target.error);
  });
}
