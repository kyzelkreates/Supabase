/**
 * logsPanel.js — Execution Log Viewer (RUN 5)
 *
 * Aggregates and displays logs from all prior run layers:
 * - Install logs (RUN 3 — installState.json)
 * - Repair logs (RUN 4 — repairState.json)
 * - System check history (RUN 4.1 — systemState.json)
 *
 * Also maintains a session log bus that other panels write to.
 *
 * SSOT Rules:
 * ✔ Read-only view of SSOT state files + session log bus
 * ✔ Never triggers actions
 * ✔ Session log bus is in-memory only — not persisted to SSOT
 */

import { showToast, esc } from "./dashboard.js";

// ─── Session Log Bus (shared in-memory, all panels can write) ─────────────────
// Usage: import { logEvent } from "./logsPanel.js"; logEvent("msg", "ok");

const _sessionLog = [];
const _MAX_SESSION_ENTRIES = 200;

export function logEvent(msg, type = "info") {
  _sessionLog.unshift({ ts: new Date().toISOString(), msg: String(msg), type });
  if (_sessionLog.length > _MAX_SESSION_ENTRIES) _sessionLog.pop();
}

// ─── Panel Entry ─────────────────────────────────────────────────────────────

export async function loadLogsPanel(root) {
  root.innerHTML = `
    <div class="panel-title">📜 Execution Logs</div>

    <!-- Tab bar -->
    <div style="display:flex;gap:0.25rem;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:0.5rem;">
      ${["Session", "Install", "Repair", "System Checks"].map((tab, i) => `
        <button class="btn btn-secondary btn-sm log-tab ${i === 0 ? "active-tab" : ""}"
          style="${i === 0 ? "background:var(--accent-dim);border-color:var(--accent-lt);color:var(--accent-lt);" : ""}"
          data-tab="${tab.toLowerCase().replace(" ","_")}"
          onclick="window.__logs.switchTab(this, '${tab.toLowerCase().replace(" ","_")}')">
          ${tab}
        </button>
      `).join("")}
      <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="window.__logs.refresh()">↻ Refresh</button>
      <button class="btn btn-danger btn-sm" onclick="window.__logs.clearSession()">Clear Session</button>
    </div>

    <!-- Log pane -->
    <div id="log-pane" class="log-output" style="min-height:420px;max-height:580px;">
      Loading…
    </div>

    <!-- Footer -->
    <div style="margin-top:0.5rem;font-size:0.75rem;color:var(--text-muted);display:flex;justify-content:space-between;">
      <span id="log-count"></span>
      <span>Logs are read-only views of SSOT state files</span>
    </div>
  `;

  let _activeTab = "session";

  const renderTab = async (tab) => {
    _activeTab = tab;
    const pane = document.getElementById("log-pane");
    pane.innerHTML = "Loading…";
    try {
      switch (tab) {
        case "session":       pane.innerHTML = _renderSessionLog(); break;
        case "install":       pane.innerHTML = await _renderInstallLog(); break;
        case "repair":        pane.innerHTML = await _renderRepairLog(); break;
        case "system_checks": pane.innerHTML = await _renderSystemLog(); break;
        default: pane.textContent = "Unknown tab";
      }
    } catch (err) {
      pane.innerHTML = `<span class="log-err">Error loading logs: ${esc(err.message)}</span>`;
    }
    _updateCount();
  };

  window.__logs = {
    switchTab: (btn, tab) => {
      document.querySelectorAll(".log-tab").forEach((b) => {
        b.style.cssText = "";
        b.classList.remove("active-tab");
      });
      btn.style.cssText = "background:var(--accent-dim);border-color:var(--accent-lt);color:var(--accent-lt);";
      renderTab(tab);
    },
    refresh:      () => renderTab(_activeTab),
    clearSession: () => { _sessionLog.length = 0; renderTab("session"); showToast("Session log cleared", "info"); }
  };

  renderTab("session");
}

// ─── Session Log Renderer ─────────────────────────────────────────────────────

function _renderSessionLog() {
  if (_sessionLog.length === 0) return `<span style="color:#555">No session events yet. Actions from Install and AI panels appear here.</span>`;
  return _sessionLog.map((e) => {
    const time = new Date(e.ts).toLocaleTimeString();
    const cls = { ok: "log-ok", err: "log-err", warn: "log-warn", info: "log-info" }[e.type] || "";
    return `<span class="${cls}">[${time}] ${esc(e.msg)}</span>`;
  }).join("\n");
}

// ─── Install Log (from installState.json) ────────────────────────────────────

async function _renderInstallLog() {
  const state = await _fetchJSON("../ssot/installState.json");
  if (!state) return `<span class="log-warn">installState.json not found or unreadable.</span>`;

  const lines = [
    `<span class="log-info">── Install State ──────────────────────────────</span>`,
    `Status:          <span class="${_statusCls(state.status)}">${esc(state.status || "idle")}</span>`,
    `Current Project: ${esc(state.currentProject || "—")}`,
    `Current Run:     ${state.currentRun || 0}`,
    `Retry Count:     ${state.retryCount || 0} / ${state.maxRetries || 3}`,
    `Last Migration:  ${esc(state.lastMigration || "—")}`,
    `Updated:         ${esc(state.updatedAt || "—")}`,
    ``,
    `<span class="log-info">── Completed Migrations ───────────────────────</span>`
  ];

  const migrations = state.completedMigrations || {};
  const projects = Object.keys(migrations);
  if (projects.length === 0) {
    lines.push("  (no completed migrations)");
  } else {
    for (const proj of projects) {
      lines.push(`\n  <span class="log-info">Project: ${esc(proj)}</span>`);
      (migrations[proj] || []).forEach((f) => lines.push(`    <span class="log-ok">✔ ${esc(f)}</span>`));
    }
  }

  return lines.join("\n");
}

