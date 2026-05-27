/**
 * installPanel.js — Install Panel (RUN 5)
 *
 * UI for triggering RUN 3 installs and RUN 4 heal cycles.
 * Enforces RUN 4.1 gate before any execution.
 * Reads project context from sessionStorage (set by projectPanel.js "Install" button)
 * or lets operator enter a project manually.
 *
 * SSOT Rules:
 * ✔ Gate enforced before every install/heal trigger
 * ✔ All execution via server module imports (installController, healController)
 * ✔ Logs every action to logsPanel event bus
 * ❌ Never modifies installState.json or repairState.json directly
 * ❌ Never calls supabaseRunner.js directly
 */

import { showToast, esc } from "./dashboard.js";
import { preflight }      from "./preflight-check.js";

let _installController = null;
let _healController    = null;

async function getInstallController() {
  if (_installController) return _installController;
  try { _installController = await import("../server/installController.js"); }
  catch { _installController = _makeOfflineStub("installController"); }
  return _installController;
}

async function getHealController() {
  if (_healController) return _healController;
  try { _healController = await import("../server/healController.js"); }
  catch { _healController = _makeOfflineStub("healController"); }
  return _healController;
}

// ─── Panel Entry ─────────────────────────────────────────────────────────────

export async function loadInstallPanel(root, gateResult) {
  // Pre-fill from projectPanel's "Install" shortcut
  const savedTarget = _popInstallTarget();

  root.innerHTML = `
    <div class="panel-title">⚙️ Install Panel</div>

    <!-- Gate reminder -->
    <div id="install-gate-banner" class="card" style="border-color:${gateResult?.systemReady ? 'var(--ok)' : 'var(--fail)'};margin-bottom:1rem;">
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <span style="font-size:1.25rem;">${gateResult?.systemReady ? "✅" : "🚫"}</span>
        <div>
          <div style="font-weight:600;color:${gateResult?.systemReady ? 'var(--ok)' : 'var(--fail)'}">
            RUN 4.1 Gate: ${gateResult?.gate || "UNKNOWN"}
          </div>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.15rem;">
            ${gateResult?.systemReady
              ? "System healthy — install actions are enabled"
              : "Gate closed — resolve blocking issues before installing"}
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="window.__install.recheck()">↻ Re-check</button>
      </div>
      ${(gateResult?.blockingIssues?.length > 0) ? `
        <ul style="margin-top:0.65rem;padding-left:1.25rem;font-size:0.78rem;color:var(--fail);">
          ${gateResult.blockingIssues.map((i) => `<li>${esc(i)}</li>`).join("")}
        </ul>` : ""}
    </div>

    <!-- Project target -->
    <div class="card">
      <h3>Target Project</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-top:0.75rem;">
        <div class="form-group" style="margin:0">
          <label>Project Name</label>
          <input id="install-name" type="text" placeholder="my-app" value="${esc(savedTarget?.name || "")}" />
        </div>
        <div class="form-group" style="margin:0">
          <label>Supabase Project Ref</label>
          <input id="install-ref" type="text" placeholder="abcdefghijklmnop" value="${esc(savedTarget?.ref || "")}" />
        </div>
      </div>

      <div class="form-group" style="margin-top:0.75rem;">
        <label>DB Password <span style="color:#555;font-weight:400">(optional — stored in vault)</span></label>
        <input id="install-password" type="password" placeholder="••••••••" />
      </div>

      <div class="form-group">
        <label>AI-Generated SQL <span style="color:#555;font-weight:400">(optional — leave blank to use existing migrations/)</span></label>
        <textarea id="install-sql" placeholder="-- Paste AI-generated schema SQL here (optional)&#10;CREATE TABLE ..."></textarea>
      </div>

      <div style="display:flex;gap:0.5rem;margin-top:0.5rem;">
        <button class="btn btn-primary" id="install-btn"
          onclick="window.__install.run()"
          ${!gateResult?.systemReady ? "disabled" : ""}>
          ▶ Run Install (RUN 3)
        </button>
        <button class="btn btn-secondary" id="heal-btn"
          onclick="window.__install.heal()"
          ${!gateResult?.systemReady ? "disabled" : ""}>
          🔁 Trigger Heal (RUN 4)
        </button>
      </div>
    </div>

    <!-- Live output -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>Execution Output</h3>
        <button class="btn btn-secondary btn-sm" onclick="window.__install.clearLog()">Clear</button>
      </div>
      <div id="install-log" class="log-output">Ready. Configure target above and click Run Install.</div>
    </div>

    <!-- Last install state -->
    <div class="card">
      <h3>Last Install State</h3>
      <div id="install-state-display" style="margin-top:0.5rem;font-size:0.82rem;color:var(--text-muted)">Loading…</div>
    </div>
  `;

  await _renderInstallState();

  window.__install = {
    run:      runInstall,
    heal:     runHeal,
    recheck:  recheckGate,
    clearLog: () => { const l = document.getElementById("install-log"); if (l) l.textContent = "Log cleared."; }
  };
}

// ─── Install Action ───────────────────────────────────────────────────────────

