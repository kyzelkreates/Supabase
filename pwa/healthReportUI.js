/**
 * healthReportUI.js — Architecture Health Report Renderer (RUN 7.1)
 *
 * Renders a full wiring audit report from wiringState.json.
 * Used by systemWiringPanel.js as its display engine.
 * Also used by systemPanel.js to show a wiring health badge.
 *
 * SSOT Rules:
 * ✔ Pure rendering — reads wiringState.json via fetch, renders HTML
 * ✔ No execution, no repairs triggered from here
 * ✔ Repair action delegated to systemWiringPanel.js
 */

import { esc } from "./utils.js";

// ─── Badge Renderer (for embedding in other panels) ───────────────────────────

/**
 * Render a compact wiring health badge.
 * Call with a wiringState object or fetch it first.
 *
 * @param {object} [state] - wiringState.json contents (fetched if omitted)
 * @returns {Promise<string>} HTML string
 */
export async function renderWiringBadge(state) {
  const s = state || await _fetchWiringState();
  if (!s) return `<span class="badge unknown">Wiring: Unknown</span>`;

  const cfg = {
    PASS:    { cls: "ok",   label: "✔ Wiring OK",      color: "var(--ok)"   },
    FIXED:   { cls: "ok",   label: "✔ Wiring Fixed",   color: "var(--ok)"   },
    PARTIAL: { cls: "warn", label: "⚠ Wiring Partial", color: "var(--warn)" },
    FAIL:    { cls: "fail", label: "✘ Wiring Fail",    color: "var(--fail)" },
    pending: { cls: "unknown", label: "? Not Checked",  color: "#555"        }
  }[s.status] || { cls: "unknown", label: `? ${s.status}`, color: "#555" };

  return `<span class="badge ${cfg.cls}" title="${esc(s.summary || "")}">${cfg.label}</span>`;
}

// ─── Full Report Renderer ─────────────────────────────────────────────────────

/**
 * Render the full wiring audit report into a container element.
 *
 * @param {HTMLElement|string} container
 * @param {object}             [state]    - Pre-fetched state (optional)
 */
export async function renderHealthReport(container, state) {
  const el = typeof container === "string" ? document.querySelector(container) : container;
  if (!el) return;

  const s = state || await _fetchWiringState();

  if (!s || s.status === "pending") {
    el.innerHTML = `
      <div style="color:var(--text-muted);font-size:0.85rem;padding:0.5rem 0">
        No wiring check has run yet. Click "Run Wiring Check" to validate the system architecture.
      </div>
    `;
    return;
  }

  const statusCfg = {
    PASS:    { color: "var(--ok)",   icon: "✔", label: "PASS" },
    FIXED:   { color: "var(--ok)",   icon: "✔", label: "FIXED — auto-repairs applied" },
    PARTIAL: { color: "var(--warn)", icon: "⚠", label: "PARTIAL — some issues remain" },
    FAIL:    { color: "var(--fail)", icon: "✘", label: "FAIL — manual review required" }
  }[s.status] || { color: "#555", icon: "?", label: s.status };

  el.innerHTML = `
    <!-- Status header -->
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;padding:0.75rem;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">
      <span style="font-size:1.5rem;color:${statusCfg.color}">${statusCfg.icon}</span>
      <div>
        <div style="font-weight:700;color:${statusCfg.color}">${statusCfg.label}</div>
        <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.1rem">${esc(s.summary || "")}</div>
      </div>
      <div style="margin-left:auto;text-align:right;">
        <div style="font-size:0.72rem;color:#555">Last checked</div>
        <div style="font-size:0.78rem;color:var(--text-muted)">${s.lastCheck ? new Date(s.lastCheck).toLocaleString() : "—"}</div>
      </div>
    </div>

    <!-- Stats row -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.5rem;margin-bottom:1rem;">
      ${_statBox("Total Findings", s.totalFindings ?? "—", "#9ca3af")}
      ${_statBox("Errors",         s.errorCount    ?? 0,   "var(--fail)")}
      ${_statBox("Warnings",       s.warnCount     ?? 0,   "var(--warn)")}
      ${_statBox("Auto-Fixed",     s.repairApplied ?? 0,   "var(--ok)")}
    </div>

    <!-- Finding categories -->
    ${_renderFindingCategory("🚫 Broken Links",            s.brokenLinks,           "fail")}
    ${_renderFindingCategory("⚠ Frontend Violations",     s.frontendViolations,    "warn")}
    ${_renderFindingCategory("⚠ Backend Violations",      s.backendViolations,     "warn")}

    <!-- Check history -->
    ${s.checkHistory?.length ? `
      <div style="margin-top:0.5rem;">
        <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.4rem">Check History</div>
        <table class="data-table" style="font-size:0.78rem;">
          <thead><tr><th>Time</th><th>Status</th><th>Errors</th><th>Warnings</th><th>Fixes</th></tr></thead>
          <tbody>
            ${s.checkHistory.slice(0,6).map((h) => `
              <tr>
                <td style="color:#555">${h.timestamp ? new Date(h.timestamp).toLocaleString() : "—"}</td>
                <td><span class="badge ${h.status==="PASS"||h.status==="FIXED"?"ok":h.status==="PARTIAL"?"warn":"fail"}">${esc(h.status)}</span></td>
                <td style="color:${h.errorCount>0?"var(--fail)":"#555"}">${h.errorCount}</td>
                <td style="color:${h.warnCount>0?"var(--warn)":"#555"}">${h.warnCount}</td>
                <td style="color:${h.fixCount>0?"var(--ok)":"#555"}">${h.fixCount}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    ` : ""}
  `;
}

// ─── Internal Renderers ───────────────────────────────────────────────────────

function _statBox(label, value, color) {
  return `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:0.65rem;text-align:center;">
      <div style="font-size:1.35rem;font-weight:700;color:${color}">${value}</div>
      <div style="font-size:0.7rem;color:var(--text-muted);margin-top:0.1rem">${label}</div>
    </div>
  `;
}

function _renderFindingCategory(title, findings, type) {
  if (!findings?.length) return "";
  const color = { fail: "var(--fail)", warn: "var(--warn)" }[type] || "var(--text-muted)";
  return `
    <div style="margin-bottom:0.75rem;">
      <div style="font-size:0.75rem;color:${color};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.4rem">${title} (${findings.length})</div>
      ${findings.map((f) => `
        <div style="display:flex;gap:0.5rem;padding:0.4rem 0.6rem;background:var(--surface2);border-radius:6px;margin-bottom:0.25rem;font-size:0.78rem;align-items:flex-start;">
          <span class="badge ${type}" style="flex-shrink:0;margin-top:0.1rem">${esc(f.severity || type.toUpperCase())}</span>
          <div>
            <div style="font-family:monospace;color:var(--accent-lt);font-size:0.72rem">${esc(f.file)}</div>
            <div style="color:var(--text-muted);margin-top:0.1rem">${esc(f.message)}</div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

async function _fetchWiringState() {
  try {
    const res = await fetch("../ssot/wiringState.json");
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}
