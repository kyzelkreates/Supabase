/**
 * setupStatusPanel.js — AI Environment Setup Panel (RUN 7.5)
 *
 * Full dashboard panel for the one-click Ollama setup experience.
 * Shows system requirements, current state, live install log, and
 * post-setup actions (test Ollama, go to provider dashboard).
 *
 * SSOT Rules:
 * ✔ All agent calls via setupBridge.js
 * ✔ State reads via getPersistedSetupState (SSOT-backed)
 * ✔ Button action delegates to setupAIButton.setupAIEnvironment
 * ✔ Provider store updated via setupAIButton (not directly here)
 */

import { showToast, esc }                   from "./dashboard.js";
import { checkSetupStatus, getPersistedSetupState } from "./api/setupBridge.js";
import { setupAIEnvironment }               from "./setupAIButton.js";

// ─── Panel Entry ─────────────────────────────────────────────────────────────

export async function loadSetupStatusPanel(root) {
  root.innerHTML = `
    <div class="panel-title">🚀 AI Environment Setup</div>

    <!-- Hero card -->
    <div class="card" style="margin-bottom:0.75rem;text-align:center;padding:2rem 1.5rem;">
      <div style="font-size:2.5rem;margin-bottom:0.75rem">🤖</div>
      <h2 style="color:var(--accent-lt);font-size:1.1rem;margin-bottom:0.5rem">One-Click AI Setup</h2>
      <p style="color:#555;font-size:0.85rem;margin-bottom:1.5rem;max-width:380px;margin-left:auto;margin-right:auto">
        Automatically installs Ollama, starts the AI server, and pulls
        <code style="color:#a78bfa">llama3</code> — the primary local AI engine.
      </p>

      <button
        id="setupBtn"
        class="btn btn-primary"
        style="font-size:1rem;padding:0.75rem 2rem;border-radius:10px;"
        onclick="setupAIEnvironment({ outputElementId:'setupOutput', buttonElementId:'setupBtn' })">
        🚀 Setup AI Environment
      </button>
    </div>

    <!-- System requirements -->
    <div class="card" id="sys-req-card" style="margin-bottom:0.75rem;">
      <h3 style="margin-bottom:0.75rem;">System Requirements</h3>
      <div id="sys-req-content">
        <div style="color:#555;font-size:0.82rem">Checking…</div>
      </div>
    </div>

    <!-- Current state -->
    <div class="card" id="current-state-card" style="margin-bottom:0.75rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>Current State</h3>
        <button class="btn btn-secondary btn-sm" onclick="window.__setup.refresh()">↺ Refresh</button>
      </div>
      <div id="current-state-content">
        <div style="color:#555;font-size:0.82rem">Checking…</div>
      </div>
    </div>

    <!-- Live log output -->
    <div class="card" style="margin-bottom:0.75rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <h3>Install Log</h3>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('setupOutput').textContent=''">Clear</button>
      </div>
      <pre id="setupOutput" class="log-output" style="min-height:80px;color:#86efac;font-size:0.75rem;">
Waiting for setup to start…
      </pre>
    </div>

    <!-- Post-setup actions (hidden until ready) -->
    <div class="card" id="post-setup-card" style="display:none;">
      <h3 style="margin-bottom:0.75rem;">✅ Setup Complete — Next Steps</h3>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="window.__setup.testOllama()">🧪 Test Ollama</button>
        <button class="btn btn-secondary btn-sm" onclick="window.__setup.openProviderDash()">🧠 Provider Dashboard</button>
        <button class="btn btn-secondary btn-sm" onclick="window.__setup.openIngestion()">📥 Start Ingestion</button>
      </div>
    </div>
  `;

  window.__setup = {
    refresh:       _loadCurrentState,
    testOllama:    _testOllama,
    openProviderDash: () => import("./aiProviderDashboard.js").then(({ loadAIProviderDashboard }) => loadAIProviderDashboard(root)),
    openIngestion: () => import("./ingestionPanel.js").then(({ loadIngestionPanel }) => loadIngestionPanel(root))
  };

  // Load initial state
  await Promise.all([_loadSysReqs(), _loadCurrentState()]);
}

// ─── System Requirements ──────────────────────────────────────────────────────

