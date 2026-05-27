/**
 * ollamaInstaller.js — Ollama Install + Boot Engine (RUN 7.5)
 *
 * Performs real OS-level Ollama setup entirely within the local agent.
 * The PWA never touches this module — setupController.js is the sole caller.
 *
 * Steps (each guarded — skipped if already done):
 *   1. Install Ollama binary (OS-appropriate)
 *   2. Start the Ollama server (non-blocking background process)
 *   3. Wait for server to become reachable (with retries)
 *   4. Pull the requested model
 *
 * Platform support:
 *   Linux  — official install script (curl | sh)
 *   macOS  — official install script (curl | sh) or brew
 *   Windows — winget or direct .exe download + run
 *
 * SSOT Rules:
 * ✔ ALL shell execution lives here — no other module spawns processes
 * ✔ Idempotent — safe to re-run at any step
 * ✔ Each step emits to a shared log array (setupController reads it)
 * ✔ Never called from PWA or server/ modules
 * ✔ Writes final state to ssot/systemSetupState.json
 * ❌ Never exposes stdout/stderr raw to the network
 */

import { exec, spawn }   from "child_process";
import { promisify }     from "util";
import os                from "os";
import fs                from "fs";
import path              from "path";
import { checkOllamaStatus, pingOllamaServer, isModelPulled } from "./systemChecker.js";

const execAsync      = promisify(exec);
const STATE_PATH     = path.resolve("./ssot/systemSetupState.json");
const SERVER_TIMEOUT = 60_000;   // 60s to wait for server to come up
const SERVER_POLL_MS = 2_000;    // Poll interval
const MODEL_TIMEOUT  = 600_000;  // 10 min — large models take time

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Run the full Ollama setup pipeline.
 * Each step is logged and state is persisted after each phase.
 *
 * @param {SetupOptions} options
 * @returns {Promise<SetupResult>}
 *
 * @typedef {object} SetupOptions
 * @property {string}   [model="llama3"]
 * @property {function} [onLog]  - (message: string) => void — live log callback
 * @property {boolean}  [skipInstall]  - Skip binary install (assume already installed)
 * @property {boolean}  [skipPull]     - Skip model pull
 *
 * @typedef {object} SetupResult
 * @property {boolean}  success
 * @property {string[]} log
 * @property {string}   finalStatus   - from systemChecker.checkOllamaStatus
 * @property {boolean}  serverRunning
 * @property {boolean}  modelReady
 * @property {string}   [error]
 */
