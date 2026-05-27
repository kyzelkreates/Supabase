/**
 * orchestrationPanel.js — Orchestration Control Panel (RUN 7)
 *
 * The dashboard panel for triggering and monitoring full pipeline runs.
 * Integrates with the RUN 7 orchestrator and shows live stage progress.
 * Enforces RUN 4.1 gate and RUN 6 vault check before every execution.
 *
 * SSOT Rules:
 * ✔ All execution via orchestrator.js (single import)
 * ✔ Gate + vault re-checked before every run
 * ✔ Live stage events via onStageEvent subscription
 * ✔ Results displayed + traceable to logsPanel
 * ❌ Never calls RUN 0–6 modules directly
 */

import { showToast, esc } from "./dashboard.js";
import { preflight }      from "./preflight-check.js";

let _orchestrator  = null;
let _stageStates   = {};
let _currentResult = null;

async function getOrchestrator() {
  if (_orchestrator) return _orchestrator;
  try {
    _orchestrator = await import("../server/orchestrator.js");
  } catch {
    _orchestrator = _makeOfflineStub();
  }
  return _orchestrator;
}

// ─── Panel Entry ─────────────────────────────────────────────────────────────

export async function loadOrchestrationPanel(root, gateResult) {
  _stageStates   = {};
  _currentResult = null;

  root.innerHTML = `
    <div class="panel-title">🚀 Orchestration Engine</div>

    <!-- Gate banner -->
    <div class="card" style="border-color:${gateResult?.systemReady ? 'var(--ok)' : 'var(--fail)'};margin-bottom:1rem;">
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <span style="font-size:1.25rem;">${gateResult?.systemReady ? "✅" : "🚫"}</span>
        <div>
          <div style="font-weight:600;color:${gateResult?.systemReady ? 'var(--ok)' : 'var(--fail)'}">
            System Gate: ${gateResult?.gate || "UNKNOWN"}
          </div>
          <div style="font-size:0.78rem;color:var(--text-muted);">
            ${gateResult?.systemReady ? "All systems healthy — pipeline ready to execute" : "Gate closed — resolve issues before running"}
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="window.__orch.recheck()">↻ Re-check</button>
      </div>
    </div>

    <!-- Pipeline configuration -->
    <div class="card">
      <h3>Pipeline Configuration</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-top:0.75rem;">
        <div class="form-group" style="margin:0;">
          <label>Project Name</label>
          <input id="orch-project" type="text" placeholder="my-app" />
        </div>
        <div class="form-group" style="margin:0;">
          <label>Supabase Ref <span style="color:#555;font-weight:400">(or saved in vault)</span></label>
          <input id="orch-ref" type="text" placeholder="abcdefghijklmnop" />
        </div>
      </div>

      <div class="form-group" style="margin-top:0.75rem;">
        <label>System Description <span style="color:#555;font-weight:400">— what should be built?</span></label>
        <textarea id="orch-prompt" style="min-height:100px;" placeholder="e.g. Build a multi-tenant SaaS with users, organizations, and subscription plans. Each org has members with roles. All tables need RLS."></textarea>
      </div>

      <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-top:0.25rem;">
        <label style="display:flex;align-items:center;gap:0.4rem;font-size:0.8rem;color:var(--text-muted);cursor:pointer;">
          <input type="checkbox" id="orch-dry-run"> Dry run (plan + build only — no install)
        </label>
        <label style="display:flex;align-items:center;gap:0.4rem;font-size:0.8rem;color:var(--text-muted);cursor:pointer;">
          <input type="checkbox" id="orch-skip-val"> Skip AI SQL validation
        </label>
      </div>

      <div style="display:flex;gap:0.5rem;margin-top:1rem;">
        <button class="btn btn-primary" id="orch-run-btn"
          ${!gateResult?.systemReady ? "disabled" : ""}
          onclick="window.__orch.run()">
          ▶ Run Full Pipeline
        </button>
        <button class="btn btn-secondary" id="orch-preview-btn"
          onclick="window.__orch.preview()">
          👁 Preview (Plan Only)
        </button>
        <span id="orch-status-label" style="font-size:0.8rem;color:var(--text-muted);margin-left:0.25rem;align-self:center;"></span>
      </div>
    </div>

    <!-- Stage progress -->
    <div class="card">
      <h3 style="margin-bottom:0.75rem;">Pipeline Stages</h3>
      <div id="orch-stages"></div>
    </div>

    <!-- Live output -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>Execution Output</h3>
        <div style="display:flex;gap:0.5rem;align-items:center;">
          <span id="orch-live-ind" style="font-size:0.72rem;color:#555;"></span>
          <button class="btn btn-secondary btn-sm" onclick="window.__orch.clearLog()">Clear</button>
        </div>
      </div>
      <div id="orch-log" class="log-output" style="min-height:240px;max-height:400px;">
        Pipeline output will appear here. Configure above and click Run.
      </div>
    </div>

    <!-- Generated SQL preview -->
    <div id="orch-sql-card" class="card" style="display:none;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>Generated SQL</h3>
        <button class="btn btn-secondary btn-sm" onclick="window.__orch.copySQL()">Copy</button>
      </div>
      <pre id="orch-sql" class="log-output" style="color:#86efac;max-height:360px;"></pre>
    </div>
  `;

  _renderStages({});
  _subscribeToEvents();

  window.__orch = {
    run:      runPipeline,
    preview:  previewPipeline,
    recheck:  recheckGate,
    clearLog: () => { const l = document.getElementById("orch-log"); if (l) l.textContent = "Log cleared."; },
    copySQL:  () => {
      const sql = document.getElementById("orch-sql")?.textContent;
      if (sql) navigator.clipboard.writeText(sql).then(() => showToast("SQL copied", "ok"));
    }
  };
}

