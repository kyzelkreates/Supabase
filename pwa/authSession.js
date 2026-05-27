/**
 * authSession.js — Session Access Control (RUN 6, patched RUN 7.5+)
 *
 * Manages auth state, session expiry, and lockout policy.
 * PATCH: Added _createGuestSession() for first-visit / no-vault mode.
 * Guest sessions have no vault access but let the dashboard load freely.
 */

import { unlockVault, lockVault, isVaultInitialised } from "./secureVault.js";

const SESSION_KEY     = "av_session_token";
const SESSION_EXP_KEY = "av_session_expiry";
const SESSION_GUEST   = "av_guest_session";
const FAIL_KEY        = "av_failed_attempts";

let _config = {
  maxAttempts:       5,
  lockoutDurationMs: 300_000,
  sessionDurationMs: 3_600_000
};

// ─── Config ───────────────────────────────────────────────────────────────────

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
  } catch { /* use defaults */ }
}

// ─── Session ──────────────────────────────────────────────────────────────────

export function hasValidSession() {
  try {
    // Guest session counts as valid
    if (sessionStorage.getItem(SESSION_GUEST) === "1") return true;
    const token  = sessionStorage.getItem(SESSION_KEY);
    const expiry = sessionStorage.getItem(SESSION_EXP_KEY);
    if (!token || !expiry) return false;
    if (Date.now() > parseInt(expiry, 10)) { _clearSession(); return false; }
    return true;
  } catch { return false; }
}

export function sessionSecondsRemaining() {
  try {
    if (sessionStorage.getItem(SESSION_GUEST) === "1") return 86400;
    const expiry = sessionStorage.getItem(SESSION_EXP_KEY);
    if (!expiry) return 0;
    return Math.max(0, Math.floor((parseInt(expiry, 10) - Date.now()) / 1000));
  } catch { return 0; }
}

/** Create a guest session (no vault unlock required). */
export function _createGuestSession() {
  try { sessionStorage.setItem(SESSION_GUEST, "1"); } catch {}
}

export function _createSession() {
  try {
    sessionStorage.removeItem(SESSION_GUEST);
    sessionStorage.setItem(SESSION_KEY, _randomToken());
    sessionStorage.setItem(SESSION_EXP_KEY, String(Date.now() + _config.sessionDurationMs));
  } catch {}
}

function _clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_EXP_KEY);
    sessionStorage.removeItem(SESSION_GUEST);
  } catch {}
}

// ─── Lockout ──────────────────────────────────────────────────────────────────

export function getLockoutStatus() {
  try {
    const lockoutUntil = parseInt(sessionStorage.getItem("av_lockout_until") || "0", 10);
    if (!lockoutUntil || Date.now() > lockoutUntil) return { locked: false, remainingMs: 0 };
    return { locked: true, remainingMs: lockoutUntil - Date.now() };
  } catch { return { locked: false, remainingMs: 0 }; }
}

// ─── Login / Setup ────────────────────────────────────────────────────────────

export async function login(password) {
  const lockout = getLockoutStatus();
  if (lockout.locked) return {
    ok: false,
    error: `Locked for ${Math.ceil(lockout.remainingMs / 60000)} more minute(s).`,
    reason: "locked_out",
    remainingLockoutMs: lockout.remainingMs
  };

  let initialised = false;
  try { initialised = await isVaultInitialised(); } catch {}
  if (!initialised) return { ok: false, error: "Vault not set up yet", reason: "not_initialised" };

  const result = await unlockVault(password);
  if (!result.ok) return _handleFailedAttempt(result);

  _createSession();
  _resetFailedAttempts();
  return { ok: true };
}

export async function setupVault(password, confirmPassword) {
  if (!password || password.length < 6)
    return { ok: false, error: "Passphrase must be at least 6 characters" };
  if (password !== confirmPassword)
    return { ok: false, error: "Passphrases do not match" };

  let already = false;
  try { already = await isVaultInitialised(); } catch {}
  if (already) return { ok: false, error: "Vault already initialised — use login instead" };

  const { initVault } = await import("./secureVault.js");
  const result = await initVault(password);
  if (!result.ok) return { ok: false, error: result.error };

  _createSession();
  _resetFailedAttempts();
  return { ok: true };
}

export function logout() {
  try { lockVault(); } catch {}
  _clearSession();
}

export function extendSession() {
  try {
    if (sessionStorage.getItem(SESSION_GUEST) === "1") return;
    if (!hasValidSession()) return;
    sessionStorage.setItem(SESSION_EXP_KEY, String(Date.now() + _config.sessionDurationMs));
  } catch {}
}

export { isVaultInitialised };

// ─── Internal ─────────────────────────────────────────────────────────────────

function _handleFailedAttempt(unlockResult) {
  try {
    const prev    = parseInt(sessionStorage.getItem(FAIL_KEY) || "0", 10);
    const current = prev + 1;
    sessionStorage.setItem(FAIL_KEY, String(current));
    const remaining = Math.max(0, _config.maxAttempts - current);
    if (current >= _config.maxAttempts) {
      const lockoutUntil = Date.now() + _config.lockoutDurationMs;
      sessionStorage.setItem("av_lockout_until", String(lockoutUntil));
      return { ok: false, error: `Too many attempts. Locked for ${_config.lockoutDurationMs / 60000} min.`, reason: "locked_out", remainingLockoutMs: _config.lockoutDurationMs };
    }
    return { ok: false, error: `Wrong passphrase. ${remaining} attempt(s) remaining.`, reason: "wrong_password", attemptsRemaining: remaining };
  } catch {
    return { ok: false, error: unlockResult.error || "Authentication failed", reason: "wrong_password" };
  }
}

function _resetFailedAttempts() {
  try { sessionStorage.setItem(FAIL_KEY, "0"); sessionStorage.removeItem("av_lockout_until"); } catch {}
}

function _randomToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