export async function runOllamaSetup(options = {}) {
  const { model = "llama3", onLog, skipInstall = false, skipPull = false } = options;
  const log    = [];
  const emit   = (msg) => { log.push(msg); if (onLog) onLog(msg); console.log(`[ollamaInstaller] ${msg}`); };
  const startMs = Date.now();

  try {
    emit("── Ollama Setup Engine ──────────────────────");
    emit(`Target model: ${model}`);
    emit(`Platform: ${os.platform()} / ${os.arch()}`);

    // Step 0: Current state
    emit("Step 0: Checking current state…");
    const initialState = await checkOllamaStatus();
    emit(`  Binary found:   ${initialState.binaryFound}`);
    emit(`  Server running: ${initialState.serverRunning}`);
    emit(`  Models pulled:  ${initialState.pulledModels.join(", ") || "none"}`);
    _persistState({ step: "checking", log });

    // Step 1: Install binary (if needed)
    if (!initialState.binaryFound && !skipInstall) {
      emit("Step 1: Installing Ollama binary…");
      const installResult = await _installBinary(emit);
      if (!installResult.ok) {
        _persistState({ step: "failed", error: installResult.error, log });
        return { success: false, log, finalStatus: "not_installed", serverRunning: false, modelReady: false, error: installResult.error };
      }
      emit(`  ✔ Install complete (${((Date.now() - startMs) / 1000).toFixed(1)}s)`);
    } else if (initialState.binaryFound) {
      emit("Step 1: Binary already installed — skipping.");
    } else {
      emit("Step 1: Skipped (skipInstall=true).");
    }

    // Step 2: Start server (if not running)
    if (!initialState.serverRunning) {
      emit("Step 2: Starting Ollama server…");
      const startResult = await _startServer(emit);
      if (!startResult.ok) {
        _persistState({ step: "failed", error: startResult.error, log });
        return { success: false, log, finalStatus: "installed_stopped", serverRunning: false, modelReady: false, error: startResult.error };
      }
      emit(`  ✔ Server reachable on port 11434 (${((Date.now() - startMs) / 1000).toFixed(1)}s)`);
    } else {
      emit("Step 2: Server already running — skipping.");
    }

    // Step 3: Pull model (if not already pulled)
    const modelAlready = await isModelPulled(model);
    if (!modelAlready && !skipPull) {
      emit(`Step 3: Pulling model "${model}" (this may take several minutes)…`);
      const pullResult = await _pullModel(model, emit);
      if (!pullResult.ok) {
        _persistState({ step: "failed", error: pullResult.error, log });
        return { success: false, log, finalStatus: "running_no_model", serverRunning: true, modelReady: false, error: pullResult.error };
      }
      emit(`  ✔ Model "${model}" ready (${((Date.now() - startMs) / 1000).toFixed(1)}s)`);
    } else if (modelAlready) {
      emit(`Step 3: Model "${model}" already pulled — skipping.`);
    } else {
      emit("Step 3: Skipped (skipPull=true).");
    }

    // Step 4: Final verification
    emit("Step 4: Final verification…");
    const finalState = await checkOllamaStatus();
    const modelReady = await isModelPulled(model);
    emit(`  Server running: ${finalState.serverRunning}`);
    emit(`  Model ready:    ${modelReady}`);
    emit(`  All models:     ${finalState.pulledModels.join(", ") || "none"}`);
    emit(`── Setup complete in ${((Date.now() - startMs) / 1000).toFixed(1)}s ──`);

    _persistState({
      step:          "complete",
      serverRunning: finalState.serverRunning,
      modelReady,
      models:        finalState.pulledModels,
      log,
      completedAt:   new Date().toISOString()
    });

    return {
      success:       finalState.serverRunning && modelReady,
      log,
      finalStatus:   finalState.status,
      serverRunning: finalState.serverRunning,
      modelReady,
      duration:      `${((Date.now() - startMs) / 1000).toFixed(1)}s`
    };

  } catch (err) {
    emit(`FATAL: ${err.message}`);
    _persistState({ step: "failed", error: err.message, log });
    return { success: false, log, finalStatus: "error", serverRunning: false, modelReady: false, error: err.message };
  }
}

// ─── Step 1: Install ──────────────────────────────────────────────────────────