// ─── Pipeline Run ─────────────────────────────────────────────────────────────

async function runPipeline() {
  const projectName = document.getElementById("orch-project")?.value.trim();
  const ref         = document.getElementById("orch-ref")?.value.trim();
  const prompt      = document.getElementById("orch-prompt")?.value.trim();
  const dryRun      = document.getElementById("orch-dry-run")?.checked;
  const skipVal     = document.getElementById("orch-skip-val")?.checked;

  if (!projectName || !prompt) { showToast("Project name and description are required", "err"); return; }

  // Re-verify gate
  const gate = await preflight();
  if (!gate.systemReady) { showToast("🚫 Gate closed — pipeline blocked", "err"); return; }

  _stageStates = {};
  _renderStages({});
  _setBusy(true);
  _setStatus(dryRun ? "Dry running…" : "Running pipeline…");
  _log(`[${_ts()}] ▶ Pipeline starting: ${projectName}${dryRun ? " (dry run)" : ""}`, "info");

  try {
    const orch = await getOrchestrator();
    const result = await orch.execute({ projectName, ref: ref || undefined, prompt, dryRun, skipValidation: skipVal });

    _currentResult = result;

    if (result.success) {
      _log(`[${_ts()}] ✔ Pipeline complete: ${result.status} in ${result.duration}`, "ok");
      showToast(`✅ Pipeline ${result.status} in ${result.duration}`, "ok");
    } else {
      _log(`[${_ts()}] ✘ Pipeline failed: ${result.error}`, "err");
      showToast(`Pipeline failed: ${result.error}`, "err");
    }

    // Show formatted trace
    if (result.formattedTrace) {
      _log("\n── Trace ──────────────────────────\n" + result.formattedTrace, "");
    }

    // Show generated SQL if available
    if (result.generatedSQL) {
      const card = document.getElementById("orch-sql-card");
      const pre  = document.getElementById("orch-sql");
      if (card) card.style.display = "";
      if (pre)  pre.textContent = result.generatedSQL;
    }

    _renderStages(result.stages || {});

  } catch (err) {
    _log(`[${_ts()}] ✘ ${err.message}`, "err");
    showToast(`Error: ${err.message}`, "err");
  } finally {
    _setBusy(false);
    _setStatus("");
  }
}

async function previewPipeline() {
  const projectName = document.getElementById("orch-project")?.value.trim() || "preview";
  const prompt      = document.getElementById("orch-prompt")?.value.trim();
  if (!prompt) { showToast("Enter a description to preview", "err"); return; }

  _setBusy(true, "preview");
  _setStatus("Generating preview…");
  _log(`[${_ts()}] 👁 Preview mode — no install will run`, "info");

  try {
    const orch = await getOrchestrator();
    const result = await orch.preview(projectName, prompt);

    if (result.generatedSQL) {
      const card = document.getElementById("orch-sql-card");
      const pre  = document.getElementById("orch-sql");
      if (card) card.style.display = "";
      if (pre)  pre.textContent = result.generatedSQL;
      _log(`[${_ts()}] ✔ Preview complete — SQL generated (${result.generatedSQL.length} chars)`, "ok");
      showToast("✅ Preview generated", "ok");
    }
  } catch (err) {
    _log(`[${_ts()}] ✘ Preview failed: ${err.message}`, "err");
    showToast(`Preview failed: ${err.message}`, "err");
  } finally {
    _setBusy(false);
    _setStatus("");
  }
}

// ─── Gate Re-check ────────────────────────────────────────────────────────────

async function recheckGate() {
  const result = await preflight();
  const btn = document.getElementById("orch-run-btn");
  if (btn) btn.disabled = !result.systemReady;
  showToast(result.systemReady ? "✅ Gate is open" : "🚫 Gate is closed", result.systemReady ? "ok" : "err");
}

// ─── Stage Progress Renderer ──────────────────────────────────────────────────

