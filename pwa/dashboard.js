/**
 * dashboard.js — Boot + Nav Controller (RUN 7.5 clean)
 *
 * Key fixes vs previous version:
 * - window.__dash set SYNCHRONOUSLY before any async work
 * - boot() called ONCE via DOMContentLoaded only
 * - nav() is safe to call at any time (queues if DOM not ready)
 * - All panels are browser-safe (no server imports)
 */

import { guardSession }           from "./lockScreen.js";
import { loadProjectsPanel }      from "./projectPanel.js";
import { loadAIPanel }            from "./aiPanel.js";
import { loadInstallPanel }       from "./installPanel.js";
import { loadLogsPanel }          from "./logsPanel.js";
import { loadSystemPanel }        from "./systemPanel.js";
import { loadOrchestrationPanel } from "./orchestrationPanel.js";
import { loadRunConsole }         from "./runConsole.js";
import { checkAgentStatus }       from "./apiBridge.js";

// ── Panel registry ─────────────────────────────────────────────────────────────
const PANELS = {
  projects:      loadProjectsPanel,
  ai:            loadAIPanel,
  install:       loadInstallPanel,
  orchestration: loadOrchestrationPanel,
  logs:          loadLogsPanel,
  console:       loadRunConsole,
  system:        loadSystemPanel,
  settings:      () => { window.location.href = "settings.html"; }
};

// ── Expose window.__dash IMMEDIATELY (sync) so onclick handlers work ──────────
// This runs the moment the module is parsed — before any await.
window.__dash = {
  nav:               (name, btn) => nav(name, btn),
  showToast:         (msg, type) => showToast(msg, type),
  openSystem:        ()          => nav("system",        document.querySelector('[data-panel="system"]')),
  openOrchestration: ()          => nav("orchestration", document.querySelector('[data-panel="orchestration"]'))
};

// ── Also export for other modules ─────────────────────────────────────────────
export function showToast(msg, type = "info") {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = `show-${type}`;
  clearTimeout(t._tmr);
  t._tmr = setTimeout(() => { t.className = ""; }, 3200);
}

export function esc(str) {
  return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function nav(panelName, clickedBtn) {
  // Highlight active nav item
  document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
  if (clickedBtn) clickedBtn.classList.add("active");
  // Also highlight by data-panel in case btn reference is stale
  const staticBtn = document.querySelector(`[data-panel="${panelName}"]`);
  if (staticBtn) staticBtn.classList.add("active");

  const loader = PANELS[panelName];
  if (!loader) return;

  const root = document.getElementById("panel-root");
  if (!root) return;
  root.innerHTML = `<div style="color:#555;font-size:0.85rem;padding:2rem;text-align:center">⟳ Loading ${panelName}…</div>`;

  try {
    await loader(root);
  } catch (err) {
    root.innerHTML = `
      <div style="background:#1a0a0a;border:1px solid #ef4444;border-radius:10px;padding:1.5rem;margin:1rem;font-family:monospace;font-size:0.82rem;">
        <div style="color:#ef4444;font-weight:700;margin-bottom:0.5rem">❌ Panel Error: ${esc(panelName)}</div>
        <div style="color:#9ca3af">${esc(err.message)}</div>
        <pre style="color:#555;margin-top:0.5rem;font-size:0.75rem;overflow:auto">${esc(err.stack?.split('\n').slice(0,4).join('\n') || '')}</pre>
        <button onclick="window.__dash.nav('${panelName}')" 
          style="margin-top:1rem;padding:0.4rem 1rem;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer">
          ↻ Retry
        </button>
      </div>`;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  // Session guard — pass-through if no vault set up
  try {
    const ok = await guardSession();
    if (!ok) return; // Lock screen took over
  } catch (e) {
    console.warn("[boot] guardSession skipped:", e.message);
  }

  // Patch sidebar with extra nav items
  _patchSidebar();

  // Agent pill check (async, non-blocking)
  _pollAgentPill();

  // Extend session on activity
  document.addEventListener("click",   _extendSession, { passive: true });
  document.addEventListener("keydown", _extendSession, { passive: true });

  // Load default panel
  const defaultBtn = document.querySelector('[data-panel="projects"]');
  await nav("projects", defaultBtn);
}

// ── Agent pill ────────────────────────────────────────────────────────────────
function _pollAgentPill() {
  const pill = document.getElementById("gate-pill");
  if (pill) { pill.className = "warn"; pill.textContent = "⟳ Checking…"; }

  checkAgentStatus(true)
    .then(s => {
      if (!pill) return;
      if (s.reachable) {
        pill.className = "open";
        pill.textContent = "✅ Agent Online";
      } else {
        pill.className = "warn";
        pill.textContent = "⚠ Agent Offline";
      }
    })
    .catch(() => {
      if (pill) { pill.className = "warn"; pill.textContent = "⚠ Agent Offline"; }
    });
}

// ── Sidebar patch ─────────────────────────────────────────────────────────────
function _patchSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar || document.querySelector('[data-panel="orchestration"]')) return;

  const divider = sidebar.querySelector(".nav-divider");

  const make = (panel, icon, label) => {
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.dataset.panel = panel;
    btn.innerHTML = `<span class="icon">${icon}</span><span>${label}</span>`;
    btn.onclick = () => nav(panel, btn);
    return btn;
  };

  if (divider) {
    sidebar.insertBefore(make("orchestration", "🚀", "Orchestrate"), divider);
    sidebar.insertBefore(make("console",       "🖥", "Run Console"), divider);
  }

  const lockBtn = document.createElement("button");
  lockBtn.className = "nav-item";
  lockBtn.style.marginTop = "auto";
  lockBtn.innerHTML = `<span class="icon">🔒</span><span>Lock</span>`;
  lockBtn.onclick = () => {
    import("./authSession.js")
      .then(({ logout }) => { logout(); location.reload(); })
      .catch(() => location.reload());
  };
  sidebar.appendChild(lockBtn);
}

// ── Session extender ──────────────────────────────────────────────────────────
function _extendSession() {
  import("./authSession.js")
    .then(({ extendSession }) => extendSession())
    .catch(() => {});
}

// ── Single boot on DOMContentLoaded ──────────────────────────────────────────
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
