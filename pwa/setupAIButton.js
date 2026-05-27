/**
 * setupAIButton.js — One-Click AI Environment Setup Trigger (RUN 7.5)
 *
 * Provides the "🚀 Setup AI Environment" button logic.
 * Streams live install logs from the agent to the UI via SSE.
 * Persists final result to providerStore (marks Ollama as enabled/ready).
 *
 * SSOT Rules:
 * ✔ All agent communication via setupBridge.js only
 * ✔ State written via providerStore.updateProvider (not localStorage directly)
 * ✔ Never calls shell commands — delegates entirely to agent
 * ✔ Idempotent — re-running is safe and clearly communicated to the user
 */

import { checkSetupStatus, triggerSetupStream } from "./api/setupBridge.js";
import { updateProvider, setActiveProvider }    from "./providerStore.js";
import { showToast }                            from "./dashboard.js";

let _activeStream = null;   // Track SSE stream for cancel

// ─── Main Action ──────────────────────────────────────────────────────────────

/**
 * Called by the "🚀 Setup AI Environment" button.
 * Runs a quick check first, then streams full setup if needed.
 *
 * @param {object} [opts]
 * @param {string} [opts.model="llama3"]
 * @param {string} [opts.outputElementId="setupOutput"]  - Pre element for logs
 * @param {string} [opts.buttonElementId="setupBtn"]
 */
export async function setupAIEnvironment(opts = {}) {
  const { model = "llama3", outputElementId = "setupOutput", buttonElementId = "setupBtn" } = opts;

  const btn    = document.getElementById(buttonElementId);
  const output = document.getElementById(outputElementId);

  if (btn)    { btn.disabled = true; btn.innerHTML = `<span class="spinner">⟳</span> Checking…`; }
  if (output) { output.textContent = ""; }

  const _log = (msg) => {
    if (output) output.textContent += msg + "\n";
    console.log("[setupAIButton]", msg);
  };

  try {
    // Quick preflight — check if already ready
    _log("Checking current Ollama state…");
    const check = await checkSetupStatus();

    if (!check.ok) {
      _log(`⚠ Could not reach agent: ${check.error}`);
      _log("Is the local agent running? Start with: node agent/agentRouter.js");
      showToast("Agent offline — start it first", "err");
      return;
    }

    _log(`Binary found:   ${check.binaryFound}`);
    _log(`Server running: ${check.serverRunning}`);
    _log(`Models pulled:  ${(check.pulledModels || []).join(", ") || "none"}`);
    _log(`Status:         ${check.status}`);

    if (check.serverRunning && (check.pulledModels || []).some((m) => m.startsWith(model))) {
      _log(`\n✅ Ollama is already running with "${model}" — nothing to do!`);
      _onSetupComplete({ success: true, serverRunning: true, modelReady: true }, model, btn);
      showToast("Ollama is already ready!", "ok");
      return;
    }

    // Start streaming setup
    if (btn) btn.innerHTML = `<span class="spinner">⟳</span> Setting up… <button onclick="window.__setupBtn.cancel()" style="margin-left:0.5rem;background:none;border:1px solid #ef4444;color:#ef4444;border-radius:4px;padding:0.1rem 0.4rem;font-size:0.72rem;cursor:pointer;">Cancel</button>`;

    _log("\n── Starting Ollama setup ──────────────────────");

    // Cancel any previous stream
    if (_activeStream) _activeStream.cancel();

    _activeStream = triggerSetupStream({
      model,
      onLog: (msg) => _log(msg),
      onComplete: (result) => {
        _activeStream = null;
        _log(`\n── Setup ${result.ok ? "complete ✅" : "failed ❌"} ──`);
        if (result.duration) _log(`Duration: ${result.duration}`);
        if (result.error)    _log(`Error: ${result.error}`);
        _onSetupComplete(result, model, btn);
        showToast(
          result.ok ? `✅ Ollama ready — ${model} is live!` : `Setup failed: ${result.error}`,
          result.ok ? "ok" : "err"
        );
      },
      onError: (msg) => {
        _activeStream = null;
        _log(`\nFATAL: ${msg}`);
        if (btn) { btn.disabled = false; btn.innerHTML = "🚀 Setup AI Environment"; }
        showToast(`Setup error: ${msg}`, "err");
      }
    });

    window.__setupBtn = { cancel: () => { if (_activeStream) { _activeStream.cancel(); _activeStream = null; } if (btn) { btn.disabled = false; btn.innerHTML = "🚀 Setup AI Environment"; } } };

  } catch (err) {
    _log(`Error: ${err.message}`);
    if (btn) { btn.disabled = false; btn.innerHTML = "🚀 Setup AI Environment"; }
    showToast(err.message, "err");
  }
}

// ─── Post-Setup State Update ──────────────────────────────────────────────────

function _onSetupComplete(result, model, btn) {
  // Update providerStore so the rest of the PWA knows Ollama is ready
  updateProvider("ollama", {
    enabled:  result.serverRunning || false,
    status:   result.serverRunning ? "ok" : "fail",
    model
  });
  if (result.serverRunning) setActiveProvider("ollama");

  if (btn) {
    btn.disabled = false;
    btn.innerHTML = result.ok
      ? `✅ AI Environment Ready`
      : `⚠ Setup Incomplete — Try Again`;
  }
}

// ─── Global Convenience (for inline onclick usage) ────────────────────────────

window.setupAIEnvironment = setupAIEnvironment;
