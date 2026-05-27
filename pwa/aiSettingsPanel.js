/**
 * aiSettingsPanel.js — AI Provider Settings Panel (RUN 7.3)
 *
 * Lets the operator configure which AI provider is active, view provider
 * health, and set API keys (stored in vault via vaultWrapper).
 *
 * Reads current config from agent /ai-status endpoint.
 * Writes API key changes to vault via vaultWrapper.saveAIKey().
 *
 * SSOT Rules:
 * ✔ API keys saved to vault (vaultWrapper.saveAIKey) — never in SSOT JSON
 * ✔ Provider config changes sent to agent via sendToAgent("set-ai-provider")
 * ✔ Ollama health checked live via agent
 * ❌ Never hardcodes API keys
 * ❌ Never writes ssot/aiProviderConfig.json directly from PWA
 */

import { showToast, esc }  from "./dashboard.js";
import { sendToAgent }     from "./apiBridge.js";
import { saveAIKey, isUnlocked } from "./vaultWrapper.js";

// ─── Inline Modal ─────────────────────────────────────────────────────────────

export async function openAISettingsModal() {
  // Remove existing modal
  document.getElementById("ai-settings-modal")?.remove();

  const modal = document.createElement("div");
  modal.id = "ai-settings-modal";
  modal.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;
    display:flex;align-items:center;justify-content:center;padding:1rem;
  `;
  modal.innerHTML = `
    <div style="background:#10101e;border:1px solid #252540;border-radius:14px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;padding:1.75rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;">
        <h2 style="color:#a78bfa;font-size:1rem;margin:0">🧠 AI Provider Settings</h2>
        <button onclick="document.getElementById('ai-settings-modal').remove()" style="background:none;border:none;color:#555;font-size:1.1rem;cursor:pointer">✕</button>
      </div>
      <div id="ai-settings-body"><div style="color:#555;font-size:0.85rem">Loading…</div></div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

  await _renderAISettings(document.getElementById("ai-settings-body"));
}

// ─── Dashboard Panel ──────────────────────────────────────────────────────────

