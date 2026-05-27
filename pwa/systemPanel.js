/**
 * systemPanel.js — System Health Panel (browser-safe, RUN 7.5+)
 */

import { showToast, esc } from "./utils.js";
import { checkAgentStatus } from "./apiBridge.js";

export async function loadSystemPanel(root) {
  root.innerHTML = `<div style="color:#555;font-size:0.85rem;padding:1rem">Running system check…</div>`;

  let agentStatus = { reachable: false };
  try { agentStatus = await checkAgentStatus(true); } catch {}

  let ssotState = null;
  try {
    const r = await fetch("ssot/systemState.json");
    if (r.ok) ssotState = await r.json();
  } catch {}

  const checks = [
    { label: "Local Agent",       ok: agentStatus.reachable,             note: agentStatus.reachable ? `v${agentStatus.version || '?'}` : "Offline — cd agent && node agentRouter.js" },
    { label: "Pipeline",          ok: agentStatus.pipelineStatus === "OK", note: agentStatus.pipelineStatus || "unknown" },
    { label: "Wiring",            ok: agentStatus.wiringStatus === "VALID", note: agentStatus.wiringStatus || "unknown" },
    { label: "SSOT System State", ok: !!ssotState,                        note: ssotState ? `Gate: ${ssotState.gate || '?'}` : "Not loaded" },
  ];

  root.innerHTML = `
    <div class="panel-title">🔬 System Health</div>

    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>Component Status</h3>
        <button class="btn btn-secondary btn-sm" onclick="window.__system.refresh()">↻ Refresh</button>
      </div>
      <table class="data-table">
        <thead><tr><th>Component</th><th>Status</th><th>Notes</th></tr></thead>
        <tbody>
          ${checks.map(c => `
            <tr>
              <td style="font-weight:600">${esc(c.label)}</td>
              <td><span class="badge ${c.ok ? 'ok' : 'warn'}">${c.ok ? 'OK' : 'WARN'}</span></td>
              <td style="color:var(--text-muted);font-size:0.82rem">${esc(c.note)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    ${ssotState ? `
    <div class="card">
      <h3>SSOT System State</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.5rem;margin-top:0.75rem;font-size:0.82rem;">
        ${Object.entries(ssotState.checks || {}).map(([k, v]) => `
          <div style="background:var(--surface2);padding:0.65rem;border-radius:8px;border:1px solid var(--border)">
            <div style="color:var(--text-muted);font-size:0.72rem;text-transform:uppercase;margin-bottom:0.2rem">${esc(k)}</div>
            <div class="badge ${v === 'OK' ? 'ok' : v === 'FAIL' ? 'fail' : 'warn'}">${esc(v)}</div>
          </div>
        `).join('')}
      </div>
    </div>` : ''}

    <div class="card">
      <h3>Run Architecture</h3>
      <table class="data-table" style="font-size:0.8rem;">
        <thead><tr><th>Run</th><th>Description</th><th>Status</th></tr></thead>
        <tbody>
          ${[
            ['0',   'Core SSOT + IndexedDB vault'],
            ['1',   'AI provider registry + key vault'],
            ['2',   'AI router + dispatcher + fallback'],
            ['3',   'Supabase installer + migration engine'],
            ['4',   'Auto-heal + error analyzer'],
            ['4.1', 'Health gate + dependency validator'],
            ['5',   'PWA control dashboard'],
            ['6',   'AES-GCM encryption vault'],
            ['7',   'Orchestration engine'],
            ['7.1', 'Wiring validator + auto-repair'],
            ['7.2', 'Runtime bridge + ZIP engine'],
            ['7.3', 'Multi-source ingestion + schema compiler'],
            ['7.4', 'AI Provider Control Dashboard'],
            ['7.5', 'One-click Ollama installer + SSE streaming'],
          ].map(([r, d]) => `
            <tr>
              <td style="font-family:monospace;color:var(--accent-lt)">RUN ${esc(r)}</td>
              <td style="color:var(--text-muted)">${esc(d)}</td>
              <td><span class="badge ok">COMPLETE</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  window.__system = {
    refresh: () => loadSystemPanel(root)
  };
}
