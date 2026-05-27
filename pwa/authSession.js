/**
 * authSession.js — Session Access Control (RUN 6)
 *
 * Manages authentication state, session expiry, and lockout policy.
 * All state lives in sessionStorage (tab-scoped) plus in-memory.
 * The securityState.json SSOT is the persisted record — never the auth truth.
 *
 * Security model:
 *   - Passphrase unlocks vault (cryptoLayer/secureVault)
 *   - Session token (random UUID) stored in sessionStorage
 *   - Session expires after sessionDurationMs (default 1h)
 *   - lockoutUntil prevents brute force (default 5min after 5 failures)
 *   - Failed attempts tracked in sessionStorage + persisted SSOT
 *
 * SSOT Rules:
 * ✔ Vault unlock delegated entirely to secureVault.js
 * ✔ Session truth is in-memory + sessionStorage (not IndexedDB)
 * ✔ Lockout state persisted to securityState.json via fetch (best-effort)
 * ✔ logout() always calls lockVault() — never leaves vault unlocked
 * ❌ Never stores passphrase anywhere
 * ❌ Never bypasses lockout check
 */

import { unlockVault, lockVault, isUnlocked, initVault, isVaultInitialised } from "./secureVault.js";

const SESSION_KEY     = "av_session_token";
const SESSION_EXP_KEY = "av_session_expiry";
const FAIL_KEY        = "av_failed_attempts";

// Defaults (overridden by securityState.json if available)
let _config = {
  maxAttempts:       5,
  lockoutDurationMs: 300_000,   // 5 minutes
  sessionDurationMs: 3_600_000  // 1 hour
};

// ─── Config Loader ────────────────────────────────────────────────────────────

/**
 * Load security config from SSOT (best-effort — safe to fail).
 * Called once at boot.
 */
export async function loadSecurityConfig() {
  try {
    const res = await fetch("../ssot/securityState.json");
    if (!res.ok) return;
    const json = await res.json();
    _config = {
      maxAttempts:       json.maxAttempts       ?? _config.maxAttempts,
      lockoutDurationMs: json.lockoutDurationMs ?? _config.lockoutDurationMs,
      sessionDurationMs: json.sessionDurationMs ?? _config.sessionDurationMs
    };
  } catch { /* Use defaults */ }
}

// ─── Session Check ────────────────────────────────────────────────────────────

/**
 * Check if the current tab has a valid, non-expired session.
 *
 * @returns {boolean}
 */
export function hasValidSession() {
  const token  = sessionStorage.getItem(SESSION_KEY);
  const expiry = sessionStorage.getItem(SESSION_EXP_KEY);
  if (!token || !expiry) return false;
  if (Date.now() > parseInt(expiry, 10)) {
    _clearSession();
    return false;
  }
  return true;
}

/**
 * Get seconds remaining in current session (0 if none).
 */
export function sessionSecondsRemaining() {
  const expiry = sessionStorage.getItem(SESSION_EXP_KEY);
  if (!expiry) return 0;
  return Math.max(0, Math.floor((parseInt(expiry, 10) - Date.now()) / 1000));
}

// ─── Lockout Check ────────────────────────────────────────────────────────────

/**
 * Check if the user is currently locked out (too many failed attempts).
 *
 * @returns {{ locked: boolean, remainingMs: number }}
 */
export function getLockoutStatus() {
  const lockoutUntil = parseInt(sessionStorage.getItem("av_lockout_until") || "0", 10);
  if (!lockoutUntil || Date.now() > lockoutUntil) return { locked: false, remainingMs: 0 };
  return { locked: true, remainingMs: lockoutUntil - Date.now() };
}

// ─── Login ────────────────────────────────────────────────────────────────────

/**
 * Attempt to authenticate with a passphrase.
 * Returns structured result — never throws.
 *
 * @param {string} password
 * @returns {Promise<LoginResult>}
 *
 * @typedef {object} LoginResult
 * @property {boolean} ok
 * @property {string}  [error]
 * @property {"locked_out"|"wrong_password"|"not_initialised"|"unknown"} [reason]
 * @property {number}  [remainingLockoutMs]
 * @property {number}  [attemptsRemaining]
 */
