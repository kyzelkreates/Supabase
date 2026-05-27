/**
 * logsPanel.js — Log Viewer (browser-safe, RUN 7.5+)
 * Reads SSOT JSON files as static assets. No server imports.
 */

import { showToast, esc } from "./utils.js";

// ─── Session log bus ──────────────────────────────────────────────────────────
const _sessionLog = [];
export function logEvent(msg, type = "info") {
  _sessionLog.unshift({ ts: new Date().toISOString(), msg: String(msg), type });
  if (_sessionLog.length > 200) _sessionLog.pop();
}

// ─── Panel ────────────────────────────────────────────────────────────────────
export async function loadLogsPanel(root) {
  root.innerHTML = `
    <div class="panel-title">📜 Logs</div>
    <div style="display:flex;gap:0.25rem;margin-bottom:1rem;flex-wrap:wrap;">
      ${["Session","Install","Repair","System"].map((t, i) => `
        <button class="btn btn-secondary btn-sm log-tab" data-tab="${t.toLowerCase()}"
          style="${i === 0 ? 'background:var(--accent-dim);border-color:var(--accent-lt);color:var(--accent-lt);' : ''}"
          onclick="window.__logs.tab(this,'${t.toLowerCase()}')">${t}</button>
      `).join('')}
      <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="window.__logs.refresh()">↻</button>
      <button class="btn btn-danger btn-sm" onclick="window.__logs.clearSession()">Clear Session</button>
    </div>
    <div id="log-pane" class="log-output" style="min-height:420px;max-height:600px;">Loading…</div>
    <div style="margin-top:0.4rem;font-size:0.75rem;color:var(--text-muted);" id="log-footer"></div>
  `;

  let _active = "session";

  const render = async (tab) => {
    _active = tab;
    const pane = document.getElementById("log-pane");
    pane.textContent = "Loading…";
    try {
      switch (tab) {
        case "session": pane.innerHTML = _renderSession(); break;
        case "install": pane.innerHTML = await _renderJSON("ssot/installState.json", _fmtInstall); break;
        case "repair":  pane.innerHTML = await _renderJSON("ssot/repairState.json",  _fmtRepair);  break;
        case "system":  pane.innerHTML = await _renderJSON("ssot/systemState.json",  _fmtSystem);  break;
      }
    } catch (e) {
      pane.innerHTML = `<span class="log-err">Error: ${esc(e.message)}</span>`;
    }
    const footer = document.getElementById("log-footer");
    if (footer) footer.textContent = `${pane.innerHTML.split('\n').length} lines`;
  };

  window.__logs = {
    tab: (btn, tab) => {
      document.querySelectorAll(".log-tab").forEach(b => b.style.cssText = "");
      btn.style.cssText = "background:var(--accent-dim);border-color:var(--accent-lt);color:var(--accent-lt);";
      render(tab);
    },
    refresh: () => render(_active),
    clearSession: () => { _sessionLog.length = 0; render("session"); showToast("Session log cleared", "info"); }
  };

  render("session");
}

// ─── Renderers ────────────────────────────────────────────────────────────────

function _renderSession() {
  if (!_sessionLog.length) return `<span style="color:#555">No session events yet.</span>`;
  return _sessionLog.map(e => {
    const t = new Date(e.ts).toLocaleTimeString();
    const cls = { ok:"log-ok", err:"log-err", warn:"log-warn", info:"log-info" }[e.type] || "";
    return `<span class="${cls}">[${t}] ${esc(e.msg)}</span>`;
  }).join("\n");
}

async function _renderJSON(path, fmt) {
  const r = await fetch(path);
  if (!r.ok) return `<span class="log-warn">${esc(path)} not available (HTTP ${r.status})</span>`;
  const json = await r.json();
  return fmt(json);
}

function _fmtInstall(s) {
  const lines = [
    `<span class="log-info">── Install State ──</span>`,
    `Status:   <span class="${s.status === 'installed' ? 'log-ok' : 'log-warn'}">${esc(s.status || 'idle')}</span>`,
    `Project:  ${esc(s.currentProject || '—')}`,
    `Retries:  ${s.retryCount || 0} / ${s.maxRetries || 3}`,
    `Updated:  ${esc(s.updatedAt || '—')}`,
  ];
  const migrations = s.completedMigrations || {};
  const projects = Object.keys(migrations);
  if (projects.length) {
    lines.push(`\n<span class="log-info">── Completed Migrations ──</span>`);
    projects.forEach(p => {
      lines.push(`  <span class="log-info">${esc(p)}</span>`);
      (migrations[p] || []).forEach(f => lines.push(`    <span class="log-ok">✔ ${esc(f)}</span>`));
    });
  }
  return lines.join("\n");
}

function _fmtRepair(s) {
  const lines = [
    `<span class="log-info">── Repair State ──</span>`,
    `Status:  <span class="${s.status === 'healed' ? 'log-ok' : 'log-warn'}">${esc(s.status || 'idle')}</span>`,
    `Count:   ${s.repairCount || 0} / ${s.maxRepairs || 3}`,
    `Updated: ${esc(s.updatedAt || '—')}`,
  ];
  const history = s.repairHistory || [];
  if (history.length) {
    lines.push(`\n<span class="log-info">── History ──</span>`);
    history.forEach(h => {
      const cls = h.success ? "log-ok" : "log-err";
      lines.push(`<span class="${cls}">  [${esc(h.timestamp?.slice(0,19).replace('T',' ') || '?')}] ${esc(h.errorType)} → ${h.success ? 'HEALED' : esc(h.error || 'FAIL')}</span>`);
    });
  }
  return lines.join("\n");
}

function _fmtSystem(s) {
  const gateCls = { OPEN:"log-ok", WARN:"log-warn", CLOSED:"log-err" }[s.gate] || "";
  const lines = [
    `<span class="log-info">── System State ──</span>`,
    `Gate:    <span class="${gateCls}">${esc(s.gate || 'UNKNOWN')}</span>`,
    `Ready:   ${s.systemReady ? '<span class="log-ok">YES</span>' : '<span class="log-err">NO</span>'}`,
    `Checked: ${esc(s.lastCheck || '—')}`,
  ];
  if (s.blockingIssues?.length) {
    lines.push(`\n<span class="log-info">── Blocking Issues ──</span>`);
    s.blockingIssues.forEach(i => lines.push(`  <span class="log-err">✘ ${esc(i)}</span>`));
  }
  if (s.warnings?.length) {
    lines.push(`\n<span class="log-info">── Warnings ──</span>`);
    s.warnings.forEach(w => lines.push(`  <span class="log-warn">⚠ ${esc(w)}</span>`));
  }
  return lines.join("\n");
}
