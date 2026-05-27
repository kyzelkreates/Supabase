/**
 * aiPanel.js — AI Control Panel (browser-safe, RUN 7.5+)
 * Calls agent via apiBridge. Falls back to offline message if agent down.
 */

import { showToast, esc } from "./utils.js";
import { sendToAgent, checkAgentStatus } from "./apiBridge.js";
import { getAIKeys } from "./ai-vault.js";

export async function loadAIPanel(root) {
  const agentStatus = await checkAgentStatus(true).catch(() => ({ reachable: false }));
  const keys = await getAIKeys().catch(() => ({}));
  const hasKeys = keys && Object.keys(keys).filter(k => k !== 'id').some(k => keys[k]);

  root.innerHTML = `
    <div class="panel-title">🧠 AI Control Panel</div>

    <!-- Status banner -->
    <div class="card" style="border-color:${agentStatus.reachable ? 'var(--ok)' : 'var(--warn)'};margin-bottom:1rem;">
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <span style="font-size:1.25rem">${agentStatus.reachable ? '✅' : '⚠️'}</span>
        <div>
          <div style="font-weight:600;color:${agentStatus.reachable ? 'var(--ok)' : 'var(--warn)'}">
            ${agentStatus.reachable ? 'Agent Online — AI execution ready' : 'Agent Offline — start agent on port 4000'}
          </div>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.15rem;">
            ${agentStatus.reachable
              ? `Version: ${agentStatus.version || 'unknown'} · Pipeline: ${agentStatus.pipelineStatus || 'unknown'}`
              : 'Run: <code style="color:#a78bfa">cd agent && node agentRouter.js</code> on your machine'}
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="window.__ai.recheck()">↻ Recheck</button>
      </div>
    </div>

    <!-- Provider routing -->
    <div class="card" style="margin-bottom:1rem;">
      <h3>Task → Provider Routing</h3>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.5rem;margin-top:0.75rem;">
        ${[
          { task: 'planner',   provider: 'Groq',     type: 'cloud' },
          { task: 'builder',   provider: 'Ollama',   type: 'local' },
          { task: 'validator', provider: 'Ollama',   type: 'local' },
          { task: 'fixer',     provider: 'DeepSeek', type: 'cloud' }
        ].map(r => `
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:0.75rem;text-align:center;">
            <div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.25rem">${esc(r.task)}</div>
            <div style="font-weight:700;color:var(--accent-lt);font-size:0.85rem">${esc(r.provider)}</div>
            <div style="font-size:0.68rem;color:#555;margin-top:0.2rem">${esc(r.type)}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Prompt -->
    <div class="card">
      <h3>Run AI Task</h3>
      <div style="margin-top:0.75rem;">
        <div class="form-group">
          <label>Task Role</label>
          <select id="ai-task-select">
            <option value="planner">Planner — Groq (reasoning)</option>
            <option value="builder">Builder — Ollama (local generation)</option>
            <option value="validator">Validator — Ollama (local review)</option>
            <option value="fixer">Fixer — DeepSeek (code repair)</option>
          </select>
        </div>
        <div class="form-group">
          <label>Prompt</label>
          <textarea id="ai-prompt" placeholder="Enter your prompt here…" style="min-height:120px;"></textarea>
        </div>
        <div style="display:flex;gap:0.5rem;align-items:center;">
          <button class="btn btn-primary" id="ai-run-btn" onclick="window.__ai.run()">▶ Run Task</button>
          <button class="btn btn-secondary btn-sm" onclick="window.__ai.clear()">Clear</button>
          <span id="ai-status" style="font-size:0.78rem;color:var(--text-muted);margin-left:0.5rem;"></span>
        </div>
      </div>
    </div>

    <!-- Output -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>Output</h3>
        <div id="ai-meta" style="font-size:0.75rem;color:var(--text-muted);"></div>
      </div>
      <pre id="ai-output" style="background:#060610;border:1px solid var(--border);border-radius:8px;padding:1rem;font-family:monospace;font-size:0.82rem;line-height:1.6;color:#c4b5fd;min-height:80px;max-height:420px;overflow-y:auto;white-space:pre-wrap;">Run a task to see output here.</pre>
    </div>
  `;

  window.__ai = {
    recheck: async () => {
      showToast("Rechecking agent…", "info");
      const s = await checkAgentStatus(true).catch(() => ({ reachable: false }));
      showToast(s.reachable ? "✅ Agent online" : "⚠ Agent offline", s.reachable ? "ok" : "err");
      await loadAIPanel(root);
    },
    run: async () => {
      const task   = document.getElementById("ai-task-select").value;
      const prompt = document.getElementById("ai-prompt").value.trim();
      if (!prompt) { showToast("Enter a prompt first", "err"); return; }

      const btn    = document.getElementById("ai-run-btn");
      const status = document.getElementById("ai-status");
      const output = document.getElementById("ai-output");
      const meta   = document.getElementById("ai-meta");

      btn.disabled = true;
      btn.innerHTML = `<span class="spinner">⟳</span> Running…`;
      status.textContent = `Routing to ${task}…`;
      output.textContent = "";
      meta.textContent = "";

      const startMs = Date.now();
      try {
        const res = await sendToAgent("run-task", { task, prompt }, { timeout: 60000 });
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

        if (res.ok) {
          output.textContent = res.data?.result || res.data?.output || JSON.stringify(res.data, null, 2);
          meta.innerHTML = `Provider: <strong>${esc(res.data?.provider || task)}</strong> &nbsp;·&nbsp; Time: ${elapsed}s`;
          showToast(`✅ ${task} complete (${elapsed}s)`, "ok");
        } else {
          output.textContent = `Agent error: ${res.error}\n\nMake sure the agent is running:\n  cd agent && node agentRouter.js`;
          meta.innerHTML = `<span style="color:var(--fail)">✘ ${esc(res.reason || "error")}</span>`;
          showToast(`Task failed: ${res.error}`, "err");
        }
      } catch (err) {
        output.textContent = `Error: ${err.message}`;
        showToast(err.message, "err");
      } finally {
        btn.disabled = false;
        btn.innerHTML = "▶ Run Task";
        status.textContent = "";
      }
    },
    clear: () => {
      const p = document.getElementById("ai-prompt");
      const o = document.getElementById("ai-output");
      const m = document.getElementById("ai-meta");
      if (p) p.value = "";
      if (o) o.textContent = "Run a task to see output here.";
      if (m) m.textContent = "";
    }
  };
}
