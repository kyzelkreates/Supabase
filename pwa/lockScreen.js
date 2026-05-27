/**
 * lockScreen.js — PWA Entry Gate (RUN 6, patched RUN 7.5+)
 *
 * PATCH: On static Vercel deployments with no vault initialised,
 * guardSession() now auto-creates a lightweight session so the dashboard
 * loads immediately. The full lock/unlock flow is available via Settings.
 *
 * First visit:  no vault → auto-session → dashboard loads
 * Return visit: valid session token in sessionStorage → pass through
 * Locked vault: vault exists + session expired → show lock screen
 */

import {
  login,
  setupVault,
  loadSecurityConfig,
  getLockoutStatus,
  hasValidSession,
  isVaultInitialised,
  _createGuestSession
} from "./authSession.js";

// ─── Entry Point ──────────────────────────────────────────────────────────────

export async function guardSession() {
  try {
    await loadSecurityConfig();
  } catch { /* non-fatal */ }

  // Already have a valid session → pass through
  try {
    if (hasValidSession()) return true;
  } catch { /* sessionStorage unavailable */ }

  // Check if vault has been set up by this user
  let initialised = false;
  try {
    initialised = await isVaultInitialised();
  } catch { /* IndexedDB unavailable — treat as not initialised */ }

  // No vault yet → create a guest session so dashboard loads freely
  if (!initialised) {
    try { _createGuestSession(); } catch { /* ignore */ }
    return true;
  }

  // Vault exists but session expired → show lock screen
  await renderLockScreen();
  return false;
}

// ─── Lock Screen Renderer ─────────────────────────────────────────────────────

export async function renderLockScreen() {
  const lockout = getLockoutStatus();

  document.body.innerHTML = `
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        background: #0a0a12; color: #e2e2f0;
        font-family: 'Segoe UI', system-ui, sans-serif;
        min-height: 100vh; display: flex; align-items: center; justify-content: center;
      }
      .lock-card {
        background: #10101e; border: 1px solid #252540; border-radius: 16px;
        padding: 2.5rem 2.25rem; width: 100%; max-width: 400px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.6);
      }
      .lock-logo { text-align: center; margin-bottom: 1.75rem; }
      .lock-logo .icon { font-size: 2.25rem; display: block; margin-bottom: 0.5rem; }
      .lock-logo h1 { font-size: 1.05rem; font-weight: 700; color: #a78bfa; letter-spacing: 0.06em; }
      .lock-logo p  { font-size: 0.75rem; color: #6b6b8f; margin-top: 0.2rem; }
      .form-group { margin-bottom: 1rem; }
      .form-group label { display: block; font-size: 0.78rem; color: #6b6b8f; margin-bottom: 0.3rem; }
      input[type="password"] {
        width: 100%; background: #16162a; border: 1px solid #252540; border-radius: 7px;
        padding: 0.6rem 0.85rem; color: #e2e2f0; font-size: 0.9rem; outline: none; transition: border-color 0.15s;
      }
      input:focus { border-color: #a78bfa; }
      .btn-unlock {
        width: 100%; padding: 0.7rem; background: #7c3aed; color: #fff; border: none;
        border-radius: 8px; font-size: 0.9rem; font-weight: 700; cursor: pointer; transition: background 0.15s;
      }
      .btn-unlock:hover:not(:disabled) { background: #6d28d9; }
      .btn-unlock:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn-skip {
        width: 100%; padding: 0.55rem; margin-top: 0.6rem; background: transparent;
        border: 1px solid #252540; border-radius: 8px; color: #6b6b8f;
        font-size: 0.82rem; cursor: pointer; transition: border-color 0.15s;
      }
      .btn-skip:hover { border-color: #a78bfa; color: #a78bfa; }
      .error-msg {
        background: #450a0a; border: 1px solid #ef4444; color: #ef4444;
        border-radius: 7px; padding: 0.55rem 0.85rem; font-size: 0.8rem; margin-bottom: 1rem; display: none;
      }
      .footer-note { text-align: center; font-size: 0.7rem; color: #3b3b5e; margin-top: 1.5rem; }
    </style>
    <div class="lock-card">
      <div class="lock-logo">
        <span class="icon">🔐</span>
        <h1>AI VAULT OS</h1>
        <p>Session expired — unlock to continue</p>
      </div>
      <div class="error-msg" id="error-msg"></div>
      <div class="form-group">
        <label>Vault Passphrase</label>
        <input type="password" id="unlock-pass" placeholder="Enter passphrase"
          autocomplete="current-password"
          ${lockout.locked ? "disabled" : ""} />
      </div>
      <button class="btn-unlock" id="unlock-btn"
        ${lockout.locked ? "disabled" : ""}
        onclick="window.__lock.unlock()">
        🔓 Unlock Vault
      </button>
      <button class="btn-skip" onclick="window.__lock.skip()">
        Continue without unlocking (read-only)
      </button>
      <div class="footer-note">AES-256-GCM encrypted · Keys never leave this device</div>
    </div>
  `;

  document.getElementById("unlock-pass")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") window.__lock.unlock();
  });

  window.__lock = {
    unlock: async () => {
      const pass = document.getElementById("unlock-pass")?.value;
      if (!pass) { _showError("Enter your passphrase"); return; }
      const btn = document.getElementById("unlock-btn");
      btn.disabled = true; btn.textContent = "Unlocking…";
      const result = await login(pass);
      if (result.ok) { location.reload(); }
      else {
        _showError(result.error);
        btn.disabled = false; btn.textContent = "🔓 Unlock Vault";
      }
    },
    skip: () => {
      try { _createGuestSession(); } catch {}
      location.reload();
    }
  };
}

function _showError(msg) {
  const el = document.getElementById("error-msg");
  if (el) { el.textContent = msg; el.style.display = "block"; }
}
