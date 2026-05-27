/**
 * aiProviderDashboard.js — AI Provider Control Panel (RUN 7.4)
 *
 * Full dashboard panel for configuring, testing, and managing all
 * AI providers. Replaces the inline modal in aiSettingsPanel.js with
 * a complete, always-visible control surface.
 *
 * Features:
 *   - Live provider health grid with latency badges
 *   - Enable/disable toggle per provider
 *   - Drag-to-reorder fallback chain
 *   - Per-provider live test with response preview
 *   - "Test All" with parallel results
 *   - Ollama model selector (live model list from agent)
 *   - API key entry (vault-routed, never localStorage)
 *   - Active provider selector
 *
 * SSOT Rules:
 * ✔ Config reads/writes via providerStore.js only
 * ✔ Tests run via providerTester.js only
 * ✔ API keys saved via providerStore.saveProviderKey (vault)
 * ✔ Zero direct localStorage or fetch calls in this file
 * ❌ Never stores or displays API key values
 */

import { showToast, esc }                              from "./utils.js";
import {
  getConfig, getOrderedProviders,
  setActiveProvider, updateProvider, setFallbackOrder,
  saveProviderKey, hasProviderKey
}                                                       from "./providerStore.js";
import { testProvider, testAllProviders }               from "./providerTester.js";
import { sendToAgent }                                  from "./apiBridge.js";
import { isUnlocked }                                   from "./vaultWrapper.js";

// ─── Panel Entry ─────────────────────────────────────────────────────────────