const STAGE_DEFS = [
  { id: "gate",            label: "Safety Gate",       run: "4.1" },
  { id: "security",        label: "Vault Check",       run: "6"   },
  { id: "planner",         label: "AI Plan",           run: "2"   },
  { id: "builder",         label: "AI Build",          run: "2"   },
  { id: "validator",       label: "AI Validate",       run: "2"   },
  { id: "installer",       label: "Install",           run: "3"   },
  { id: "healer",          label: "Auto-Heal",         run: "4"   },
  { id: "finalValidation", label: "Final Check",       run: "3"   }
];

function _renderStages(stageResults) {
  const el = document.getElementById("orch-stages");
  if (!el) return;

  el.innerHTML = `<div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
    ${STAGE_DEFS.map((s) => {
      const r = stageResults[s.id];
      let state = "pending", icon = "·", color = "#3b3b5e";
      if (r?.ok && !r?.skipped) { state = "success"; icon = "✔"; color = "var(--ok)"; }
      else if (r?.ok === false)  { state = "fail";    icon = "✘"; color = "var(--fail)"; }
      else if (r?.skipped)       { state = "skip";    icon = "⏭"; color = "var(--text-muted)"; }
      else if (r?.warnings)      { state = "warn";    icon = "⚠"; color = "var(--warn)"; }
      return `
        <div style="background:var(--surface2);border:1px solid ${color === "#3b3b5e" ? "var(--border)" : color};border-radius:8px;padding:0.5rem 0.75rem;min-width:100px;flex:1;opacity:${state==="pending"?0.5:1}">
          <div style="font-size:0.65rem;color:var(--text-muted)">RUN ${esc(s.run)}</div>
          <div style="display:flex;align-items:center;gap:0.3rem;margin-top:0.15rem;">
            <span style="color:${color}">${icon}</span>
            <span style="font-size:0.75rem;font-weight:600;color:${color}">${esc(s.label)}</span>
          </div>
        </div>
      `;
    }).join("")}
  </div>`;
}

// ─── Live Events ──────────────────────────────────────────────────────────────

function _subscribeToEvents() {
  import("../server/orchestrator.js").then(({ onStageEvent }) => {
    onStageEvent((stageId, type, data) => {
      const icons = { start: "▶", success: "✔", fail: "✘", skip: "⏭", warn: "⚠" };
      const msg = `[${_ts()}] ${icons[type]||"·"} ${stageId}${data?.message ? ` — ${data.message}` : ""}${data?.durationMs ? ` (${(data.durationMs/1000).toFixed(1)}s)` : ""}`;
      const logType = { success: "ok", fail: "err", warn: "warn", start: "info" }[type] || "";
      _log(msg, logType);

      // Update stage state
      if (type === "success") _stageStates[stageId] = { ok: true };
      else if (type === "fail") _stageStates[stageId] = { ok: false };
      else if (type === "skip") _stageStates[stageId] = { ok: true, skipped: true };
      _renderStages(_stageStates);

      // Live indicator
      const ind = document.getElementById("orch-live-ind");
      if (ind) { ind.style.color = "var(--ok)"; ind.textContent = "● LIVE"; clearTimeout(ind._t); ind._t = setTimeout(() => { ind.textContent = ""; }, 2500); }
    });
  }).catch(() => {});
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _log(msg, type = "") {
  const el = document.getElementById("orch-log");
  if (!el) return;
  if (el.textContent.trim() === "Pipeline output will appear here. Configure above and click Run.") el.textContent = "";
  const span = document.createElement("span");
  span.className = type ? `log-${type}` : "";
  span.textContent = msg + "\n";
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function _setStatus(msg) {
  const el = document.getElementById("orch-status-label");
  if (el) el.textContent = msg;
}

function _setBusy(busy, which = "run") {
  const runBtn     = document.getElementById("orch-run-btn");
  const previewBtn = document.getElementById("orch-preview-btn");
  if (runBtn) {
    runBtn.disabled = busy;
    runBtn.innerHTML = (busy && which === "run") ? `<span class="spinner">⟳</span> Running…` : "▶ Run Full Pipeline";
  }
  if (previewBtn) {
    previewBtn.disabled = busy;
    previewBtn.innerHTML = (busy && which === "preview") ? `<span class="spinner">⟳</span> Previewing…` : "👁 Preview (Plan Only)";
  }
}

function _ts() { return new Date().toLocaleTimeString(); }

function _makeOfflineStub() {
  return {
    execute: async (p) => ({ success: false, pipelineId: "offline", status: "failed", stages: {}, trace: [], formattedTrace: "", duration: "0s", error: "Orchestrator not available in static PWA context" }),
    preview: async (n, p) => ({ success: false, generatedSQL: `-- OFFLINE PREVIEW\n-- Project: ${n}\n-- Prompt: ${p}\n-- (Server modules not loaded)` })
  };
}
