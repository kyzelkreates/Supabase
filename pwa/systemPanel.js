/**
 * systemPanel.js — System Status Panel (RUN 5)
 *
 * Live view of RUN 4.1 gate state + all sub-system statuses.
 * Runs a fresh preflight check on mount and shows full details.
 *
 * SSOT Rules:
 * ✔ Read-only diagnostic display
 * ✔ Gate check via preflight-check.js only
 * ✔ Persisted state read from ssot/systemState.json
 * ✔ Updates gate pill in topbar after re-check
 * ❌ Never triggers installs, repairs, or AI tasks
 */

import { preflight }      from "./preflight-check.js";
import { mountHealthDashboard } from "./health-dashboard.js";
import { showToast, esc } from "./dashboard.js";

// ─── Panel Entry ─────────────────────────────────────────────────────────────

export async function loadSystemPanel(root, _gateResult) {
  root.innerHTML = `
    <div class="panel-title">🔬 System Status</div>

    <!-- Live health check widget (from RUN 4.1 health-dashboard.js) -->
    <div class="card" id="health-root" style="min-height:180px;">
      <div style="color:#555;font-size:0.85rem">Running preflight checks…</div>
    </div>

    <!-- Per-system details -->
    <div id="system-detail-grid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin-top:0.25rem;">
      ${_renderDetailCard("RUN 3", "Supabase Installer", "run3-detail")}
      ${_renderDetailCard("RUN 4", "Auto-Heal Engine",   "run4-detail")}
      ${_renderDetailCard("RUN 2", "AI Router",          "ai-detail")}
      ${_renderDetailCard("RUN 0/1", "Vault",            "vault-detail")}
    </div>

    <!-- SSOT file quick-view -->
    <div class="card" style="margin-top:1rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>SSOT State Files</h3>
        <button class="btn btn-secondary btn-sm" onclick="window.__system.refreshFiles()">↻ Refresh</button>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem;" id="ssot-file-tabs">
        ${["systemState","installState","repairState","run-state"].map((f,i) => `
          <button class="btn btn-secondary btn-sm" style="${i===0?"background:var(--accent-dim);border-color:var(--accent-lt);color:var(--accent-lt);":""}"
            onclick="window.__system.viewFile('${f}', this)">${f}.json</button>
        `).join("")}
      </div>
      <pre id="ssot-file-view" class="log-output" style="max-height:280px;color:#9ca3af;">Select a file above to view its contents.</pre>
    </div>

    <!-- Actions -->
    <div class="card" style="margin-top:0.25rem;">
      <h3 style="margin-bottom:0.75rem;">Actions</h3>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="window.__system.rerunGate()">↻ Re-run Gate Check</button>
        <button class="btn btn-secondary btn-sm" onclick="window.__system.viewFile('run-state', null)">View Run Log</button>
        <button class="btn btn-secondary btn-sm" onclick="window.location.href='settings.html'">⚙ Provider Settings</button>
      </div>
    </div>
  `;

  // Mount the RUN 4.1 health dashboard widget
  const healthEl = document.getElementById("health-root");
  const result = await mountHealthDashboard(healthEl);

  // Fill detail cards from last result
  if (result) _fillDetailCards(result);

  // Load default SSOT file view
  await _loadFileView("systemState");

  window.__system = {
    rerunGate: async () => {
      showToast("Running gate check…", "info");
      const newResult = await preflight();
      window.__dash?.runGateCheck?.(); // updates topbar pill
      await mountHealthDashboard(document.getElementById("health-root"));
      _fillDetailCards(newResult);
      showToast(`Gate: ${newResult.gate}`, newResult.systemReady ? "ok" : "err");
    },
    viewFile: async (name, btn) => {
      if (btn) {
        document.querySelectorAll("#ssot-file-tabs button").forEach((b) => b.style.cssText = "");
        btn.style.cssText = "background:var(--accent-dim);border-color:var(--accent-lt);color:var(--accent-lt);";
      }
      await _loadFileView(name);
    },
    refreshFiles: () => {
      const activeBtn = document.querySelector("#ssot-file-tabs button[style*='accent-dim']");
      const name = activeBtn?.textContent?.replace(".json","") || "systemState";
      _loadFileView(name);
    }
  };
}

// ─── Detail Cards ─────────────────────────────────────────────────────────────

function _renderDetailCard(run, label, id) {
  return `
    <div class="card" style="padding:1rem;">
      <div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em">${run}</div>
      <div style="font-weight:600;color:var(--accent-lt);margin:0.15rem 0 0.5rem">${label}</div>
      <div id="${id}" style="font-size:0.82rem;color:#555">Checking…</div>
    </div>
  `;
}

function _fillDetailCards(result) {
  const map = {
    "run3-detail":  { status: result.checks?.run3_installer, rawKey: "run3" },
    "run4-detail":  { status: result.checks?.run4_healer,    rawKey: "run4" },
    "ai-detail":    { status: result.checks?.ai_router,      rawKey: "ai_router" },
    "vault-detail": { status: result.checks?.vault,          rawKey: "vault" }
  };

  for (const [id, info] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const s = info.status || "unknown";
    const cls = { OK: "ok", WARN: "warn", FAIL: "fail", UNKNOWN: "unknown" }[s] || "unknown";
    const raw = result.rawChecks?.[info.rawKey];
    el.innerHTML = `
      <span class="badge ${cls}" style="margin-bottom:0.35rem;">${s}</span>
      ${raw?.detail ? `<div style="color:#9ca3af;font-size:0.78rem;margin-top:0.35rem;line-height:1.4">${esc(raw.detail)}</div>` : ""}
      ${raw?.checks?.length ? `
        <div style="margin-top:0.35rem;">
          ${raw.checks.map((c) => `
            <div style="font-size:0.72rem;color:${c.ok?"var(--ok)":"var(--fail)"};">
              ${c.ok ? "✔" : "✘"} ${esc(c.name)}: ${esc(c.detail)}
            </div>
          `).join("")}
        </div>
      ` : ""}
    `;
  }
}

// ─── SSOT File Viewer ──────────────────────────────────────────────────────────

async function _loadFileView(name) {
  const el = document.getElementById("ssot-file-view");
  if (!el) return;
  el.textContent = "Loading…";
  try {
    const res = await fetch(`../ssot/${name}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    el.textContent = JSON.stringify(json, null, 2);
  } catch (err) {
    el.textContent = `Error: ${err.message}`;
  }
}