async function _installBinary(emit) {
  const platform = os.platform();
  emit(`  Platform detected: ${platform}`);

  try {
    if (platform === "linux" || platform === "darwin") {
      emit("  Running official install script (curl | sh)…");
      emit("  This requires sudo — if it fails, install manually: https://ollama.com/download");
      // Official one-liner: https://ollama.com/install.sh
      await _exec("curl -fsSL https://ollama.com/install.sh | sh", { timeout: 120_000 }, emit);

    } else if (platform === "win32") {
      // Try winget first (available on Windows 10 1709+)
      emit("  Attempting winget install…");
      try {
        await _exec("winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements", { timeout: 180_000 }, emit);
      } catch {
        emit("  winget failed — attempting direct download…");
        // PowerShell download fallback
        const dlCmd = [
          `powershell -NoProfile -Command`,
          `"$url='https://ollama.com/download/OllamaSetup.exe';`,
          `$out='$env:TEMP\\OllamaSetup.exe';`,
          `Invoke-WebRequest -Uri $url -OutFile $out;`,
          `Start-Process $out -ArgumentList '/S' -Wait"`
        ].join(" ");
        await _exec(dlCmd, { timeout: 300_000 }, emit);
      }

    } else {
      return { ok: false, error: `Unsupported platform: ${platform}. Install Ollama manually: https://ollama.com/download` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Binary install failed: ${err.message}. Install manually: https://ollama.com/download` };
  }
}

// ─── Step 2: Start Server ─────────────────────────────────────────────────────

async function _startServer(emit) {
  const platform  = os.platform();
  const isWindows = platform === "win32";

  try {
    emit("  Spawning: ollama serve");

    if (isWindows) {
      // On Windows, spawn without shell and detach
      spawn("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
    } else {
      // Unix: spawn in background
      spawn("ollama", ["serve"], {
        detached: true,
        stdio:    "ignore",
        env:      { ...process.env }
      }).unref();
    }

    // Wait for server to become reachable
    emit(`  Waiting up to ${SERVER_TIMEOUT / 1000}s for server on port 11434…`);
    const reached = await _waitForServer(SERVER_TIMEOUT, SERVER_POLL_MS, emit);

    if (!reached) {
      return { ok: false, error: `Server did not respond on port 11434 within ${SERVER_TIMEOUT / 1000}s` };
    }
    return { ok: true };

  } catch (err) {
    return { ok: false, error: `Failed to start ollama serve: ${err.message}` };
  }
}

async function _waitForServer(timeoutMs, pollMs, emit) {
  const deadline = Date.now() + timeoutMs;
  let attempts   = 0;
  while (Date.now() < deadline) {
    const { running } = await pingOllamaServer();
    if (running) return true;
    attempts++;
    if (attempts % 5 === 0) emit(`  Still waiting… (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)`);
    await _sleep(pollMs);
  }
  return false;
}

// ─── Step 3: Pull Model ───────────────────────────────────────────────────────

async function _pullModel(model, emit) {
  emit(`  Running: ollama pull ${model}`);
  try {
    // Pull can take minutes — stream stdout lines to emit
    await _execStreaming(`ollama pull ${model}`, MODEL_TIMEOUT, emit);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Model pull failed: ${err.message}` };
  }
}

// ─── Exec Helpers ─────────────────────────────────────────────────────────────

async function _exec(cmd, opts = {}, emit) {
  const { stdout, stderr } = await execAsync(cmd, {
    shell:   true,
    timeout: opts.timeout || 60_000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (stdout?.trim()) emit(`  stdout: ${stdout.trim().slice(0, 300)}`);
  if (stderr?.trim()) emit(`  stderr: ${stderr.trim().slice(0, 200)}`);
  return { stdout, stderr };
}

function _execStreaming(cmd, timeout, emit) {
  return new Promise((resolve, reject) => {
    const child  = exec(cmd, { shell: true, timeout });
    const timer  = setTimeout(() => { child.kill(); reject(new Error(`Command timed out after ${timeout / 1000}s`)); }, timeout);

    child.stdout?.on("data", (d) => {
      const line = d.toString().trim();
      if (line) emit(`  → ${line.slice(0, 200)}`);
    });
    child.stderr?.on("data", (d) => {
      const line = d.toString().trim();
      if (line && !line.startsWith("pulling manifest")) emit(`  ↳ ${line.slice(0, 200)}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) resolve();
      else reject(new Error(`Command exited with code ${code}`));
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

// ─── State Persistence ────────────────────────────────────────────────────────

function _persistState(updates) {
  try {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")); } catch {}

    state.ollama = {
      ...(state.ollama || {}),
      installed:   updates.serverRunning ?? state.ollama?.installed ?? false,
      running:     updates.serverRunning ?? state.ollama?.running   ?? false,
      model:       "llama3",
      port:        11434,
      status:      updates.step || state.ollama?.status || "unknown",
      models:      updates.models || state.ollama?.models || [],
      lastChecked: new Date().toISOString()
    };
    state.systemReady  = updates.serverRunning && updates.modelReady ? true : false;
    state.lastSetupAt  = new Date().toISOString();

    // Keep last 10 log entries in history
    if (!state.setupHistory) state.setupHistory = [];
    state.setupHistory.unshift({
      step:        updates.step,
      timestamp:   new Date().toISOString(),
      error:       updates.error || null,
      logLines:    (updates.log || []).length
    });
    state.setupHistory = state.setupHistory.slice(0, 10);

    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.warn("[ollamaInstaller] Could not persist state:", err.message);
  }
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
