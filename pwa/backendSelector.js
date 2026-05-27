/**
 * backendSelector.js — Backend Target + Compile Panel (RUN 7.3)
 *
 * Lets the operator choose output targets (Supabase / Firebase / both),
 * then triggers schema compilation via the agent.
 *
 * SSOT Rules:
 * ✔ All API calls via sendToAgent (apiBridge)
 * ✔ Mode selection stored locally — never in SSOT
 * ✔ Compilation result displayed with raw SQL/JSON preview
 */

import { showToast, esc } from "./dashboard.js";
import { sendToAgent }    from "./apiBridge.js";

export async function openBackendSelector(ingestionResult) {
  // Find a suitable container — inject into the last card of ingestion panel
  let root = document.getElementById("ingest-result");
  if (!root) { root = document.getElementById("panel-root"); }

  const compilationCard = document.createElement("div");
  compilationCard.className = "card";
  compilationCard.id = "backend-selector-card";
  compilationCard.innerHTML = `
    <h3 style="margin-bottom:0.75rem;">🎯 Select Output Backends</h3>

    <div style="display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap;">
      ${_targetBtn("supabase", "⚡ Supabase", true)}
      ${_targetBtn("firebase", "🔥 Firebase", false)}
      ${_targetBtn("both",     "⚡🔥 Both",   false)}
    </div>

    <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem;">
      <div style="font-size:0.8rem;color:var(--text-muted)">
        AI: <span id="active-provider-label" style="color:var(--accent-lt)">loading…</span>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="window.__bsel.changeProvider()">Switch AI →</button>
    </div>

    <div style="display:flex;gap:0.5rem;">
      <button class="btn btn-primary" id="compile-btn" onclick="window.__bsel.compile()">
        🧠 Compile Schema
      </button>
      <button class="btn btn-secondary" id="deploy-btn" onclick="window.__bsel.deploy()" style="display:none">
        🚀 Deploy
      </button>
    </div>

    <div id="compile-output" style="margin-top:1rem;"></div>
  `;

  root.after ? root.after(compilationCard) : root.appendChild(compilationCard);

  // Load current provider
  const statusRes = await sendToAgent("ai-status", {}).catch(() => ({ ok: false }));
  const provLabel = document.getElementById("active-provider-label");
  if (provLabel) provLabel.textContent = statusRes.ok ? (statusRes.data?.activeProvider || "ollama") : "ollama (offline?)";

  let _selectedTarget = "supabase";

  window.__bsel = {
    selectTarget: (t) => {
      _selectedTarget = t;
      document.querySelectorAll(".target-btn").forEach((b) => {
        const active = b.dataset.target === t;
        b.style.borderColor = active ? "#a78bfa" : "var(--border)";
        b.style.background  = active ? "#2d1b69" : "var(--surface2)";
      });
    },

    changeProvider: () => {
      import("./aiSettingsPanel.js").then(({ openAISettingsModal }) => openAISettingsModal()).catch(() => showToast("AI Settings panel not loaded", "err"));
    },

    compile: async () => {
      const btn = document.getElementById("compile-btn");
      const out = document.getElementById("compile-output");
      if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner">⟳</span> Compiling…`; }
      if (out) out.innerHTML = "";

      try {
        const res = await sendToAgent("compile-schema", {
          projectId:   ingestionResult.projectId,
          projectName: ingestionResult.projectName,
          target:      _selectedTarget
        }, { timeout: 180_000 });

        if (res.ok) {
          _renderCompileResult(res.data, out);
          showToast(`✔ Schema compiled via ${res.data.provider}`, "ok");
          const deployBtn = document.getElementById("deploy-btn");
          if (deployBtn) deployBtn.style.display = "";
          window.__bsel._lastCompile = res.data;
        } else {
          if (out) out.innerHTML = `<div style="color:var(--fail);font-size:0.82rem">Compilation failed: ${esc(res.error)}</div>`;
          showToast(`Compile failed: ${res.error}`, "err");
        }
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = "🧠 Compile Schema"; }
      }
    },

    deploy: async () => {
      if (!window.__bsel._lastCompile) return;
      showToast("Deploy triggered — check orchestration panel", "info");
      // Route to orchestration panel for actual deploy
      window.__dash?.openOrchestration?.();
    }
  };

  // Wire target buttons
  document.querySelectorAll(".target-btn").forEach((b) => {
    b.addEventListener("click", () => window.__bsel.selectTarget(b.dataset.target));
  });

  // Select supabase by default
  window.__bsel.selectTarget("supabase");
}

function _renderCompileResult(data, container) {
  if (!container) return;
  const supabase = data.supabase;
  const firebase = data.firebase;
  container.innerHTML = `
    ${supabase ? _outputBlock("⚡ Supabase SQL", supabase.content, supabase.ok, "sql") : ""}
    ${firebase ? _outputBlock("🔥 Firebase Schema", firebase.content, firebase.ok, "json") : ""}
    <div style="font-size:0.75rem;color:#555;margin-top:0.5rem;">
      Provider: <strong style="color:var(--accent-lt)">${esc(data.provider)}</strong>
      ${data.usedFallback ? " (fallback)" : ""}
      · ${esc(data.duration || "")}
    </div>
  `;
}

function _outputBlock(title, content, ok, lang) {
  return `
    <div style="margin-bottom:0.75rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem;">
        <span style="font-size:0.8rem;font-weight:600;color:${ok ? "var(--ok)" : "var(--warn)"}">${ok ? "✔" : "⚠"} ${esc(title)}</span>
        <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText(this.closest('div').querySelector('pre').textContent)">Copy</button>
      </div>
      <pre class="log-output" style="max-height:280px;color:${lang === "sql" ? "#86efac" : "#93c5fd"};font-size:0.72rem;">${esc(content || "")}</pre>
    </div>
  `;
}

function _targetBtn(id, label, active) {
  return `
    <button class="target-btn" data-target="${id}" style="
      background:${active ? "#2d1b69" : "var(--surface2)"};
      border:2px solid ${active ? "#a78bfa" : "var(--border)"};
      border-radius:8px;
      padding:0.45rem 0.85rem;
      color:${active ? "#a78bfa" : "var(--text-muted)"};
      font-size:0.82rem;
      font-weight:600;
      cursor:pointer;
      transition:all 0.15s;
    ">${esc(label)}</button>
  `;
}