export async function login(password) {
  // Check lockout first
  const lockout = getLockoutStatus();
  if (lockout.locked) {
    return {
      ok:    false,
      error: `Too many failed attempts. Try again in ${Math.ceil(lockout.remainingMs / 60000)} minute(s).`,
      reason: "locked_out",
      remainingLockoutMs: lockout.remainingMs
    };
  }

  // Check if vault needs initialisation
  const initialised = await isVaultInitialised();
  if (!initialised) {
    return { ok: false, error: "Vault not set up — create a passphrase first", reason: "not_initialised" };
  }

  // Attempt vault unlock
  const result = await unlockVault(password);

  if (!result.ok) {
    return _handleFailedAttempt(result);
  }

  // Success — create session
  _createSession();
  _resetFailedAttempts();
  await _persistSecurityState({ authenticated: true, locked: false, failedAttempts: 0, lockoutUntil: null });

  return { ok: true };
}

/**
 * Create a new vault with the given passphrase (first-time setup).
 *
 * @param {string} password
 * @param {string} confirmPassword
 * @returns {Promise<LoginResult>}
 */
export async function setupVault(password, confirmPassword) {
  if (!password || password.length < 6) {
    return { ok: false, error: "Passphrase must be at least 6 characters", reason: "unknown" };
  }
  if (password !== confirmPassword) {
    return { ok: false, error: "Passphrases do not match", reason: "unknown" };
  }

  const already = await isVaultInitialised();
  if (already) {
    return { ok: false, error: "Vault already initialised — use login instead", reason: "unknown" };
  }

  const result = await initVault(password);
  if (!result.ok) return { ok: false, error: result.error, reason: "unknown" };

  _createSession();
  _resetFailedAttempts();
  await _persistSecurityState({ vaultInitialised: true, authenticated: true, locked: false, failedAttempts: 0 });

  return { ok: true };
}

// ─── Logout / Lock ────────────────────────────────────────────────────────────

/**
 * Log out and lock the vault.
 * Always safe to call — even if not logged in.
 */
export function logout() {
  lockVault();
  _clearSession();
  _persistSecurityState({ authenticated: false, locked: true }).catch(() => {});
}

/**
 * Extend the current session by sessionDurationMs.
 * Called on user activity to prevent premature timeout.
 */
export function extendSession() {
  if (!hasValidSession()) return;
  const newExpiry = Date.now() + _config.sessionDurationMs;
  sessionStorage.setItem(SESSION_EXP_KEY, String(newExpiry));
}

// ─── Vault Init Check ─────────────────────────────────────────────────────────

export { isVaultInitialised };

// ─── Internal ─────────────────────────────────────────────────────────────────

function _createSession() {
  const token  = _randomToken();
  const expiry = Date.now() + _config.sessionDurationMs;
  sessionStorage.setItem(SESSION_KEY, token);
  sessionStorage.setItem(SESSION_EXP_KEY, String(expiry));
}

function _clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_EXP_KEY);
}

function _resetFailedAttempts() {
  sessionStorage.setItem(FAIL_KEY, "0");
  sessionStorage.removeItem("av_lockout_until");
}

function _handleFailedAttempt(unlockResult) {
  const prev    = parseInt(sessionStorage.getItem(FAIL_KEY) || "0", 10);
  const current = prev + 1;
  sessionStorage.setItem(FAIL_KEY, String(current));

  const remaining = Math.max(0, _config.maxAttempts - current);

  if (current >= _config.maxAttempts) {
    const lockoutUntil = Date.now() + _config.lockoutDurationMs;
    sessionStorage.setItem("av_lockout_until", String(lockoutUntil));
    _persistSecurityState({ locked: true, failedAttempts: current, lockoutUntil }).catch(() => {});
    return {
      ok:    false,
      error: `Too many failed attempts. Locked for ${_config.lockoutDurationMs / 60000} minute(s).`,
      reason: "locked_out",
      remainingLockoutMs: _config.lockoutDurationMs
    };
  }

  _persistSecurityState({ failedAttempts: current }).catch(() => {});

  return {
    ok:    false,
    error: unlockResult.reason === "wrong_password"
      ? `Wrong passphrase. ${remaining} attempt(s) remaining.`
      : (unlockResult.error || "Authentication failed"),
    reason: unlockResult.reason || "wrong_password",
    attemptsRemaining: remaining
  };
}

function _randomToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function _persistSecurityState(patch) {
  try {
    const res = await fetch("../ssot/securityState.json");
    const current = res.ok ? await res.json() : {};
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    // Best-effort: works in Node/server context; in static PWA this is read-only
    await fetch("../ssot/securityState.json", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated, null, 2)
    });
  } catch { /* State file persistence is best-effort */ }
}
