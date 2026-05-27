/**
 * runConsole.js — Run Console Panel (browser-safe, RUN 7.5+)
 */

import { showToast, esc } from "./dashboard.js";
import { sendToAgent, getAgentURL } from "./apiBridge.js";

export async function loadRunConsole(root) {
  root.innerHTML = `
    <div class="panel-title">🖥 Run Console</div>

    <div class="card" style="margin-bottom:1rem;">
      <h3>Agent Endpoint</h3>
      <div style="display:flex;gap:0.5rem;margin-top:0.75rem;">
        <input id="agent-url-input" type="text" placeholder="http://localhost:4000"
          value="${esc(getAgentURL())}" style="flex:1" />
        <button class="btn btn-secondary btn-sm" onclick="window.__console.setURL()">Set URL</button>
      </div>
      <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.5rem;">
        Override to point at a remote agent (VPS, Railway, Render, ngrok tunnel, etc.)
      </div>
    </div>

    <div class="card">
      <h3>Send Command</h3>
      <div style="margin-top:0.75rem;">
        <div class="form-group">
          <label>Endpoint</label>
          <input id="cmd-endpoint" type="text" placeholder="e.g. status, run-task, setup-ai" />
        </div>
        <div class="form-group">
          <label>Payload (JSON)</label>
          <textarea id="cmd-payload" placeholder='{"key": "value"}' style="min-height:80px;font-family:monospace;"></textarea>
        </div>
        <button class="btn btn-primary" onclick="window.__console.send()">▶ Send</button>
      </div>
    </div>

    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>Response</h3>
        <button class="btn btn-secondary btn-sm" onclick="window.__console.clear()">Clear</button>
      </div>
      <pre id="console-output" style="background:#060610;border:1px solid var(--border);border-radius:8px;padding:1rem;font-family:monospace;font-size:0.8rem;line-height:1.6;color:#9ca3af;min-height:120px;max-height:400px;overflow-y:auto;white-space:pre-wrap;">Waiting for command…</pre>
    </div>
  `;

  window.__console = {
    setURL: () => {
      const url = document.getElementById("agent-url-input")?.value.trim();
      if (!url) return;
      import("./apiBridge.js").then(({ setAgentURL }) => {
        setAgentURL(url);
        showToast(`Agent URL set to ${url}`, "ok");
      });
    },
    send: async () => {
      const endpoint = document.getElementById("cmd-endpoint")?.value.trim();
      const payloadRaw = document.getElementById("cmd-payload")?.value.trim();
      const output = document.getElementById("console-output");

      if (!endpoint) { showToast("Enter an endpoint", "err"); return; }

      let payload = {};
      if (payloadRaw) {
        try { payload = JSON.parse(payloadRaw); }
        catch { showToast("Invalid JSON payload", "err"); return; }
      }

      output.textContent = "Sending…";
      const res = await sendToAgent(endpoint, payload, { timeout: 30000 });
      output.textContent = JSON.stringify(res, null, 2);
      showToast(res.ok ? "✅ Response received" : `✘ ${res.reason}`, res.ok ? "ok" : "err");
    },
    clear: () => {
      const o = document.getElementById("console-output");
      if (o) o.textContent = "Waiting for command…";
    }
  };
}
