/**
 * runConsole.js — Live Pipeline Execution Console (RUN 7)
 *
 * Real-time trace viewer for pipeline runs.
 * Subscribes to pipelineEngine stage events and renders them live.
 * Also displays executionState.json status and pipeline history.
 *
 * SSOT Rules:
 * ✔ Pure UI — reads executionState.json + live events only
 * ✔ All execution delegated to orchestrationPanel.js
 * ✔ No execution actions here — display only
 */

import { esc } from "./dashboard.js";

let _unsub    = null; // Unsubscribe function from onStageEvent
let _liveLog  = [];   // Live events for current run

// ─── Panel Entry ─────────────────────────────────────────────────────────────

export async function loadRunConsole(root) {
  root.innerHTML = `
    <div class="panel-title">🖥 Run Console</div>

    <!-- Status header -->
    <div class="card" id="console-status-card">
      <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
        <div>
          <div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em">Pipeline Status</div>
          <div id="console-status-label" style="font-weight:700;color:var(--accent-lt);font-size:1rem;margin-top:0.1rem">Loading…</div>
        </div>
        <div style="margin-left:auto;display:flex;gap:0.5rem;">
          <button class="btn btn-secondary btn-sm" onclick="window.__console.refresh()">↻ Refresh</button>
          <button class="btn btn-danger btn-sm" onclick="window.__console.forceUnlock()" id="force-unlock-btn" style="display:none">⚠ Force Unlock</button>
        </div>
      </div>
      <div id="console-status-meta" style="font-size:0.78rem;color:var(--text-muted);margin-top:0.5rem;display:flex;gap:1.25rem;flex-wrap:wrap;"></div>
    </div>

    <!-- Stage progress -->
    <div class="card">
      <h3 style="margin-bottom:0.75rem;">Pipeline Stages</h3>
      <div id="stage-progress"></div>
    </div>

    <!-- Live trace output -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>Live Trace</h3>
        <div style="display:flex;gap:0.5rem;">
          <span id="live-indicator" style="font-size:0.72rem;color:#555"></span>
          <button class="btn btn-secondary btn-sm" onclick="window.__console.clearTrace()">Clear</button>
        </div>
      </div>
      <div id="trace-output" class="log-output" style="min-height:300px;max-height:460px;">
        No pipeline has run yet. Use the Orchestration panel to start one.
      </div>
    </div>

    <!-- Run history -->
    <div class="card">
      <h3 style="margin-bottom:0.75rem;">Run History</h3>
      <div id="run-history" style="font-size:0.82rem;color:var(--text-muted);">Loading…</div>
    </div>
  `;

  await _refreshStatus();
  _subscribeToEvents();
  _renderStageProgress(null);

  window.__console = {
    refresh:     async () => { await _refreshStatus(); },
    clearTrace:  ()      => { _liveLog = []; _renderTrace(); },
    forceUnlock: async () => {
      if (!confirm("Force-unlock the pipeline? Only do this if a run has crashed and left the system stuck.")) return;
      try {
        const { forceUnlock } = await import("../server/orchestrator.js");
        forceUnlock();
        await _refreshStatus();
      } catch (err) {
        console.error("Force unlock failed:", err.message);
      }
    }
  };
}

// ─── Status Refresh ───────────────────────────────────────────────────────────

async function _refreshStatus() {
  const state = await _fetchExecState();
  if (!state) return;

  // Status label
  const statusEl = document.getElementById("console-status-label");
  if (statusEl) {
    const map = { idle: "#6b6b8f", running: "#a78bfa", success: "#22c55e", failed: "#ef4444", error: "#ef4444", dry_run: "#f59e0b" };
    statusEl.style.color = map[state.status] || "#a78bfa";
    statusEl.textContent = (state.status || "idle").toUpperCase();
  }

  // Meta info
  const metaEl = document.getElementById("console-status-meta");
  if (metaEl) {
    metaEl.innerHTML = [
      state.activeProject ? `Project: <strong>${esc(state.activeProject)}</strong>` : "",
      state.currentPipelineId ? `Run ID: <span style="font-family:monospace;font-size:0.72rem">${esc(state.currentPipelineId)}</span>` : "",
      state.stage ? `Stage: <strong>${esc(state.stage)}</strong>` : "",
      state.updatedAt ? `Updated: ${esc(new Date(state.updatedAt).toLocaleTimeString())}` : ""
    ].filter(Boolean).map((s) => `<span>${s}</span>`).join("");
  }

  // Force-unlock button
  const unlockBtn = document.getElementById("force-unlock-btn");
  if (unlockBtn) unlockBtn.style.display = state.pipelineLocked ? "" : "none";

  // Run history
  const histEl = document.getElementById("run-history");
  if (histEl) {
    const history = state.stageHistory || [];
    if (!history.length) {
      histEl.textContent = "No completed runs yet.";
    } else {
      histEl.innerHTML = `
        <table class="data-table">
          <thead><tr><th>Pipeline ID</th><th>Status</th><th>Duration</th><th>Time</th></tr></thead>
          <tbody>
            ${history.slice(0, 10).map((h) => `
              <tr>
                <td style="font-family:monospace;font-size:0.75rem">${esc(h.pipelineId)}</td>
                <td><span class="badge ${h.status === 'success' ? 'ok' : h.status === 'failed' ? 'fail' : 'warn'}">${esc(h.status)}</span></td>
                <td>${esc(h.durationMs ? (h.durationMs / 1000).toFixed(1) + 's' : '—')}</td>
                <td style="color:#555;font-size:0.75rem">${h.timestamp ? new Date(h.timestamp).toLocaleString() : '—'}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
    }
  }
}

