/**
 * settings.js (RUN 1 upgrade)
 * Handles key vault UI, provider status grid, and health checks.
 * Imports from ai-vault.js and provider-test.js — never touches keys directly.
 */

import { saveAIKeys, getAIKeys, getKeyedProviders } from "./ai-vault.js";
import { testProvider, testAllProviders, getProviderRegistry } from "./provider-test.js";
import { getRecord } from "./db.js";

const PROVIDER_NAMES = ["groq", "openrouter", "deepseek", "together", "huggingface", "ollama"];

// ─── Boot ────────────────────────────────────────────────────────────────────

async function load() {
  await loadKeys();
  await renderProviderGrid();
  await loadRunState();
}

// ─── Key Loading ─────────────────────────────────────────────────────────────

async function loadKeys() {
  const keys = await getAIKeys();
  const fieldMap = {
    groq: "key-groq",
    openrouter: "key-openrouter",
    deepseek: "key-deepseek",
    together: "key-together",
    huggingface: "key-huggingface"
  };
  for (const [provider, fieldId] of Object.entries(fieldMap)) {
    const el = document.getElementById(fieldId);
    if (el && keys[provider]) el.value = keys[provider];
  }
}

// ─── Save Keys ───────────────────────────────────────────────────────────────

window.saveKeys = async function () {
  const btn = document.getElementById("save-btn");
  btn.textContent = "Saving…";
  btn.disabled = true;

  const keys = {
    groq: document.getElementById("key-groq").value.trim(),
    openrouter: document.getElementById("key-openrouter").value.trim(),
    deepseek: document.getElementById("key-deepseek").value.trim(),
    together: document.getElementById("key-together").value.trim(),
    huggingface: document.getElementById("key-huggingface").value.trim()
  };

  await saveAIKeys(keys);
  showToast("✅ Keys saved securely in vault");
  await renderProviderGrid();

  btn.textContent = "💾 Save to Vault";
  btn.disabled = false;
};

// ─── Provider Grid ────────────────────────────────────────────────────────────

async function renderProviderGrid(healthMap = {}) {
  const registry = getProviderRegistry();
  const keyedProviders = await getKeyedProviders();
  const grid = document.getElementById("provider-grid");

  // Clear existing rows (keep header row = first 4 children)
  while (grid.children.length > 4) grid.removeChild(grid.lastChild);

  for (const name of PROVIDER_NAMES) {
    const p = registry[name];
    const hasKey = keyedProviders.includes(name) || p.authType === "none";
    const health = healthMap[name];

    // Provider name
    const nameEl = document.createElement("div");
    nameEl.className = "provider-name";
    nameEl.textContent = name;

    // Enabled/disabled badge
    const enabledEl = document.createElement("div");
    enabledEl.innerHTML = p.enabled
      ? `<span class="badge enabled">enabled</span>`
      : `<span class="badge disabled">disabled</span>`;

    // Health badge
    const healthEl = document.createElement("div");
    let healthClass = "pending";
    let healthText = hasKey ? "—" : "no key";
    if (!hasKey && p.authType === "apiKey") {
      healthClass = "no_key";
      healthText = "no key";
    }
    if (health) {
      healthClass = health.toLowerCase();
      healthText = health;
    }
    healthEl.innerHTML = `<span class="badge ${healthClass}">${healthText}</span>`;

    // Test button
    const testEl = document.createElement("div");
    const testBtn = document.createElement("button");
    testBtn.className = "test-btn";
    testBtn.textContent = "Test";
    testBtn.onclick = async () => {
      testBtn.textContent = "…";
      testBtn.disabled = true;
      const result = await testProvider(name);
      healthEl.innerHTML = `<span class="badge ${result.toLowerCase()}">${result}</span>`;
      testBtn.textContent = "Test";
      testBtn.disabled = false;
    };
    testEl.appendChild(testBtn);

    grid.appendChild(nameEl);
    grid.appendChild(enabledEl);
    grid.appendChild(healthEl);
    grid.appendChild(testEl);
  }
}

// ─── Test All ─────────────────────────────────────────────────────────────────

window.testAll = async function () {
  const results = await testAllProviders();
  await renderProviderGrid(results);
  showToast("🧪 Health check complete");
};

// ─── Run State ────────────────────────────────────────────────────────────────

async function loadRunState() {
  const el = document.getElementById("run-status-text");
  try {
    const settings = await getRecord("settings", "system");
    el.textContent = settings
      ? `Active Run: ${settings.activeRun} | Theme: ${settings.theme} | AI Enabled: ${settings.aiEnabled}`
      : "Settings not found in vault.";
  } catch (err) {
    el.textContent = "Error loading run state: " + err.message;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

window.toggleVisibility = function (inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === "password") {
    input.type = "text";
    btn.textContent = "🙈";
  } else {
    input.type = "password";
    btn.textContent = "👁";
  }
};

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2800);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

load();
