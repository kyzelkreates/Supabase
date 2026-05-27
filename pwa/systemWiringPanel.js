/**
 * systemWiringPanel.js — System Wiring Validation Panel (RUN 7.1)
 *
 * Dashboard panel for running, viewing, and repairing system wiring.
 * Calls architectureGuard.js on the server side for live checks.
 * Falls back to a static wiringState.json read in static PWA context.
 *
 * SSOT Rules:
 * ✔ Rendering delegated to healthReportUI.js
 * ✔ Architecture checks delegated to architectureGuard.js
 * ✔ Never executes pipeline or install actions
 * ✔ RUN 4.1 gate NOT required for check-only (read-only diagnostic)
 * ✔ RUN 4.1 gate IS required for repair mode (writes files)
 */

import { showToast, esc }           from "./dashboard.js";
import { renderHealthReport, renderWiringBadge } from "./healthReportUI.js";
import { preflight }                from "./preflight-check.js";

let _archGuard = null;

async function getArchGuard() {
  if (_archGuard) return _archGuard;
  try {
    _archGuard = await import("../server/architectureGuard.js");
  } catch {
    _archGuard = _makeOfflineStub();
  }
  return _archGuard;
}

// ─── Panel Entry ─────────────────────────────────────────────────────────────

export async function loadSystemWiringPanel(root) {
  root.innerHTML = `
    <div class="panel-title">🔌 System Wiring Validation</div>

    <!-- Action bar -->
    <div class="card" style="margin-bottom:1rem;">
      <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;color:var(--accent-lt)">Architecture Audit</div>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.1rem">
            Validates RUN 0–7 module boundaries, import rules, and SSOT integrity
          </div>
        </div>
        <div style="margin-left:auto;display:flex;gap:0.5rem;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" id="wiring-check-btn" onclick="window.__wiring.check()">
            🔍 Run Check
          </button>
          <button class="btn btn-primary btn-sm" id="wiring-repair-btn" onclick="window.__wiring.repair()">
            🔧 Check + Auto-Repair
          </button>
          <button class="btn btn-secondary btn-sm" onclick="window.__wiring.loadLastResult()">
            ↻ Load Last Result
          </button>
        </div>
      </div>
    </div>

    <!-- Dependency graph visualiser -->
    <div class="card" style="margin-bottom:1rem;">
      <h3 style="margin-bottom:0.75rem;">Dependency Graph</h3>
      <div id="dep-graph">${_renderDependencyGraph()}</div>
    </div>

    <!-- Boundary rules summary -->
    <div class="card" style="margin-bottom:1rem;">
      <h3 style="margin-bottom:0.75rem;">Enforced Boundary Rules</h3>
      <div id="boundary-rules">${_renderBoundaryRules()}</div>
    </div>

    <!-- Health report (populated after check) -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>Audit Report</h3>
        <span id="wiring-status-badge"></span>
      </div>
      <div id="health-report-root">
        <div style="color:#555;font-size:0.82rem;padding:0.5rem 0">
          Run a check above to see the full audit report.
        </div>
      </div>
    </div>

    <!-- Manual fix guidance -->
    <div class="card" id="manual-fix-card" style="display:none;">
      <h3 style="margin-bottom:0.75rem;">⚠ Manual Review Required</h3>
      <div id="manual-fix-list" style="font-size:0.82rem;color:var(--text-muted);"></div>
    </div>
  `;

  // Load last known result from SSOT
  await _loadAndRenderState();

  window.__wiring = {
    check:          () => _runAudit("check"),
    repair:         () => _runAudit("repair"),
    loadLastResult: _loadAndRenderState
  };
}

// ─── Audit Runner ─────────────────────────────────────────────────────────────