async function runInstall() {
  const name     = document.getElementById("install-name")?.value.trim();
  const ref      = document.getElementById("install-ref")?.value.trim();
  const password = document.getElementById("install-password")?.value.trim();
  const sqlRaw   = document.getElementById("install-sql")?.value.trim();

  if (!name || !ref) { showToast("Project name and ref required", "err"); return; }

  // Re-verify gate
  const gate = await _rerunGate();
  if (!gate.systemReady) {
    showToast("🚫 Gate re-check failed — install blocked", "err");
    return;
  }

  _log(`[${_ts()}] ▶ Starting install: ${name} (${ref})`, "info");
  _setButtons(true);

  try {
    const ic = await getInstallController();
    const sqlMigrations = sqlRaw
      ? [{ description: "dashboard-provided-schema", sql: sqlRaw }]
      : [];

    const result = await ic.installProject({ name, ref, password, sqlMigrations });

    if (result.success) {
      _log(`[${_ts()}] ✔ Install complete in ${result.duration}. Attempts: ${result.attempts}`, "ok");
      showToast(`✅ Installed "${name}" in ${result.duration}`, "ok");
    } else {
      _log(`[${_ts()}] ✘ Install failed: ${result.error}`, "err");
      showToast(`Install failed: ${result.error}`, "err");
    }

    await _renderInstallState();

  } catch (err) {
    _log(`[${_ts()}] ✘ Unexpected error: ${err.message}`, "err");
    showToast(`Error: ${err.message}`, "err");
  } finally {
    _setButtons(false);
  }
}

// ─── Heal Action ──────────────────────────────────────────────────────────────

async function runHeal() {
  const name = document.getElementById("install-name")?.value.trim();
  const ref  = document.getElementById("install-ref")?.value.trim();

  if (!name) { showToast("Project name required for heal", "err"); return; }

  const errorLog = prompt("Paste the error log from the failed install (or leave blank to use last known error):", "");

  const gate = await _rerunGate();
  if (!gate.systemReady) { showToast("🚫 Gate blocked — heal cancelled", "err"); return; }

  _log(`[${_ts()}] 🔁 Triggering heal cycle for: ${name}`, "info");
  _setButtons(true);

  try {
    const hc = await getHealController();
    const result = await hc.handleFailure({
      errorLog: errorLog || "UNKNOWN_ERROR",
      sql: "",
      project: { name, ref },
      force: false
    });

    if (result.healed) {
      _log(`[${_ts()}] ✔ Healed in ${result.duration}. Attempts: ${result.totalAttempts}`, "ok");
      showToast(`✅ System healed in ${result.duration}`, "ok");
    } else {
      _log(`[${_ts()}] ✘ Heal failed: ${result.abortReason}`, "err");
      result.history?.forEach((h) => {
        _log(`  Attempt ${h.attempt}: ${h.errorType} via ${h.provider} — ${h.success ? "OK" : h.error}`, h.success ? "ok" : "err");
      });
      showToast(`Heal failed: ${result.abortReason}`, "err");
    }

  } catch (err) {
    _log(`[${_ts()}] ✘ ${err.message}`, "err");
    showToast(`Error: ${err.message}`, "err");
  } finally {
    _setButtons(false);
  }
}

// ─── Gate Re-check ────────────────────────────────────────────────────────────

async function recheckGate() {
  _log(`[${_ts()}] ↻ Running gate re-check…`, "info");
  const result = await _rerunGate();
  const banner = document.getElementById("install-gate-banner");
  if (banner) {
    banner.style.borderColor = result.systemReady ? "var(--ok)" : "var(--fail)";
  }
  _log(`[${_ts()}] Gate: ${result.gate} — ${result.systemReady ? "OPEN" : "BLOCKED"}`, result.systemReady ? "ok" : "err");
  showToast(result.systemReady ? "✅ Gate is open" : "🚫 Gate is closed", result.systemReady ? "ok" : "err");
  _setButtons(!result.systemReady);
}

async function _rerunGate() {
  try { return await preflight(); }
  catch { return { systemReady: false, gate: "CLOSED", blockRun5: true, blockingIssues: ["Gate check error"], warnings: [] }; }
}

// ─── Install State Display ────────────────────────────────────────────────────

async function _renderInstallState() {
  const el = document.getElementById("install-state-display");
  if (!el) return;
  try {
    const ic = await getInstallController();
    const state = ic.getInstallStatus?.();
    if (!state) { el.textContent = "Not available in offline mode."; return; }
    el.innerHTML = `
      <div style="display:flex;gap:1.5rem;flex-wrap:wrap;">
        <span>Status: <strong style="color:var(--accent-lt)">${esc(state.status || "idle")}</strong></span>
        <span>Project: <strong>${esc(state.currentProject || "—")}</strong></span>
        <span>Retries: <strong>${state.retryCount || 0}/${state.maxRetries || 3}</strong></span>
        <span>Last migration: <strong style="font-family:monospace;font-size:0.78rem">${esc(state.lastMigration || "—")}</strong></span>
      </div>
    `;
  } catch (err) {
    el.textContent = `Error reading install state: ${err.message}`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _log(msg, type = "") {
  const el = document.getElementById("install-log");
  if (!el) return;
  if (el.textContent === "Ready. Configure target above and click Run Install.") el.textContent = "";
  const span = document.createElement("span");
  span.className = type ? `log-${type}` : "";
  span.textContent = msg + "\n";
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function _setButtons(disabled) {
  ["install-btn", "heal-btn"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = disabled;
    if (btn && !disabled) {
      btn.innerHTML = id === "install-btn" ? "▶ Run Install (RUN 3)" : "🔁 Trigger Heal (RUN 4)";
    } else if (btn) {
      btn.innerHTML = `<span class="spinner">⟳</span> Running…`;
    }
  });
}

function _ts() { return new Date().toLocaleTimeString(); }

function _popInstallTarget() {
  try {
    const raw = sessionStorage.getItem("install_target");
    if (raw) { sessionStorage.removeItem("install_target"); return JSON.parse(raw); }
  } catch { /* ignore */ }
  return null;
}

function _makeOfflineStub(name) {
  const stub = (action) => async (...args) => {
    console.warn(`[${name}] Offline stub called: ${action}`);
    return { success: false, error: `${name} not available in static PWA context`, duration: "0s", attempts: 0 };
  };
  return { installProject: stub("installProject"), handleFailure: stub("handleFailure"), getInstallStatus: () => null };
}
