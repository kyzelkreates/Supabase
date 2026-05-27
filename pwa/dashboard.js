/**
 * dashboard.js — Dashboard Boot + Navigation Controller (RUN 5, updated RUN 7)
 *
 * Boots the dashboard:
 *   1. RUN 6: session guard (lock screen if vault locked / session expired)
 *   2. Runs preflight gate check (RUN 4.1)
 *   3. Updates gate pill in topbar
 *   4. Loads default panel (projects)
 *   5. Wires sidebar navigation
 *
 * RUN 7 additions:
 *   - guardSession() call before boot
 *   - Orchestration + RunConsole panels registered
 *   - "orchestration" and "console" panels are execution-gated
 *
 * SSOT Rules:
 * ✔ UI controller only — no backend logic
 * ✔ Session guard via lockScreen.js (RUN 6) is always first
 * ✔ Gate check via preflight-check.js (RUN 4.1) before any execution panel
 * ✔ Panel modules are lazy-loaded on first nav
 * ❌ Never calls server modules directly for execution
 */

import { preflight }              from "./preflight-check.js";
import { guardSession }           from "./lockScreen.js";
import { loadProjectsPanel }      from "./projectPanel.js";
import { loadAIPanel }            from "./aiPanel.js";
import { loadInstallPanel }       from "./installPanel.js";
import { loadLogsPanel }          from "./logsPanel.js";
import { loadSystemPanel }        from "./systemPanel.js";
import { loadOrchestrationPanel } from "./orchestrationPanel.js";
import { loadRunConsole }         from "./runConsole.js";

// ─── State ────────────────────────────────────────────────────────────────────

let _gateResult = null;

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

// Panels that require gate open before loading
const EXECUTION_PANELS = new Set(["install", "ai", "orchestration"]);

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  // RUN 6: session guard — shows lock screen if not authenticated
  const sessionOk = await guardSession();
  if (!sessionOk) return; // Lock screen took over — stop boot

  setPanelRoot("<div style='color:#555;font-size:0.85rem;padding:2rem'>Running preflight check…</div>");
  _gateResult = await runGateCheck();
  await nav("projects", document.querySelector('[data-panel="projects"]'));

  // Session activity extender — reset expiry on any user interaction
  document.addEventListener("click",   _extendSession, { passive: true });
  document.addEventListener("keydown", _extendSession, { passive: true });
}

async function _extendSession() {
  try {
    const { extendSession } = await import("./authSession.js");
    extendSession();
  } catch {}
}

// ─── Gate Check ───────────────────────────────────────────────────────────────

async function runGateCheck() {
  const pill = document.getElementById("gate-pill");
  try {
    const result = await preflight();
    updateGatePill(result);
    return result;
  } catch (err) {
    if (pill) { pill.className = "closed"; pill.textContent = "🚫 Gate Error"; }
    return { systemReady: false, blockRun5: true, gate: "CLOSED", blockingIssues: [err.message], warnings: [], checks: {} };
  }
}

function updateGatePill(result) {
  const pill = document.getElementById("gate-pill");
  if (!pill) return;
  const map = {
    OPEN:   { cls: "open",   label: "✅ Gate Open" },
    WARN:   { cls: "warn",   label: "⚠️ Degraded" },
    CLOSED: { cls: "closed", label: "🚫 Gate Closed" }
  };
  const cfg = map[result.gate] || map.CLOSED;
  pill.className = cfg.cls;
  pill.textContent = cfg.label;
}

// ─── Navigation ───────────────────────────────────────────────────────────────

async function nav(panelName, clickedBtn) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  if (clickedBtn) clickedBtn.classList.add("active");

  // Execution panels need gate open
  if (EXECUTION_PANELS.has(panelName)) {
    if (!_gateResult || _gateResult.blockRun5) {
      showToast("🚫 Gate is closed — check System panel first", "err");
      _gateResult = await runGateCheck();
      await loadSystemPanel(document.getElementById("panel-root"), _gateResult);
      document.querySelector('[data-panel="system"]')?.classList.add("active");
      return;
    }
  }

  const loader = PANELS[panelName];
  if (!loader) return;

  const root = document.getElementById("panel-root");
  root.innerHTML = "<div style='color:#555;font-size:0.85rem'>Loading…</div>";

  try {
    await loader(root, _gateResult);
  } catch (err) {
    root.innerHTML = `<div style="color:#ef4444;padding:1rem">Panel error: ${esc(err.message)}</div>`;
  }
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

// ─── Panel Root Helper ────────────────────────────────────────────────────────

export function setPanelRoot(html) {
  const root = document.getElementById("panel-root");
  if (root) root.innerHTML = html;
}

// ─── Escape ───────────────────────────────────────────────────────────────────

export function esc(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ─── Logout ───────────────────────────────────────────────────────────────────

async function logout() {
  try {
    const { logout: doLogout } = await import("./authSession.js");
    doLogout();
  } catch {}
  location.reload();
}

// ─── Expose to window ─────────────────────────────────────────────────────────

window.__dash = {
  nav,
  runGateCheck,
  showToast,
  logout,
  openSystem:        () => nav("system",        document.querySelector('[data-panel="system"]')),
  openOrchestration: () => nav("orchestration", document.querySelector('[data-panel="orchestration"]'))
};

// ─── Update sidebar HTML to include RUN 7 panels ─────────────────────────────
// Inject new nav items into the sidebar after DOM is ready

function _patchSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  // Add Orchestration + Console nav items if not already present
  if (!document.querySelector('[data-panel="orchestration"]')) {
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

    // Add logout at bottom
    const logoutBtn = document.createElement("button");
    logoutBtn.className = "nav-item";
    logoutBtn.style.marginTop = "auto";
    logoutBtn.innerHTML = `<span class="icon">🔒</span><span>Lock</span>`;
    logoutBtn.onclick = logout;
    sidebar.appendChild(logoutBtn);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", _patchSidebar);
boot();