export async function loadAIProviderDashboard(root) {
  root.innerHTML = `<div class="panel-title">🧠 AI Provider Control Panel</div><div id="apd-body"></div>`;
  await _render(document.getElementById("apd-body"));
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

async function _render(container) {
  const cfg       = getConfig();
  const providers = getOrderedProviders();

  // Check which providers have vault keys (async, best-effort)
  const keyStatus = {};
  await Promise.allSettled(
    ["groq","openrouter","together","huggingface"].map(async (id) => {
      keyStatus[id] = await hasProviderKey(id);
    })
  );

  container.innerHTML = `

    <!-- Header: active provider + test-all -->
    <div class="card" style="margin-bottom:0.75rem;">
      <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
        <div>
          <div style="font-size:0.72rem;color:#555;text-transform:uppercase;letter-spacing:0.05em">Active Provider</div>
          <div style="font-size:1rem;font-weight:700;color:var(--accent-lt);margin-top:0.15rem" id="apd-active-label">
            ${_providerIcon(cfg.activeProvider)} ${esc(_providerLabel(cfg.activeProvider))}
          </div>
        </div>
        <div style="margin-left:auto;display:flex;gap:0.5rem;">
          <button class="btn btn-secondary btn-sm" id="apd-test-all-btn" onclick="window.__apd.testAll()">
            ⚡ Test All
          </button>
          <button class="btn btn-secondary btn-sm" onclick="window.__apd.refresh()">
            ↺ Refresh
          </button>
        </div>
      </div>
    </div>

    <!-- Provider grid -->
    <div id="apd-provider-grid">
      ${providers.map((p) => _renderProviderCard(p, keyStatus[p.id])).join("")}
    </div>

    <!-- Fallback order editor -->
    <div class="card" style="margin-top:0.75rem;">
      <h3 style="margin-bottom:0.75rem;">Fallback Chain Order</h3>
      <div style="font-size:0.78rem;color:#555;margin-bottom:0.6rem;">
        AI tries providers from left to right if the primary fails.
      </div>
      <div id="fallback-chain" style="display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center;">
        ${_renderFallbackChain(cfg.fallbackOrder)}
      </div>
    </div>

    <!-- Ollama config card -->
    <div class="card" style="margin-top:0.75rem;" id="ollama-config-card">
      <h3 style="margin-bottom:0.75rem;">🖥 Ollama Local Configuration</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:0.75rem;">
        <div class="form-group" style="margin:0;">
          <label>Base URL</label>
          <input id="ollama-base-url" type="text" value="${esc(cfg.providers.ollama?.baseUrl || "http://localhost:11434")}" placeholder="http://localhost:11434" />
        </div>
        <div class="form-group" style="margin:0;">
          <label>Model</label>
          <input id="ollama-model-input" type="text" value="${esc(cfg.providers.ollama?.model || "llama3")}" placeholder="llama3" />
        </div>
      </div>
      <div id="ollama-models-list" style="margin-bottom:0.75rem;"></div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button class="btn btn-secondary btn-sm" onclick="window.__apd.saveOllamaConfig()">💾 Save Config</button>
        <button class="btn btn-secondary btn-sm" onclick="window.__apd.listOllamaModels()">📋 List Models</button>
        <button class="btn btn-primary btn-sm"   onclick="window.__apd.testSingle('ollama')">🧪 Test Ollama</button>
      </div>
    </div>

    <!-- API Key entry card -->
    <div class="card" style="margin-top:0.75rem;">
      <h3 style="margin-bottom:0.75rem;">🔑 API Keys</h3>
      ${!isUnlocked() ? `<div style="background:#451a03;border:1px solid #f59e0b;border-radius:7px;padding:0.6rem;font-size:0.78rem;color:#f59e0b;margin-bottom:0.75rem;">⚠ Unlock the vault before saving keys.</div>` : ""}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem;">
        <div class="form-group" style="margin:0;">
          <label>Provider</label>
          <select id="key-provider" style="width:100%;background:#16162a;border:1px solid #252540;border-radius:7px;padding:0.55rem;color:#e2e2f0;font-size:0.85rem;">
            <option value="groq">Groq</option>
            <option value="openrouter">OpenRouter</option>
            <option value="together">Together AI</option>
            <option value="huggingface">HuggingFace</option>
          </select>
        </div>
        <div class="form-group" style="margin:0;grid-column:span 2;">
          <label>API Key <span style="color:#555;font-weight:400">(stored in vault only)</span></label>
          <div style="display:flex;gap:0.5rem;">
            <input id="key-value" type="password" placeholder="Paste key here…" style="flex:1;" />
            <button class="btn btn-primary btn-sm" style="align-self:flex-end;white-space:nowrap;" onclick="window.__apd.saveKey()">🔒 Save</button>
          </div>
        </div>
      </div>
      <!-- Key presence indicator -->
      <div id="key-status-row" style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.6rem;">
        ${["groq","openrouter","together","huggingface"].map((id) => `
          <span id="key-badge-${id}" style="
            background:${keyStatus[id] ? "#14532d" : "#1a1a2e"};
            border:1px solid ${keyStatus[id] ? "#22c55e" : "#252540"};
            border-radius:5px;padding:0.15rem 0.5rem;font-size:0.72rem;
            color:${keyStatus[id] ? "#22c55e" : "#555"}">
            ${keyStatus[id] ? "✔" : "○"} ${esc(id)}
          </span>
        `).join("")}
      </div>
    </div>

    <!-- Live test output -->
    <div class="card" id="apd-test-output-card" style="margin-top:0.75rem;display:none;">
      <h3 style="margin-bottom:0.75rem;">🧪 Test Results</h3>
      <div id="apd-test-output"></div>
    </div>
  `;

  // Wire controller
  window.__apd = {
    testAll:         _testAll,
    testSingle:      _testSingle,
    setActive:       _setActive,
    toggle:          _toggle,
    saveKey:         _saveKey,
    saveOllamaConfig:_saveOllamaConfig,
    listOllamaModels:_listOllamaModels,
    moveFallback:    _moveFallback,
    refresh:         () => _render(container)
  };
}

// ─── Provider Card ────────────────────────────────────────────────────────────

function _renderProviderCard(p, hasKey) {
  const statusCfg = _statusConfig(p.status);
  const isLocal   = p.local || p.id === "ollama";
  const keyOk     = isLocal || hasKey;

  return `
    <div class="card" id="apd-card-${p.id}" style="
      margin-bottom:0.5rem;
      border:2px solid ${p.isActive ? "#a78bfa" : "var(--border)"};
      transition:border-color 0.15s;
    ">
      <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">

        <!-- Icon + name -->
        <div style="font-size:1.35rem;flex-shrink:0">${_providerIcon(p.id)}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:0.88rem;color:${p.isActive ? "#a78bfa" : "var(--text-muted)"}">
            ${esc(p.label || p.id)}
            ${p.isActive ? `<span style="font-size:0.65rem;background:#4c1d95;color:#a78bfa;padding:0.1rem 0.4rem;border-radius:4px;margin-left:0.35rem;font-weight:400">ACTIVE</span>` : ""}
          </div>
          <div style="font-size:0.72rem;color:#555;margin-top:0.1rem">
            ${esc(p.model || "")}
            ${!isLocal && !keyOk ? `<span style="color:#f59e0b;margin-left:0.4rem">⚠ No key</span>` : ""}
          </div>
        </div>

        <!-- Status badge -->
        <div id="apd-status-${p.id}" style="text-align:center;flex-shrink:0;">
          ${_statusBadge(p.status, p.latencyMs)}
        </div>

        <!-- Actions -->
        <div style="display:flex;gap:0.4rem;flex-shrink:0;flex-wrap:wrap;">
          ${!p.isActive ? `<button class="btn btn-secondary btn-sm" onclick="window.__apd.setActive('${p.id}')">Set Active</button>` : ""}
          <button class="btn btn-secondary btn-sm" onclick="window.__apd.toggle('${p.id}')" style="color:${p.enabled ? "var(--warn)" : "var(--ok)"}">
            ${p.enabled ? "Disable" : "Enable"}
          </button>
          <button class="btn btn-primary btn-sm" onclick="window.__apd.testSingle('${p.id}')" id="apd-test-btn-${p.id}">
            Test
          </button>
        </div>

      </div>
    </div>
  `;
}

// ─── Fallback Chain ───────────────────────────────────────────────────────────

function _renderFallbackChain(order) {
  return order.map((id, i) => `
    <div style="display:flex;align-items:center;gap:0.3rem;">
      ${i > 0 ? `<span style="color:#555;font-size:0.75rem">→</span>` : ""}
      <div style="
        background:#1e1b4b;border:1px solid #4c1d95;border-radius:7px;
        padding:0.3rem 0.6rem;font-size:0.78rem;color:#a78bfa;
        display:flex;align-items:center;gap:0.4rem;">
        ${_providerIcon(id)} ${esc(_providerLabel(id))}
        <span style="display:flex;flex-direction:column;gap:1px;margin-left:0.2rem;">
          ${i > 0               ? `<button onclick="window.__apd.moveFallback('${id}',-1)" style="background:none;border:none;color:#555;cursor:pointer;font-size:0.6rem;line-height:1;padding:0">▲</button>` : ""}
          ${i < order.length-1  ? `<button onclick="window.__apd.moveFallback('${id}',+1)" style="background:none;border:none;color:#555;cursor:pointer;font-size:0.6rem;line-height:1;padding:0">▼</button>` : ""}
        </span>
      </div>
    </div>
  `).join("");
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function _testSingle(id) {
  const btn = document.getElementById(`apd-test-btn-${id}`);
  const statusEl = document.getElementById(`apd-status-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  if (statusEl) statusEl.innerHTML = `<span style="color:#555;font-size:0.75rem">testing…</span>`;

  const cfg = getConfig();
  const result = await testProvider(id, cfg.providers[id] || {});

  if (statusEl) statusEl.innerHTML = _statusBadge(result.status, result.latencyMs);
  if (btn)      { btn.disabled = false; btn.textContent = "Test"; }

  _showTestOutput([result]);
  showToast(`${id}: ${result.status}${result.latencyMs ? ` (${result.latencyMs}ms)` : ""}`, result.status === "ok" ? "ok" : "err");
}

async function _testAll() {
  const btn = document.getElementById("apd-test-all-btn");
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner">⟳</span> Testing…`; }

  const providers = getOrderedProviders();
  showToast("Testing all enabled providers…", "info");

  const results = await testAllProviders(providers, (result) => {
    // Update each card's status badge as results arrive
    const statusEl = document.getElementById(`apd-status-${result.provider}`);
    if (statusEl) statusEl.innerHTML = _statusBadge(result.status, result.latencyMs);
  });

  if (btn) { btn.disabled = false; btn.innerHTML = "⚡ Test All"; }
  _showTestOutput(results);

  const ok = results.filter((r) => r.status === "ok").length;
  showToast(`${ok}/${results.length} providers online`, ok > 0 ? "ok" : "err");
}

function _setActive(id) {
  setActiveProvider(id);
  const label = document.getElementById("apd-active-label");
  if (label) label.innerHTML = `${_providerIcon(id)} ${esc(_providerLabel(id))}`;
  // Re-highlight cards
  document.querySelectorAll("[id^='apd-card-']").forEach((c) => {
    c.style.borderColor = c.id === `apd-card-${id}` ? "#a78bfa" : "var(--border)";
  });
  showToast(`Active provider: ${id}`, "ok");
}

function _toggle(id) {
  const cfg = getConfig();
  const current = cfg.providers[id]?.enabled ?? false;
  updateProvider(id, { enabled: !current });
  showToast(`${id} ${!current ? "enabled" : "disabled"}`, "ok");
  const container = document.getElementById("apd-body");
  if (container) _render(container);
}

async function _saveKey() {
  const provider = document.getElementById("key-provider")?.value;
  const key      = document.getElementById("key-value")?.value.trim();
  if (!provider) { showToast("Select a provider", "err"); return; }
  if (!key)      { showToast("Enter an API key", "err");  return; }
  if (!isUnlocked()) { showToast("Unlock the vault first", "err"); return; }

  try {
    await saveProviderKey(provider, key);
    document.getElementById("key-value").value = "";
    // Update badge
    const badge = document.getElementById(`key-badge-${provider}`);
    if (badge) {
      badge.style.background   = "#14532d";
      badge.style.borderColor  = "#22c55e";
      badge.style.color        = "#22c55e";
      badge.textContent        = `✔ ${provider}`;
    }
    // Auto-enable the provider
    updateProvider(provider, { enabled: true });
    showToast(`✔ ${provider} key saved to vault`, "ok");
  } catch (err) {
    showToast(`Failed: ${err.message}`, "err");
  }
}

function _saveOllamaConfig() {
  const baseUrl = document.getElementById("ollama-base-url")?.value.trim();
  const model   = document.getElementById("ollama-model-input")?.value.trim();
  if (!baseUrl || !model) { showToast("Base URL and model are required", "err"); return; }
  updateProvider("ollama", { baseUrl, model, enabled: true });
  showToast("Ollama config saved", "ok");
}

async function _listOllamaModels() {
  const el = document.getElementById("ollama-models-list");
  if (el) el.innerHTML = `<span style="color:#555;font-size:0.78rem">Fetching models…</span>`;

  const res = await sendToAgent("ollama-health", {});
  const models = res.ok ? (res.data?.models || []) : [];

  if (!el) return;
  if (models.length === 0) {
    el.innerHTML = `<span style="color:#555;font-size:0.78rem">${res.ok ? "No models pulled yet. Run: <code>ollama pull llama3</code>" : `Ollama offline: ${esc(res.error || "")}`}</span>`;
    return;
  }

  el.innerHTML = `
    <div style="font-size:0.72rem;color:#555;margin-bottom:0.35rem">Available models:</div>
    <div style="display:flex;flex-wrap:wrap;gap:0.3rem;">
      ${models.map((m) => `
        <button onclick="document.getElementById('ollama-model-input').value='${esc(m)}'"
          style="background:#1e1b4b;border:1px solid #4c1d95;border-radius:5px;padding:0.15rem 0.5rem;font-size:0.72rem;color:#a78bfa;cursor:pointer;">
          ${esc(m)}
        </button>
      `).join("")}
    </div>
  `;
}

function _moveFallback(id, delta) {
  const cfg   = getConfig();
  const order = [...cfg.fallbackOrder];
  const idx   = order.indexOf(id);
  if (idx === -1) return;
  const newIdx = Math.max(0, Math.min(order.length - 1, idx + delta));
  order.splice(idx, 1);
  order.splice(newIdx, 0, id);
  setFallbackOrder(order);
  const chainEl = document.getElementById("fallback-chain");
  if (chainEl) chainEl.innerHTML = _renderFallbackChain(order);
}

// ─── Test Output ──────────────────────────────────────────────────────────────

function _showTestOutput(results) {
  const card = document.getElementById("apd-test-output-card");
  const out  = document.getElementById("apd-test-output");
  if (!card || !out) return;

  card.style.display = "";
  out.innerHTML = results.map((r) => `
    <div style="
      display:flex;align-items:flex-start;gap:0.75rem;
      padding:0.5rem 0.65rem;
      background:var(--surface2);
      border:1px solid var(--border);
      border-radius:8px;
      margin-bottom:0.35rem;
    ">
      <span style="flex-shrink:0;font-size:1rem">${_providerIcon(r.provider)}</span>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <span style="font-weight:600;font-size:0.82rem;color:var(--text-muted)">${esc(_providerLabel(r.provider))}</span>
          ${_statusBadge(r.status, r.latencyMs)}
        </div>
        ${r.response ? `<div style="font-size:0.75rem;color:#555;margin-top:0.2rem;font-family:monospace">"${esc(r.response.slice(0,80))}"</div>` : ""}
        ${r.error    ? `<div style="font-size:0.75rem;color:var(--fail);margin-top:0.2rem">${esc(r.error)}</div>` : ""}
      </div>
    </div>
  `).join("");
}

// ─── Pure Helpers ─────────────────────────────────────────────────────────────

function _statusConfig(status) {
  return {
    ok:       { color: "var(--ok)",   icon: "●",  label: "Online"  },
    fail:     { color: "var(--fail)", icon: "●",  label: "Error"   },
    timeout:  { color: "var(--warn)", icon: "●",  label: "Timeout" },
    no_key:   { color: "#f59e0b",     icon: "⚠",  label: "No key"  },
    offline:  { color: "#555",        icon: "○",  label: "Offline" },
    unknown:  { color: "#555",        icon: "○",  label: "Unknown" }
  }[status] || { color: "#555", icon: "○", label: status || "Unknown" };
}

function _statusBadge(status, latencyMs) {
  const cfg = _statusConfig(status);
  return `
    <span style="display:inline-flex;align-items:center;gap:0.3rem;background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:0.15rem 0.45rem;font-size:0.72rem;">
      <span style="color:${cfg.color}">${cfg.icon}</span>
      <span style="color:${cfg.color}">${cfg.label}</span>
      ${latencyMs ? `<span style="color:#555">${latencyMs}ms</span>` : ""}
    </span>
  `;
}

function _providerIcon(id) {
  return { ollama: "🖥", groq: "⚡", openrouter: "🌐", together: "🤝", huggingface: "🤗" }[id] || "🧠";
}

function _providerLabel(id) {
  return { ollama: "Ollama (Local)", groq: "Groq", openrouter: "OpenRouter", together: "Together AI", huggingface: "HuggingFace" }[id] || id;
}
