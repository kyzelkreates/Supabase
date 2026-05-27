/**
 * aiPanel.js — AI Control Panel (RUN 5)
 *
 * Live interface to RUN 2 AI router.
 * Lets operator send prompts to any task role and see results.
 *
 * SSOT Rules:
 * ✔ Only loaded after gate check passes (dashboard.js enforces this)
 * ✔ Calls aiTasks.js (public API) — never aiRouter.js or aiDispatcher.js directly
 * ✔ Displays provider used, retry count, and fallback state
 * ❌ Never stores AI output to SSOT
 * ❌ Never triggers installs or repairs
 */

import { showToast, esc } from "./dashboard.js";

// AI calls go via the public task API (RUN 2 public surface)
// In a bundled/server context these are real imports.
// In static PWA they fall back to a fetch-based stub.
let _aiTasks = null;

async function getAITasks() {
  if (_aiTasks) return _aiTasks;
  try {
    _aiTasks = await import("../server/aiTasks.js");
  } catch {
    // Static PWA fallback — simulate the API shape
    _aiTasks = {
      runPlanner:   (p) => _mockTask("planner",   p),
      runBuilder:   (p) => _mockTask("builder",   p),
      runValidator: (p) => _mockTask("validator", p),
      runFixer:     (p) => _mockTask("fixer",     p),
      getTaskProvider: (t) => ({ name: "offline", type: "unknown", enabled: false, models: [] }),
      isTaskFallback: (r) => r?.result?.startsWith("[FALLBACK")
    };
  }
  return _aiTasks;
}

// ─── Panel Entry ─────────────────────────────────────────────────────────────

export async function loadAIPanel(root, gateResult) {
  const tasks = await getAITasks();

  // Show provider assignments from routing SSOT
  const routingInfo = await _fetchRoutingInfo(tasks);

  root.innerHTML = `
    <div class="panel-title">🧠 AI Control Panel</div>

    <!-- Provider map -->
    <div class="card" style="margin-bottom:1rem;">
      <h3>Task → Provider Routing</h3>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.5rem;margin-top:0.75rem;">
        ${routingInfo.map((r) => `
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:0.75rem;text-align:center;">
            <div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.25rem">${esc(r.task)}</div>
            <div style="font-weight:700;color:var(--accent-lt);font-size:0.85rem">${esc(r.provider)}</div>
            <div style="font-size:0.68rem;color:#555;margin-top:0.2rem">${esc(r.type)}</div>
          </div>
        `).join("")}
      </div>
    </div>

    <!-- Prompt input -->
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
      <pre id="ai-output" style="background:#060610;border:1px solid var(--border);border-radius:8px;padding:1rem;font-family:monospace;font-size:0.82rem;line-height:1.6;color:#c4b5fd;min-height:80px;max-height:420px;overflow-y:auto;white-space:pre-wrap;"></pre>
    </div>

    <!-- History -->
    <div class="card">
      <h3>Run History <span style="color:#555;font-weight:400">(this session)</span></h3>
      <div id="ai-history" style="margin-top:0.5rem;font-size:0.8rem;color:var(--text-muted);">No runs yet.</div>
    </div>
  `;

  const history = [];

  window.__ai = {
    run: async () => {
      const task   = document.getElementById("ai-task-select").value;
      const prompt = document.getElementById("ai-prompt").value.trim();

      if (!prompt) { showToast("Enter a prompt first", "err"); return; }

      const btn    = document.getElementById("ai-run-btn");
      const status = document.getElementById("ai-status");
      const output = document.getElementById("ai-output");
      const meta   = document.getElementById("ai-meta");

      btn.disabled    = true;
      btn.innerHTML   = `<span class="spinner">⟳</span> Running…`;
      status.textContent = `Routing to ${task}…`;
      output.textContent = "";
      meta.textContent   = "";

      const startMs = Date.now();
      try {
        const t = await getAITasks();
        const taskFnMap = {
          planner:   t.runPlanner,
          builder:   t.runBuilder,
          validator: t.runValidator,
          fixer:     t.runFixer
        };
        const fn = taskFnMap[task];
        if (!fn) throw new Error(`Unknown task: ${task}`);

        const result = await fn(prompt);
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

        output.textContent = result.result || "(empty response)";

        const isFallback = t.isTaskFallback(result);
        meta.innerHTML = [
          `Provider: <strong>${esc(result.provider)}</strong>`,
          `Retries: ${result.retries}`,
          `Time: ${elapsed}s`,
          isFallback ? `<span style="color:var(--warn)">⚠ Fallback</span>` : `<span style="color:var(--ok)">✔ Live</span>`
        ].join(" &nbsp;·&nbsp; ");

        status.textContent = "";
        showToast(`✅ ${task} task complete (${elapsed}s)`, "ok");

        // Add to history
        history.unshift({ task, prompt: prompt.slice(0, 60) + (prompt.length > 60 ? "…" : ""), provider: result.provider, ok: !isFallback, elapsed });
        _renderHistory(history);

      } catch (err) {
        output.textContent = `Error: ${err.message}`;
        status.textContent = "";
        showToast(`AI task failed: ${err.message}`, "err");
      } finally {
        btn.disabled  = false;
        btn.innerHTML = "▶ Run Task";
      }
    },

    clear: () => {
      document.getElementById("ai-prompt").value = "";
      document.getElementById("ai-output").textContent = "";
      document.getElementById("ai-meta").textContent = "";
    }
  };
}

// ─── History Renderer ─────────────────────────────────────────────────────────

function _renderHistory(history) {
  const el = document.getElementById("ai-history");
  if (!el) return;
  if (!history.length) { el.textContent = "No runs yet."; return; }
  el.innerHTML = history.slice(0, 8).map((h) => `
    <div style="display:flex;gap:0.75rem;padding:0.4rem 0;border-bottom:1px solid var(--border);align-items:center;">
      <span style="color:var(--accent-lt);font-weight:600;min-width:70px">${esc(h.task)}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9ca3af">${esc(h.prompt)}</span>
      <span style="color:#555;min-width:80px">${esc(h.provider)}</span>
      <span style="color:#555;min-width:40px">${h.elapsed}s</span>
      <span>${h.ok ? "✔" : "⚠"}</span>
    </div>
  `).join("");
}

// ─── Routing Info ──────────────────────────────────────────────────────────────

async function _fetchRoutingInfo(tasks) {
  const taskNames = ["planner", "builder", "validator", "fixer"];
  return taskNames.map((t) => {
    const p = tasks.getTaskProvider?.(t);
    return { task: t, provider: p?.name || "unknown", type: p?.type || "—" };
  });
}

// ─── Mock (static PWA fallback) ───────────────────────────────────────────────

function _mockTask(task, prompt) {
  return Promise.resolve({
    result: `[OFFLINE MOCK — ${task.toUpperCase()}]\n\nServer modules unavailable in static PWA context.\n\nPrompt received:\n${prompt}`,
    provider: "offline",
    retries: 0,
    ok: false
  });
}
