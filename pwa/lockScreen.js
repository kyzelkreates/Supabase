/**
 * lockScreen.js — PWA Entry Gate (RUN 6)
 *
 * Renders the lock screen when the vault is locked or session has expired.
 * Handles first-time setup (vault init) vs returning user (unlock) flows.
 * Never touches the dashboard — on success it reloads the page so
 * dashboard.js boots fresh with a valid session.
 *
 * SSOT Rules:
 * ✔ Pure UI controller — all auth delegated to authSession.js
 * ✔ Never reads or writes vault directly
 * ✔ Uses preflight-check source badge but doesn't gate on it (not a system action)
 * ❌ Never stores passphrase
 * ❌ Never shows passphrase in plaintext
 */

import {
  login,
  setupVault,
  loadSecurityConfig,
  getLockoutStatus,
  sessionSecondsRemaining,
  isVaultInitialised
} from "./authSession.js";

// ─── Entry Point ──────────────────────────────────────────────────────────────

/**
 * Check session and show lock screen if needed.
 * Called from dashboard.js BEFORE rendering any panel.
 *
 * @returns {Promise<boolean>} true = session valid, false = lock screen shown
 */
export async function guardSession() {
  await loadSecurityConfig();

  const { hasValidSession } = await import("./authSession.js");
  if (hasValidSession()) return true;

  await renderLockScreen();
  return false;
}

// ─── Lock Screen Renderer ─────────────────────────────────────────────────────

