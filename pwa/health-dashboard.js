/**
 * health-dashboard.js — PWA Health Dashboard Controller (RUN 4.1)
 *
 * Renders the system health status in the browser.
 * Calls preflight-check.js and renders the result.
 * Used by health-dashboard.html (RUN 5 will add the full page).
 *
 * SSOT Rules:
 * ✔ Pure rendering — no system logic here
 * ✔ All checks delegated to preflight-check.js
 * ✔ RUN 5 gate status surfaced prominently in UI
 * ❌ Never triggers installs, repairs, or AI tasks
 */

import { preflight } from "./preflight-check.js";

// ─── Status → UI Mapping ──────────────────────────────────────────────────────

const STATUS_BADGE = {
  OK:      { label: "OK",      cls: "ok" },
  WARN:    { label: "WARN",    cls: "warn" },
  FAIL:    { label: "FAIL",    cls: "fail" },
  UNKNOWN: { label: "UNKNOWN", cls: "unknown" }
};

const GATE_CONFIG = {
  OPEN:   { label: "OPEN — RUN 5 ALLOWED",   cls: "gate-open",   icon: "✅" },
  WARN:   { label: "DEGRADED — RUN 5 ALLOWED (with warnings)", cls: "gate-warn", icon: "⚠️" },
  CLOSED: { label: "CLOSED — RUN 5 BLOCKED", cls: "gate-closed", icon: "🚫" }
};

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Mount the health dashboard into a container element.
 *
 * @param {HTMLElement|string} container - DOM element or selector string
 * @param {object} [opts]
 * @param {boolean} [opts.autoRefresh=false]  - Re-run check every N seconds
 * @param {number}  [opts.refreshInterval=30] - Seconds between auto-refreshes
 */
export async function mountHealthDashboard(container, opts = {}) {
  const { autoRefresh = false, refreshInterval = 30 } = opts;

  const el = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!el) {
    console.error("[health-dashboard] Container not found:", container);
    return;
  }

  // Show loading state immediately
  el.innerHTML = _renderLoading();

  // Run preflight and render
  const render = async () => {
    el.innerHTML = _renderLoading();
    try {
      const result = await preflight();
      el.innerHTML = _renderDashboard(result);
      _attachRefreshButton(el, render);
    } catch (err) {
      el.innerHTML = _renderError(err.message);
    }
  };

  await render();

  // Auto-refresh
  if (autoRefresh && refreshInterval >= 10) {
    setInterval(render, refreshInterval * 1000);
  }
}

// ─── Convenience: run health check and inject into #health-root ──────────────

/**
 * Quick-mount: looks for #health-root in the document.
 * Called from health.html script tag.
 */
export async function runHealthCheck() {
  await mountHealthDashboard("#health-root");
}

// ─── Renderers ────────────────────────────────────────────────────────────────

function _renderLoading() {
  return `
    <div class="health-loading">
      <span class="spinner">⟳</span> Running system health checks…
    </div>
  `;
}

function _renderError(msg) {
  return `
    <div class="health-error">
      <h3>⚠️ Health Check Failed</h3>
      <pre>${_esc(msg)}</pre>
    </div>
  `;
}

function _renderDashboard(result) {
  const gate = GATE_CONFIG[result.gate] || GATE_CONFIG.CLOSED;
  const lastCheck = result.lastCheck
    ? new Date(result.lastCheck).toLocaleString()
    : "Never";

  return `
    <div class="health-dashboard">

      <!-- Gate Status Banner -->
      <div class="gate-banner ${gate.cls}">
        <span class="gate-icon">${gate.icon}</span>
        <span class="gate-label">${gate.label}</span>
        <span class="gate-source">Source: ${result.source || "unknown"}</span>
      </div>

      <!-- System Checks Grid -->
      <div class="health-checks">
        ${_renderCheckRow("RUN 3 — Installer",   result.checks.run3_installer)}
        ${_renderCheckRow("RUN 4 — Auto-Heal",   result.checks.run4_healer)}
        ${_renderCheckRow("RUN 2 — AI Router",   result.checks.ai_router)}
        ${_renderCheckRow("RUN 0/1 — Vault",     result.checks.vault)}
      </div>

      <!-- Blocking Issues -->
      ${result.blockingIssues?.length > 0 ? `
        <div class="health-blocking">
          <h4>🚫 Blocking Issues</h4>
          <ul>${result.blockingIssues.map((i) => `<li>${_esc(i)}</li>`).join("")}</ul>
        </div>
      ` : ""}

      <!-- Warnings -->
      ${result.warnings?.length > 0 ? `
        <div class="health-warnings">
          <h4>⚠️ Warnings</h4>
          <ul>${result.warnings.map((w) => `<li>${_esc(w)}</li>`).join("")}</ul>
        </div>
      ` : ""}

      <!-- Footer -->
      <div class="health-footer">
        <span>Last checked: ${lastCheck}</span>
        <button class="btn-refresh" id="health-refresh-btn">↻ Re-check</button>
      </div>

    </div>
  `;
}

function _renderCheckRow(label, status) {
  const badge = STATUS_BADGE[status] || STATUS_BADGE.UNKNOWN;
  return `
    <div class="check-row">
      <span class="check-label">${label}</span>
      <span class="check-badge badge-${badge.cls}">${badge.label}</span>
    </div>
  `;
}

function _attachRefreshButton(el, refreshFn) {
  const btn = el.querySelector("#health-refresh-btn");
  if (btn) btn.addEventListener("click", refreshFn);
}

function _esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