async function _runAudit(mode) {
  // Repair requires gate open (it writes files)
  if (mode === "repair") {
    const gate = await preflight();
    if (!gate.systemReady) {
      showToast("🚫 Gate closed — repair mode requires system to be healthy", "err");
      return;
    }
  }

  const checkBtn  = document.getElementById("wiring-check-btn");
  const repairBtn = document.getElementById("wiring-repair-btn");
  const reportEl  = document.getElementById("health-report-root");

  if (checkBtn)  checkBtn.disabled = true;
  if (repairBtn) repairBtn.disabled = true;
  if (reportEl)  reportEl.innerHTML = `<div style="color:#555;font-size:0.82rem">Running ${mode} audit… <span class="spinner">⟳</span></div>`;

  showToast(`Running wiring ${mode}…`, "info");

  try {
    const guard = await getArchGuard();
    const result = mode === "repair"
      ? guard.repairWiring()
      : guard.checkWiring();

    await _renderResult(result);

    const msg = result.systemReady
      ? `✅ Wiring ${result.status} in ${result.duration}`
      : `⚠ Wiring check complete: ${result.validation?.findings?.filter(f=>f.severity==="ERROR").length || 0} error(s)`;

    showToast(msg, result.systemReady ? "ok" : "err");

  } catch (err) {
    if (reportEl) reportEl.innerHTML = `<div style="color:var(--fail);font-size:0.82rem">Audit failed: ${esc(err.message)}</div>`;
    showToast(`Wiring audit failed: ${err.message}`, "err");
  } finally {
    if (checkBtn)  checkBtn.disabled = false;
    if (repairBtn) repairBtn.disabled = false;
  }
}

// ─── Result Renderer ──────────────────────────────────────────────────────────

async function _renderResult(result) {
  const reportRoot  = document.getElementById("health-report-root");
  const badgeEl     = document.getElementById("wiring-status-badge");
  const manualCard  = document.getElementById("manual-fix-card");
  const manualList  = document.getElementById("manual-fix-list");

  if (reportRoot) await renderHealthReport(reportRoot, result.validation ? _mapToWiringState(result) : result);

  // Badge
  if (badgeEl) {
    const state   = result.validation ? _mapToWiringState(result) : result;
    badgeEl.innerHTML = await renderWiringBadge(state);
  }

  // Manual fix guidance
  const manualItems = result.repair?.skipped?.filter((s) => s.severity === "ERROR" || s.manualNote) || [];
  if (manualCard && manualItems.length > 0) {
    manualCard.style.display = "";
    if (manualList) {
      manualList.innerHTML = manualItems.map((item) => `
        <div style="padding:0.4rem 0;border-bottom:1px solid var(--border);">
          <div style="font-family:monospace;color:var(--accent-lt);font-size:0.72rem">${esc(item.file || "")}</div>
          <div style="color:var(--text-muted);margin-top:0.1rem">${esc(item.description || item.message || "")}</div>
          ${item.manualNote ? `<div style="color:#6b6b8f;font-size:0.72rem;margin-top:0.15rem">💡 ${esc(item.manualNote)}</div>` : ""}
        </div>
      `).join("");
    }
  } else if (manualCard) {
    manualCard.style.display = "none";
  }
}

async function _loadAndRenderState() {
  try {
    const res = await fetch("../ssot/wiringState.json");
    if (!res.ok) return;
    const state = await res.json();
    await renderHealthReport(document.getElementById("health-report-root"), state);
    const badgeEl = document.getElementById("wiring-status-badge");
    if (badgeEl) badgeEl.innerHTML = await renderWiringBadge(state);
  } catch { /* no state yet */ }
}

// ─── Static Renderers ─────────────────────────────────────────────────────────

