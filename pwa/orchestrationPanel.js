/**
 * orchestrationPanel.js — Orchestration Panel (browser-safe, RUN 7.5+)
 */

import { showToast, esc } from "./utils.js";
import { sendToAgent, checkAgentStatus } from "./apiBridge.js";

export async function loadOrchestrationPanel(root) {
  const agentStatus = await checkAgentStatus(true).catch(() => ({ reachable: false }));

  root.innerHTML = `
    <div class="panel-title">🚀 Orchestration</div>

    <div class="card" style="border-color:${agentStatus.reachable ? 'var(--ok)' : 'var(--warn)'};margin-bottom:1rem;">
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <span>${agentStatus.reachable ? '✅' : '⚠️'}</span>
        <div style="font-weight:600;color:${agentStatus.reachable ? 'var(--ok)' : 'var(--warn)'}">
          ${agentStatus.reachable ? 'Agent Online — pipeline execution ready' : 'Agent Offline — orchestration requires local agent'}
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Pipeline Controls</h3>
      <div style="display:flex;flex-wrap:wrap;gap:0.75rem;margin-top:0.75rem;">
        <button class="btn btn-primary" onclick="window.__orch.run('full-pipeline')"
          ${!agentStatus.reachable ? 'disabled' : ''}>▶ Run Full Pipeline</button>
        <button class="btn btn-secondary" onclick="window.__orch.run('validate-wiring')"
          ${!agentStatus.reachable ? 'disabled' : ''}>🔍 Validate Wiring</button>
        <button class="btn btn-secondary" onclick="window.__orch.run('auto-repair')"
          ${!agentStatus.reachable ? 'disabled' : ''}>🔧 Auto-Repair</button>
        <button class="btn btn-secondary" onclick="window.__orch.run('health-check')"
          ${!agentStatus.reachable ? 'disabled' : ''}>💓 Health Check</button>
      </div>
    </div>

    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>Pipeline Output</h3>
        <button class="btn btn-secondary btn-sm" onclick="window.__orch.clearLog()">Clear</button>
      </div>
      <div id="orch-log" class="log-output" style="min-height:300px;">Waiting for pipeline action…</div>
    </div>
  `;

  window.__orch = {
    run: async (action) => {
      _log(`[${_ts()}] ▶ ${action}…`, "info");
      const res = await sendToAgent(action, {}, { timeout: 120000 });
      if (res.ok) {
        _log(`[${_ts()}] ✔ ${action} complete`, "ok");
        if (res.data?.output) _log(res.data.output, "info");
        showToast(`✅ ${action} complete`, "ok");
      } else {
        _log(`[${_ts()}] ✘ ${res.error}`, "err");
        showToast(`Failed: ${res.error}`, "err");
      }
    },
    clearLog: () => {
      const l = document.getElementById("orch-log");
      if (l) l.textContent = "Log cleared.";
    }
  };
}

function _log(msg, type = "info") {
  const el = document.getElementById("orch-log");
  if (!el) return;
  const cls = { ok: "log-ok", err: "log-err", warn: "log-warn", info: "log-info" }[type] || "";
  el.innerHTML += `\n<span class="${cls}">${esc(msg)}</span>`;
  el.scrollTop = el.scrollHeight;
}

function _ts() { return new Date().toLocaleTimeString(); }