export async function renderLockScreen() {
  const initialised = await isVaultInitialised();
  const lockout     = getLockoutStatus();

  document.body.innerHTML = `
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        background: #0a0a12;
        color: #e2e2f0;
        font-family: 'Segoe UI', system-ui, sans-serif;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .lock-card {
        background: #10101e;
        border: 1px solid #252540;
        border-radius: 16px;
        padding: 2.5rem 2.25rem;
        width: 100%;
        max-width: 400px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.6);
      }
      .lock-logo {
        text-align: center;
        margin-bottom: 1.75rem;
      }
      .lock-logo .icon { font-size: 2.25rem; display: block; margin-bottom: 0.5rem; }
      .lock-logo h1 { font-size: 1.05rem; font-weight: 700; color: #a78bfa; letter-spacing: 0.06em; }
      .lock-logo p  { font-size: 0.75rem; color: #6b6b8f; margin-top: 0.2rem; }

      .tab-bar { display: flex; gap: 0.35rem; margin-bottom: 1.5rem; }
      .tab-btn {
        flex: 1;
        padding: 0.45rem;
        border-radius: 7px;
        border: 1px solid #252540;
        background: transparent;
        color: #6b6b8f;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
      }
      .tab-btn.active { background: #2d1b69; border-color: #a78bfa; color: #a78bfa; }

      .form-group { margin-bottom: 1rem; }
      .form-group label { display: block; font-size: 0.78rem; color: #6b6b8f; margin-bottom: 0.3rem; }
      input[type="password"], input[type="text"] {
        width: 100%;
        background: #16162a;
        border: 1px solid #252540;
        border-radius: 7px;
        padding: 0.6rem 0.85rem;
        color: #e2e2f0;
        font-size: 0.9rem;
        outline: none;
        transition: border-color 0.15s;
      }
      input:focus { border-color: #a78bfa; }

      .btn-unlock {
        width: 100%;
        padding: 0.7rem;
        background: #7c3aed;
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 0.9rem;
        font-weight: 700;
        cursor: pointer;
        transition: background 0.15s;
        margin-top: 0.25rem;
      }
      .btn-unlock:hover:not(:disabled) { background: #6d28d9; }
      .btn-unlock:disabled { opacity: 0.5; cursor: not-allowed; }

      .error-msg {
        background: #450a0a;
        border: 1px solid #ef4444;
        color: #ef4444;
        border-radius: 7px;
        padding: 0.55rem 0.85rem;
        font-size: 0.8rem;
        margin-bottom: 1rem;
        display: none;
      }
      .info-msg {
        background: #1e1b4b;
        border: 1px solid #a78bfa;
        color: #a78bfa;
        border-radius: 7px;
        padding: 0.55rem 0.85rem;
        font-size: 0.78rem;
        margin-bottom: 1rem;
      }
      .lockout-banner {
        background: #451a03;
        border: 1px solid #f59e0b;
        color: #f59e0b;
        border-radius: 7px;
        padding: 0.65rem 0.85rem;
        font-size: 0.8rem;
        margin-bottom: 1rem;
        text-align: center;
      }
      .attempts-hint { font-size: 0.72rem; color: #6b6b8f; margin-top: 0.4rem; text-align: center; }
      .show-pass-row { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.3rem; }
      .show-pass-row label { font-size: 0.75rem; color: #6b6b8f; cursor: pointer; margin: 0; }
      .footer-note { text-align: center; font-size: 0.7rem; color: #3b3b5e; margin-top: 1.5rem; }
    </style>

    <div class="lock-card">
      <div class="lock-logo">
        <span class="icon">🔐</span>
        <h1>AI VAULT OS</h1>
        <p>Secure Encrypted Vault</p>
      </div>

      <!-- Tab bar (only shown if vault initialised — otherwise setup only) -->
      ${initialised ? `
        <div class="tab-bar" id="tab-bar">
          <button class="tab-btn active" id="tab-unlock" onclick="window.__lock.switchTab('unlock')">Unlock</button>
          <button class="tab-btn" id="tab-setup" onclick="window.__lock.switchTab('setup')">Reset</button>
        </div>
      ` : `
        <div class="info-msg">👋 First time? Create a passphrase to encrypt your vault.</div>
      `}

      <!-- Lockout banner -->
      ${lockout.locked ? `
        <div class="lockout-banner" id="lockout-banner">
          🔒 Too many failed attempts.<br>
          <span id="lockout-timer">Try again in ${Math.ceil(lockout.remainingMs / 60000)} min</span>
        </div>
      ` : ""}

      <!-- Error message -->
      <div class="error-msg" id="error-msg"></div>

      <!-- Unlock form -->
      <div id="form-unlock" style="${!initialised ? "display:none" : ""}">
        <div class="form-group">
          <label>Vault Passphrase</label>
          <input type="password" id="unlock-pass" placeholder="Enter passphrase" autocomplete="current-password" />
          <div class="show-pass-row">
            <input type="checkbox" id="show-pass-cb" onchange="window.__lock.toggleShow('unlock-pass')">
            <label for="show-pass-cb">Show passphrase</label>
          </div>
        </div>
        <button class="btn-unlock" id="unlock-btn"
          ${lockout.locked ? "disabled" : ""}
          onclick="window.__lock.unlock()">
          🔓 Unlock Vault
        </button>
        <div class="attempts-hint" id="attempts-hint"></div>
      </div>

      <!-- Setup form -->
      <div id="form-setup" style="${initialised ? "display:none" : ""}">
        <div class="form-group">
          <label>Create Passphrase</label>
          <input type="password" id="setup-pass" placeholder="Min 6 characters" autocomplete="new-password" />
        </div>
        <div class="form-group">
          <label>Confirm Passphrase</label>
          <input type="password" id="setup-confirm" placeholder="Repeat passphrase" autocomplete="new-password" />
          <div class="show-pass-row">
            <input type="checkbox" id="show-setup-cb" onchange="window.__lock.toggleShow('setup-pass'); window.__lock.toggleShow('setup-confirm')">
            <label for="show-setup-cb">Show passphrase</label>
          </div>
        </div>
        <button class="btn-unlock" id="setup-btn" onclick="window.__lock.setup()">
          🔐 Create Vault
        </button>
      </div>

      <div class="footer-note">AES-256-GCM encrypted · Keys never leave this device</div>
    </div>
  `;

  // Start lockout countdown if active
  if (lockout.locked) _startLockoutCountdown(lockout.remainingMs);

  // Enter key on password fields
  const addEnter = (id, action) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") action(); });
  };
  addEnter("unlock-pass",   () => window.__lock.unlock());
  addEnter("setup-confirm", () => window.__lock.setup());

  window.__lock = {
    switchTab: (tab) => {
      const isUnlock = tab === "unlock";
      document.getElementById("form-unlock").style.display = isUnlock ? "" : "none";
      document.getElementById("form-setup").style.display  = isUnlock ? "none" : "";
      document.getElementById("tab-unlock")?.classList.toggle("active",  isUnlock);
      document.getElementById("tab-setup")?.classList.toggle("active",  !isUnlock);
      _clearError();
    },

    toggleShow: (inputId) => {
      const el = document.getElementById(inputId);
      if (el) el.type = el.type === "password" ? "text" : "password";
    },

    unlock: async () => {
      const pass = document.getElementById("unlock-pass")?.value;
      if (!pass) { _showError("Enter your passphrase"); return; }
      _setBusy("unlock-btn", true, "Unlocking…");
      _clearError();

      const result = await login(pass);
      if (result.ok) {
        location.reload();
      } else {
        _showError(result.error);
        _setBusy("unlock-btn", false, "🔓 Unlock Vault");
        if (result.attemptsRemaining !== undefined) {
          const hint = document.getElementById("attempts-hint");
          if (hint) hint.textContent = `${result.attemptsRemaining} attempt(s) remaining`;
        }
        if (result.reason === "locked_out") {
          _startLockoutCountdown(result.remainingLockoutMs);
          document.getElementById("unlock-btn").disabled = true;
        }
      }
    },

    setup: async () => {
      const pass    = document.getElementById("setup-pass")?.value;
      const confirm = document.getElementById("setup-confirm")?.value;
      _setBusy("setup-btn", true, "Creating vault…");
      _clearError();

      const result = await setupVault(pass, confirm);
      if (result.ok) {
        location.reload();
      } else {
        _showError(result.error);
        _setBusy("setup-btn", false, "🔐 Create Vault");
      }
    }
  };

  // Auto-focus
  setTimeout(() => {
    const el = document.getElementById(initialised ? "unlock-pass" : "setup-pass");
    el?.focus();
  }, 50);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _showError(msg) {
  const el = document.getElementById("error-msg");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
}

function _clearError() {
  const el = document.getElementById("error-msg");
  if (el) el.style.display = "none";
}

function _setBusy(btnId, busy, label) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled  = busy;
  btn.innerHTML = busy ? `<span style="animation:spin 0.8s linear infinite;display:inline-block">⟳</span> ${label}` : label;
}

function _startLockoutCountdown(remainingMs) {
  const timerEl = document.getElementById("lockout-timer");
  if (!timerEl) return;
  const end = Date.now() + remainingMs;
  const tick = () => {
    const left = Math.max(0, end - Date.now());
    if (left === 0) {
      location.reload(); // Re-render lock screen without lockout banner
      return;
    }
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    timerEl.textContent = `Try again in ${mins}:${String(secs).padStart(2,"0")}`;
    setTimeout(tick, 1000);
  };
  tick();
}