export async function loadAISettingsPanel(root) {
  root.innerHTML = `<div class="panel-title">🧠 AI Provider Settings</div><div id="ai-settings-body"></div>`;
  await _renderAISettings(document.getElementById("ai-settings-body"));
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

async function _renderAISettings(container) {
  // Fetch current provider status from agent
  let statusData = null;
  try {
    const res = await sendToAgent("ai-status", {});
    if (res.ok) statusData = res.data;
  } catch {}

  const providers = statusData?.providers || _defaultProviders();
  const active    = statusData?.activeProvider || "ollama";

  container.innerHTML = `
    <!-- Vault warning -->
    ${!isUnlocked() ? `<div style="background:#451a03;border:1px solid #f59e0b;border-radius:7px;padding:0.6rem 0.85rem;font-size:0.78rem;color:#f59e0b;margin-bottom:0.75rem;">⚠ Vault is locked — API keys won't be saved until you unlock.</div>` : ""}

    <!-- Provider list -->
    <div style="margin-bottom:1rem;">
      ${providers.map((p) => _providerRow(p, p.provider === active)).join("")}
    </div>

    <!-- Key entry -->
    <div class="card" style="padding:1rem;">
      <h3 style="margin-bottom:0.75rem;font-size:0.88rem;">Save API Key</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.6rem;">
        <div class="form-group" style="margin:0;">
          <label>Provider</label>
          <select id="key-provider-sel" style="width:100%;background:#16162a;border:1px solid #252540;border-radius:7px;padding:0.55rem;color:#e2e2f0;font-size:0.85rem;">
            <option value="groq">Groq</option>
            <option value="openrouter">OpenRouter</option>
            <option value="together">Together AI</option>
            <option value="huggingface">HuggingFace</option>
          </select>
        </div>
        <div class="form-group" style="margin:0;">
          <label>API Key</label>
          <input id="key-value-input" type="password" placeholder="sk-…" />
        </div>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:0.6rem;" onclick="window.__aiset.saveKey()">
        🔒 Save to Vault
      </button>
    </div>

    <!-- Ollama config -->
    <div class="card" style="padding:1rem;margin-top:0.75rem;">
      <h3 style="margin-bottom:0.75rem;font-size:0.88rem;">🖥 Ollama (Local AI)</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.6rem;">
        <div class="form-group" style="margin:0;">
          <label>Model</label>
          <input id="ollama-model" type="text" placeholder="llama3" value="${esc(statusData?.ollama?.model || "llama3")}" />
        </div>
        <div class="form-group" style="margin:0;">
          <label>Base URL</label>
          <input id="ollama-url" type="text" placeholder="http://localhost:11434" value="${esc(statusData?.ollama?.baseUrl || "http://localhost:11434")}" />
        </div>
      </div>
      <div style="display:flex;gap:0.5rem;margin-top:0.6rem;">
        <button class="btn btn-secondary btn-sm" onclick="window.__aiset.checkOllama()">🩺 Health Check</button>
        <button class="btn btn-primary btn-sm" onclick="window.__aiset.setActive('ollama')">Set Active</button>
      </div>
      <div id="ollama-health-result" style="font-size:0.78rem;margin-top:0.5rem;color:#555;"></div>
    </div>
  `;

  window.__aiset = {
    setActive: async (provider) => {
      const res = await sendToAgent("set-ai-provider", { provider });
      showToast(res.ok ? `✔ Active provider: ${provider}` : `Failed: ${res.error}`, res.ok ? "ok" : "err");
    },

    saveKey: async () => {
      const provider = document.getElementById("key-provider-sel")?.value;
      const key      = document.getElementById("key-value-input")?.value.trim();
      if (!key) { showToast("Enter an API key", "err"); return; }
      if (!isUnlocked()) { showToast("Unlock the vault first", "err"); return; }
      try {
        await saveAIKey(provider, key);
        // Also send to agent so it can use it immediately
        await sendToAgent("set-ai-key", { provider, apiKey: key });
        document.getElementById("key-value-input").value = "";
        showToast(`✔ ${provider} key saved to vault`, "ok");
      } catch (err) {
        showToast(`Failed to save key: ${err.message}`, "err");
      }
    },

    checkOllama: async () => {
      const el = document.getElementById("ollama-health-result");
      if (el) el.textContent = "Checking…";
      const res = await sendToAgent("ollama-health", {});
      if (el) {
        if (res.ok && res.data?.ok) {
          el.style.color = "var(--ok)";
          el.textContent = `✔ Ollama online — models: ${(res.data.models || []).join(", ") || "none pulled"}`;
        } else {
          el.style.color = "var(--fail)";
          el.textContent = `✘ ${res.data?.error || res.error || "Ollama unreachable"}`;
        }
      }
    }
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _providerRow(p, isActive) {
  const statusColor = p.reachable ? "var(--ok)" : "#555";
  const statusIcon  = p.reachable ? "●" : "○";
  return `
    <div style="display:flex;align-items:center;gap:0.75rem;padding:0.55rem 0.75rem;background:var(--surface2);border:1px solid ${isActive ? "#a78bfa" : "var(--border)"};border-radius:8px;margin-bottom:0.35rem;">
      <span style="color:${statusColor};font-size:0.7rem">${statusIcon}</span>
      <div style="flex:1;">
        <div style="font-weight:600;font-size:0.82rem;color:${isActive ? "#a78bfa" : "var(--text-muted)"}">${esc(p.provider)} ${isActive ? "(active)" : ""}</div>
        <div style="font-size:0.72rem;color:#555">${esc(p.activeModel || "—")}</div>
      </div>
      ${!isActive ? `<button class="btn btn-secondary btn-sm" onclick="window.__aiset.setActive('${p.provider}')">Use</button>` : ""}
    </div>
  `;
}

function _defaultProviders() {
  return [
    { provider: "ollama",      activeModel: "llama3",                    reachable: false },
    { provider: "groq",        activeModel: "llama3-70b-8192",           reachable: false },
    { provider: "openrouter",  activeModel: "meta-llama/llama-3-70b",    reachable: false },
    { provider: "together",    activeModel: "Llama-3-70b-chat-hf",       reachable: false },
    { provider: "huggingface", activeModel: "Meta-Llama-3-8B-Instruct",  reachable: false }
  ];
}