function _renderDependencyGraph() {
  const layers = [
    { id: "RUN 5 / PWA",       arrow: "→ RUN 7 only",        run: "5",   color: "#7c3aed" },
    { id: "RUN 7 Orchestrator", arrow: "→ kernel + gate + security", run: "7", color: "#6d28d9" },
    { id: "RUN 7 Kernel",      arrow: "→ RUN 2, 3, 4, 4.1",  run: "7k",  color: "#5b21b6" },
    { id: "RUN 4.1 Gate",      arrow: "→ RUN 3, 4, 2, 1",    run: "4.1", color: "#1d4ed8" },
    { id: "RUN 4 Healer",      arrow: "→ RUN 2, RUN 3 mig",  run: "4",   color: "#0369a1" },
    { id: "RUN 3 Installer",   arrow: "→ CLI + migrations",   run: "3",   color: "#047857" },
    { id: "RUN 2 Router",      arrow: "→ providers + fallback","run": "2", color: "#b45309" },
    { id: "RUN 6 Security",    arrow: "→ RUN 0 vault only",   run: "6",   color: "#9f1239" },
    { id: "RUN 0/1 Vault",     arrow: "→ (foundation)",       run: "0",   color: "#374151" }
  ];

  return `<div style="display:flex;flex-direction:column;gap:0.3rem;">
    ${layers.map((l) => `
      <div style="display:flex;align-items:center;gap:0.5rem;padding:0.3rem 0;">
        <div style="background:${l.color};color:#fff;border-radius:5px;padding:0.2rem 0.5rem;font-size:0.72rem;font-weight:600;min-width:140px">${esc(l.id)}</div>
        <span style="color:#555;font-size:0.72rem">${esc(l.arrow)}</span>
      </div>
    `).join("")}
  </div>`;
}

function _renderBoundaryRules() {
  const rules = [
    { rule: "PWA must NOT import server execution modules directly",    status: "enforced" },
    { rule: "PWA may call AI only via aiTasks.js or orchestrator.js",   status: "enforced" },
    { rule: "Lower RUN modules must NOT import orchestration layer",    status: "enforced" },
    { rule: "pipelineEngine.js is sole writer of executionState.json",  status: "enforced" },
    { rule: "architectureGuard.js is sole writer of wiringState.json",  status: "enforced" },
    { rule: "RUN 7 execute() is single entry point for all pipelines",  status: "enforced" },
    { rule: "All AI keys routed through vaultWrapper (never plaintext)","status": "enforced" },
    { rule: "RUN 4.1 gate checked before every install/AI action",      status: "enforced" }
  ];

  return `<div style="display:flex;flex-direction:column;gap:0.25rem;">
    ${rules.map((r) => `
      <div style="display:flex;align-items:center;gap:0.6rem;font-size:0.8rem;">
        <span style="color:var(--ok);flex-shrink:0">✔</span>
        <span style="color:var(--text-muted)">${esc(r.rule)}</span>
      </div>
    `).join("")}
  </div>`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _mapToWiringState(result) {
  return {
    status:             result.status,
    systemReady:        result.systemReady,
    lastCheck:          result.timestamp,
    summary:            result.summary,
    totalFindings:      result.validation?.findings?.length || 0,
    errorCount:         result.validation?.findings?.filter(f=>f.severity==="ERROR").length || 0,
    warnCount:          result.validation?.findings?.filter(f=>f.severity==="WARN").length || 0,
    brokenLinks:        result.validation?.brokenLinks || [],
    frontendViolations: result.validation?.frontendViolations || [],
    backendViolations:  result.validation?.backendViolations || [],
    bypassDetected:     result.validation?.bypassDetected || false,
    repairApplied:      result.repair?.applied?.length || 0,
    repairSummary:      result.repair?.summary || ""
  };
}

function _makeOfflineStub() {
  const stub = (mode) => () => ({
    status:     "FAIL",
    systemReady: false,
    validation: { findings: [], brokenLinks: [], frontendViolations: [], backendViolations: [], bypassDetected: false, summary: `Offline — architectureGuard.js not available (mode: ${mode})`, timestamp: new Date().toISOString() },
    summary:    "architectureGuard.js not available in static PWA context",
    duration:   "0s",
    timestamp:  new Date().toISOString()
  });
  return { checkWiring: stub("check"), repairWiring: stub("repair") };
}
