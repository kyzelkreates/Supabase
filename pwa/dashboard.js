/**
 * dashboard.js — Dashboard Boot + Navigation Controller
 * Fully browser-safe. No server imports. No gate blocking.
 */

import { guardSession }      from "./lockScreen.js";
import { loadProjectsPanel } from "./projectPanel.js";
import { loadAIPanel }       from "./aiPanel.js";
import { loadInstallPanel }  from "./installPanel.js";
import { loadLogsPanel }     from "./logsPanel.js";
import { loadSystemPanel }   from "./systemPanel.js";
import { loadOrchestrationPanel } from "./orchestrationPanel.js";
import { loadRunConsole }    from "./runConsole.js";
import { checkAgentStatus }  from "./apiBridge.js";

// ─── Panel registry ───────────────────────────────────────────────────────────

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

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    const ok = await guardSession();
    if (!ok) return;
  } catch (e) {
    console.warn("[dashboard] guardSession error (ignored):", e.message);
  }

  // Async gate pill — don't block panel load
  _updateGatePill({ gate: "WARN", label: "⟳ Checking…", cls: "warn" });
  checkAgentStatus(true).then((s) => {
    _updateGatePill(s.reachable
      ? { gate: "OPEN",   label: "✅ Agent Online", cls: "open" }
      : { gate: "WARN",   label: "⚠ Agent Offline", cls: "warn" }
    );
  }).catch(() => {
    _updateGatePill({ gate: "WARN", label: "⚠ Agent Offline", cls: "warn" });
  });

  _patchSidebar();

  // Extend session on activity
  document.addEventListener("click",   _extendSession, { passive: true });
  document.addEventListener("keydown", _extendSession, { passive: true });

  // Load default panel
  await nav("projects", document.querySelector('[data-panel="projects"]'));
}

// ─── Gate Pill ────────────────────────────────────────────────────────────────

function _updateGatePill({ cls, label }) {
  const pill = document.getElementById("gate-pill");
  if (!pill) return;
  pill.className = cls;
  pill.textContent = label;
}

// ─── Navigation ───────────────────────────────────────────────────────────────

async function nav(panelName, clickedBtn) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  if (clickedBtn) clickedBtn.classList.add("active");

  const loader = PANELS[panelName];
  if (!loader) return;

  const root = document.getElementById("panel-root");
  if (!root) return;
  root.innerHTML = `<div style="color:#555;font-size:0.85rem;padding:2rem">Loading…</div>`;

  try {
    // Pass a safe gateResult stub — panels degrade gracefully if agent offline
    const gateResult = {
      systemReady: true,
      blockRun5: false,
      gate: "WARN",
      warnings: ["Local agent offline — execution features require agent on port 4000"],
      blockingIssues: [],
      checks: {}
    };
    await loader(root, gateResult);
  } catch (err) {
    root.innerHTML = `
      <div style="color:#ef4444;padding:2rem;font-family:monospace;font-size:0.85rem;">
        <strong>Panel Error: ${esc(panelName)}</strong><br><br>
        ${esc(err.message)}<br><br>
        <span style="color:#555">${esc(err.stack?.split('\n').slice(0,3).join('\n') || '')}</span>
      </div>`;
  }
}

// ─── Sidebar patch ────────────────────────────────────────────────────────────

function _patchSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar || document.querySelector('[data-panel="orchestration"]')) return;

  const divider = sidebar.querySelector(".nav-divider");
  if (divider) {
    const orchBtn = document.createElement("button");
    orchBtn.className = "nav-item";
    orchBtn.dataset.panel = "orchestration";
    orchBtn.innerHTML = `<span class="icon">🚀</span><span>Orchestrate</span>`;
    orchBtn.onclick = () => window.__dash.nav("orchestration", orchBtn);
    sidebar.insertBefore(orchBtn, divider);

    const consBtn = document.createElement("button");
    consBtn.className = "nav-item";
    consBtn.dataset.panel = "console";
    consBtn.innerHTML = `<span class="icon">🖥</span><span>Run Console</span>`;
    consBtn.onclick = () => window.__dash.nav("console", consBtn);
    sidebar.insertBefore(consBtn, divider);
  }

  const lockBtn = document.createElement("button");
  lockBtn.className = "nav-item";
  lockBtn.style.marginTop = "auto";
  lockBtn.innerHTML = `<span class="icon">🔒</span><span>Lock</span>`;
  lockBtn.onclick = _logout;
  sidebar.appendChild(lockBtn);
}

// ─── Toast ────────────────────────────────────────────────────────────────────

export function showToast(msg, type = "info") {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `show-${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.className = ""; }, 3200);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function esc(str) {
  return String(str ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function _extendSession() {
  try {
    import("./authSession.js").then(({ extendSession }) => extendSession()).catch(() => {});
  } catch {}
}

function _logout() {
  try {
    import("./authSession.js").then(({ logout }) => { logout(); location.reload(); }).catch(() => location.reload());
  } catch { location.reload(); }
}

// ─── Global API ──────────────────────────────────────────────────────────────

window.__dash = {
  nav,
  showToast,
  openSystem:        () => nav("system",        document.querySelector('[data-panel="system"]')),
  openOrchestration: () => nav("orchestration", document.querySelector('[data-panel="orchestration"]'))
};

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", boot);
boot();