async function _loadSysReqs() {
  const el = document.getElementById("sys-req-content");
  if (!el) return;

  // These are checked by the agent — we just show the requirements
  const items = [
    { label: "Operating System",    value: "Linux / macOS / Windows 10+",  ok: true  },
    { label: "Node.js",             value: "v18+ (agent runtime)",          ok: true  },
    { label: "Internet connection", value: "Required for install + pull",   ok: true  },
    { label: "Disk space",          value: "~5 GB (llama3 model)",          ok: null  },
    { label: "RAM",                 value: "8 GB+ recommended",             ok: null  }
  ];

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:0.3rem;">
      ${items.map((item) => `
        <div style="display:flex;align-items:center;gap:0.6rem;font-size:0.8rem;">
          <span style="color:${item.ok === true ? "var(--ok)" : item.ok === false ? "var(--fail)" : "#555"};flex-shrink:0">
            ${item.ok === true ? "✔" : item.ok === false ? "✘" : "●"}
          </span>
          <span style="color:var(--text-muted);min-width:140px">${esc(item.label)}</span>
          <span style="color:#555">${esc(item.value)}</span>
        </div>
      `).join("")}
    </div>
    <div style="margin-top:0.6rem;font-size:0.75rem;color:#555">
      💡 The agent handles binary installation automatically where possible.
      If auto-install fails, visit <a href="https://ollama.com/download" target="_blank" style="color:#a78bfa">ollama.com/download</a>.
    </div>
  `;
}

// ─── Current State ────────────────────────────────────────────────────────────

async function _loadCurrentState() {
  const el = document.getElementById("current-state-content");
  if (!el) return;

  el.innerHTML = `<div style="color:#555;font-size:0.82rem">Checking…</div>`;

  // Try live check first, fall back to persisted state
  const [live, persisted] = await Promise.allSettled([
    checkSetupStatus(),
    getPersistedSetupState()
  ]);

  const liveState      = live.status === "fulfilled" && live.value?.ok ? live.value : null;
  const persistedState = persisted.status === "fulfilled" ? persisted.value?.state : null;

  if (!liveState && !persistedState) {
    el.innerHTML = `<div style="color:#555;font-size:0.82rem">⚠ Agent offline — cannot check state.</div>`;
    return;
  }

  const s = liveState || {};
  const p = persistedState?.ollama || {};

  const stateItems = [
    { label: "Binary",     ok: s.binaryFound,   value: s.binaryFound   ? "Found on PATH" : "Not found" },
    { label: "Server",     ok: s.serverRunning, value: s.serverRunning ? "Running on :11434" : "Not running" },
    { label: "Models",     ok: (s.pulledModels || p.models || []).length > 0,
                           value: ((s.pulledModels || p.models || []).join(", ") || "None pulled") },
    { label: "Status",     ok: s.status === "running",
                           value: _statusLabel(s.status || p.status) }
  ];

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:0.4rem;">
      ${stateItems.map((item) => `
        <div style="display:flex;align-items:center;gap:0.6rem;background:var(--surface2);padding:0.45rem 0.65rem;border-radius:7px;">
          <span style="color:${item.ok ? "var(--ok)" : "var(--fail)"};font-size:0.8rem">
            ${item.ok ? "●" : "○"}
          </span>
          <span style="font-size:0.8rem;color:var(--text-muted);min-width:70px">${esc(item.label)}</span>
          <span style="font-size:0.8rem;color:${item.ok ? "var(--text)" : "#555"}">${esc(item.value)}</span>
        </div>
      `).join("")}
    </div>

    ${s.status === "running" ? `
      <div style="margin-top:0.75rem;background:#14532d;border:1px solid #22c55e;border-radius:8px;padding:0.6rem 0.85rem;font-size:0.8rem;color:#22c55e">
        ✅ Ollama is fully operational — AI environment ready!
      </div>
    ` : `
      <div style="margin-top:0.75rem;font-size:0.78rem;color:#555">
        ${s.status === "not_installed" ? "Click Setup AI Environment to install Ollama automatically." : ""}
        ${s.status === "installed_stopped" ? "Ollama is installed but not running. Click Setup to start it." : ""}
        ${s.status === "running_no_model" ? "Server is running but no model is pulled. Click Setup to pull llama3." : ""}
      </div>
    `}
  `;

  // Show post-setup card if already ready
  if (s.status === "running") {
    const postCard = document.getElementById("post-setup-card");
    if (postCard) postCard.style.display = "";
  }
}

// ─── Post-Setup Test ──────────────────────────────────────────────────────────

async function _testOllama() {
  const output = document.getElementById("setupOutput");
  if (output) output.textContent = "Testing Ollama…\n";
  showToast("Running Ollama test…", "info");
  try {
    const { sendToAgent } = await import("./apiBridge.js");
    const res = await sendToAgent("ollama-health", {});
    const msg = res.ok && res.data?.ok
      ? `✅ Ollama online — models: ${(res.data.models || []).join(", ") || "none"}`
      : `❌ ${res.data?.error || res.error || "Ollama test failed"}`;
    if (output) output.textContent += msg + "\n";
    showToast(msg, res.ok && res.data?.ok ? "ok" : "err");
  } catch (err) {
    if (output) output.textContent += `Error: ${err.message}\n`;
  }
}

function _statusLabel(status) {
  return {
    not_initialized:  "Not initialized",
    not_installed:    "Not installed",
    installed_stopped:"Installed, not running",
    running_no_model: "Running, no model",
    running:          "Running ✓",
    error:            "Error"
  }[status] || status || "Unknown";
}
