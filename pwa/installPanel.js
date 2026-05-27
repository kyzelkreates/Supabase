/**
 * installPanel.js — Install Panel (browser-safe, RUN 7.5+)
 * All execution via apiBridge → agent. No server imports.
 */

import { showToast, esc } from "./utils.js";
import { sendToAgent, checkAgentStatus } from "./apiBridge.js";

export async function loadInstallPanel(root) {
  const savedTarget = _popInstallTarget();
  const agentStatus = await checkAgentStatus(true).catch(() => ({ reachable: false }));

  root.innerHTML = `
    <div class="panel-title">⚙️ Install Panel</div>

    <!-- Agent status -->
    <div class="card" style="border-color:${agentStatus.reachable ? 'var(--ok)' : 'var(--warn)'};margin-bottom:1rem;">
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <span style="font-size:1.25rem">${agentStatus.reachable ? '✅' : '⚠️'}</span>
        <div>
          <div style="font-weight:600;color:${agentStatus.reachable ? 'var(--ok)' : 'var(--warn)'}">
            ${agentStatus.reachable ? 'Agent Online — install actions enabled' : 'Agent Offline — install requires local agent'}
          </div>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.15rem;">
            ${agentStatus.reachable ? 'Supabase CLI managed by agent' : 'Run: cd agent && node agentRouter.js'}
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="window.__install.recheck()">↻ Recheck</button>
      </div>
    </div>

    <!-- Target project -->
    <div class="card">
      <h3>Target Project</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-top:0.75rem;">
        <div class="form-group" style="margin:0">
          <label>Project Name</label>
          <input id="install-name" type="text" placeholder="my-app" value="${esc(savedTarget?.name || '')}" />
        </div>
        <div class="form-group" style="margin:0">
          <label>Supabase Project Ref</label>
          <input id="install-ref" type="text" placeholder="abcdefghijklmnop" value="${esc(savedTarget?.ref || '')}" />
        </div>
      </div>
      <div class="form-group" style="margin-top:0.75rem;">
        <label>DB Password <span style="color:#555;font-weight:400">(optional)</span></label>
        <input id="install-password" type="password" placeholder="••••••••" />
      </div>
      <div class="form-group">
        <label>AI-Generated SQL <span style="color:#555;font-weight:400">(optional)</span></label>
        <textarea id="install-sql" placeholder="-- Paste AI-generated schema SQL here&#10;CREATE TABLE ..."></textarea>
      </div>
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem;">
        <button class="btn btn-primary" id="install-btn" onclick="window.__install.run()"
          ${!agentStatus.reachable ? 'disabled title="Agent offline"' : ''}>
          ▶ Run Install
        </button>
        <button class="btn btn-secondary" id="heal-btn" onclick="window.__install.heal()"
          ${!agentStatus.reachable ? 'disabled title="Agent offline"' : ''}>
          🔁 Trigger Heal
        </button>
      </div>
    </div>

    <!-- Log output -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>Execution Output</h3>
        <button class="btn btn-secondary btn-sm" onclick="window.__install.clearLog()">Clear</button>
      </div>
      <div id="install-log" class="log-output">Ready. Configure target above and click Run Install.</div>
    </div>
  `;

  window.__install = {
    run: runInstall,
    heal: runHeal,
    recheck: async () => {
      showToast("Rechecking agent…", "info");
      await loadInstallPanel(root);
    },
    clearLog: () => {
      const l = document.getElementById("install-log");
      if (l) l.textContent = "Log cleared.";
    }
  };
}

async function runInstall() {
  const name     = document.getElementById("install-name")?.value.trim();
  const ref      = document.getElementById("install-ref")?.value.trim();
  const password = document.getElementById("install-password")?.value.trim();
  const sql      = document.getElementById("install-sql")?.value.trim();

  if (!name || !ref) { showToast("Project name and ref required", "err"); return; }

  _log(`[${_ts()}] ▶ Starting install: ${name} (${ref})`, "info");
  _setButtons(true);

  const res = await sendToAgent("install-project", { name, ref, password, sql }, { timeout: 120000 });

  if (res.ok) {
    _log(`[${_ts()}] ✔ Install complete`, "ok");
    showToast(`✅ Installed "${name}"`, "ok");
  } else {
    _log(`[${_ts()}] ✘ ${res.error}`, "err");
    showToast(`Install failed: ${res.error}`, "err");
  }
  _setButtons(false);
}

async function runHeal() {
  const name = document.getElementById("install-name")?.value.trim();
  if (!name) { showToast("Project name required", "err"); return; }

  _log(`[${_ts()}] 🔁 Triggering heal for: ${name}`, "info");
  _setButtons(true);

  const res = await sendToAgent("heal-project", { name }, { timeout: 120000 });

  if (res.ok) {
    _log(`[${_ts()}] ✔ Heal complete`, "ok");
    showToast(`✅ Healed "${name}"`, "ok");
  } else {
    _log(`[${_ts()}] ✘ ${res.error}`, "err");
    showToast(`Heal failed: ${res.error}`, "err");
  }
  _setButtons(false);
}

function _log(msg, type = "info") {
  const el = document.getElementById("install-log");
  if (!el) return;
  const cls = { ok: "log-ok", err: "log-err", warn: "log-warn", info: "log-info" }[type] || "";
  el.innerHTML += `\n<span class="${cls}">${esc(msg)}</span>`;
  el.scrollTop = el.scrollHeight;
}

function _setButtons(busy) {
  const ib = document.getElementById("install-btn");
  const hb = document.getElementById("heal-btn");
  if (ib) { ib.disabled = busy; ib.textContent = busy ? "Running…" : "▶ Run Install"; }
  if (hb) { hb.disabled = busy; hb.textContent = busy ? "Running…" : "🔁 Trigger Heal"; }
}

function _ts() { return new Date().toLocaleTimeString(); }

function _popInstallTarget() {
  try {
    const raw = sessionStorage.getItem("install_target");
    if (!raw) return null;
    sessionStorage.removeItem("install_target");
    return JSON.parse(raw);
  } catch { return null; }
}