// ─── Repair Log (from repairState.json) ──────────────────────────────────────

async function _renderRepairLog() {
  const state = await _fetchJSON("../ssot/repairState.json");
  if (!state) return `<span class="log-warn">repairState.json not found or unreadable.</span>`;

  const lines = [
    `<span class="log-info">── Repair State ───────────────────────────────</span>`,
    `Status:        <span class="${_statusCls(state.status)}">${esc(state.status || "idle")}</span>`,
    `Repair Count:  ${state.repairCount || 0} / ${state.maxRepairs || 3}`,
    `Last Error:    ${esc(state.lastError || "—")}`,
    `Updated:       ${esc(state.updatedAt || "—")}`,
    ``,
    `<span class="log-info">── Repair History ─────────────────────────────</span>`
  ];

  const history = state.repairHistory || [];
  if (history.length === 0) {
    lines.push("  (no repair attempts)");
  } else {
    history.forEach((h) => {
      const cls = h.success ? "log-ok" : "log-err";
      lines.push(
        `<span class="${cls}">  Attempt ${h.attempt} [${esc(h.timestamp?.slice(0,19).replace("T"," ") || "?")}]` +
        ` ${esc(h.errorType)} via ${esc(h.provider)} — ${h.success ? "HEALED" : esc(h.error || "FAIL")}</span>`
      );
    });
  }

  return lines.join("\n");
}

// ─── System Check Log (from systemState.json) ────────────────────────────────

async function _renderSystemLog() {
  const state = await _fetchJSON("../ssot/systemState.json");
  if (!state) return `<span class="log-warn">systemState.json not found or unreadable.</span>`;

  const gateCls = { OPEN: "log-ok", WARN: "log-warn", CLOSED: "log-err" }[state.gate] || "";
  const lines = [
    `<span class="log-info">── System Gate State ──────────────────────────</span>`,
    `Gate:           <span class="${gateCls}">${esc(state.gate || "UNKNOWN")}</span>`,
    `Status:         ${esc(state.status || "—")}`,
    `System Ready:   ${state.systemReady ? `<span class="log-ok">YES</span>` : `<span class="log-err">NO</span>`}`,
    `RUN 5 Blocked:  ${state.blockRun5  ? `<span class="log-err">YES</span>` : `<span class="log-ok">NO</span>`}`,
    `Last Check:     ${esc(state.lastCheck || "—")}`,
    ``,
    `<span class="log-info">── Per-System Status ──────────────────────────</span>`,
    `  RUN 3 Installer: <span class="${_okCls(state.run3_installer)}">${esc(state.run3_installer || "unknown")}</span>`,
    `  RUN 4 Healer:    <span class="${_okCls(state.run4_healer)}">${esc(state.run4_healer || "unknown")}</span>`,
    `  AI Router:       <span class="${_okCls(state.ai_router)}">${esc(state.ai_router || "unknown")}</span>`,
    `  Vault:           <span class="${_okCls(state.vault)}">${esc(state.vault || "unknown")}</span>`,
    ``
  ];

  if (state.blockingIssues?.length > 0) {
    lines.push(`<span class="log-info">── Blocking Issues ────────────────────────────</span>`);
    state.blockingIssues.forEach((i) => lines.push(`  <span class="log-err">✘ ${esc(i)}</span>`));
    lines.push("");
  }

  if (state.warnings?.length > 0) {
    lines.push(`<span class="log-info">── Warnings ───────────────────────────────────</span>`);
    state.warnings.forEach((w) => lines.push(`  <span class="log-warn">⚠ ${esc(w)}</span>`));
    lines.push("");
  }

  const history = state.checkHistory || [];
  if (history.length > 0) {
    lines.push(`<span class="log-info">── Check History (last ${history.length}) ─────────────────────</span>`);
    [...history].reverse().forEach((h) => {
      const cls = { OPEN: "log-ok", WARN: "log-warn", CLOSED: "log-err" }[h.gate] || "";
      lines.push(
        `  <span class="${cls}">[${esc(h.timestamp?.slice(0,19).replace("T"," ") || "?")}]` +
        ` ${esc(h.gate)} — ${h.blockingCount} blocking, ${h.warningCount} warnings</span>`
      );
    });
  }

  return lines.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _fetchJSON(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

function _updateCount() {
  const pane = document.getElementById("log-pane");
  const count = document.getElementById("log-count");
  if (!pane || !count) return;
  const lines = pane.innerHTML.split("\n").length;
  count.textContent = `${lines} lines`;
}

function _statusCls(s) {
  const map = { installed: "log-ok", healed: "log-ok", failed: "log-err", installing: "log-info", healing: "log-info", idle: "" };
  return map[s] || "";
}

function _okCls(s) {
  const map = { OK: "log-ok", WARN: "log-warn", FAIL: "log-err", UNKNOWN: "" };
  return map[s] || "";
}