// ─── Stage Progress ───────────────────────────────────────────────────────────

const STAGE_ICONS = { start: "⟳", success: "✔", fail: "✘", skip: "⏭", warn: "⚠", pending: "·" };
const STAGE_COLORS = {
  success: "var(--ok)",
  fail:    "var(--fail)",
  warn:    "var(--warn)",
  skip:    "var(--text-muted)",
  start:   "var(--accent-lt)",
  pending: "#3b3b5e"
};

function _renderStageProgress(stageStates) {
  const el = document.getElementById("stage-progress");
  if (!el) return;

  const stages = [
    { id: "gate",            label: "Safety Gate",       run: "4.1" },
    { id: "security",        label: "Security Check",    run: "6"   },
    { id: "planner",         label: "AI Plan",           run: "2"   },
    { id: "builder",         label: "AI Build (SQL)",    run: "2"   },
    { id: "validator",       label: "AI Validate",       run: "2"   },
    { id: "installer",       label: "Supabase Install",  run: "3"   },
    { id: "healer",          label: "Auto-Heal",         run: "4"   },
    { id: "finalValidation", label: "Final Validation",  run: "3"   }
  ];

  el.innerHTML = `
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
      ${stages.map((s) => {
        const state = stageStates?.[s.id] || "pending";
        const icon  = STAGE_ICONS[state]  || "·";
        const color = STAGE_COLORS[state] || STAGE_COLORS.pending;
        return `
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:0.6rem 0.85rem;min-width:130px;flex:1;">
            <div style="font-size:0.68rem;color:var(--text-muted);margin-bottom:0.2rem">RUN ${esc(s.run)}</div>
            <div style="display:flex;align-items:center;gap:0.4rem;">
              <span style="color:${color};font-size:0.9rem">${icon}</span>
              <span style="font-size:0.8rem;font-weight:600;color:${color}">${esc(s.label)}</span>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

// ─── Live Event Subscription ──────────────────────────────────────────────────

function _subscribeToEvents() {
  if (_unsub) { _unsub(); _unsub = null; }

  // Try to subscribe to server-side stage events
  import("../server/pipelineEngine.js").then(({ onStageEvent }) => {
    _unsub = onStageEvent((stageId, type, data, pipelineId) => {
      const time = new Date().toLocaleTimeString();
      const icons = { start: "▶", success: "✔", fail: "✘", skip: "⏭", warn: "⚠" };
      const msg = `[${time}] ${icons[type] || "·"} ${stageId}${data?.message ? ` — ${data.message}` : ""}${data?.durationMs ? ` (${(data.durationMs/1000).toFixed(1)}s)` : ""}`;
      _liveLog.push({ msg, type });
      _renderTrace();

      // Update stage progress
      const stageStates = {};
      _liveLog.forEach((e) => {
        const match = e.msg.match(/\] [▶✔✘⏭⚠·] (\w+)/);
        if (match) stageStates[match[1]] = type;
      });
      _renderStageProgress(stageStates);

      // Update live indicator
      const ind = document.getElementById("live-indicator");
      if (ind) {
        ind.style.color = "var(--ok)";
        ind.textContent = "● LIVE";
        clearTimeout(ind._t);
        ind._t = setTimeout(() => { ind.textContent = ""; }, 3000);
      }
    });
  }).catch(() => {
    // Server modules unavailable in static PWA — polling fallback
    const iv = setInterval(async () => {
      const state = await _fetchExecState();
      if (state?.status !== "running") clearInterval(iv);
      await _refreshStatus();
    }, 2000);
  });
}

// ─── Trace Renderer ───────────────────────────────────────────────────────────

function _renderTrace() {
  const el = document.getElementById("trace-output");
  if (!el) return;
  if (!_liveLog.length) {
    el.textContent = "No pipeline has run yet. Use the Orchestration panel to start one.";
    return;
  }
  el.innerHTML = _liveLog.map((e) => {
    const cls = { success: "log-ok", fail: "log-err", warn: "log-warn", start: "log-info", skip: "" }[e.type] || "";
    return `<span class="${cls}">${esc(e.msg)}</span>`;
  }).join("\n");
  el.scrollTop = el.scrollHeight;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _fetchExecState() {
  try {
    const res = await fetch("../ssot/executionState.json");
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}
