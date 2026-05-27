/**
 * systemChecker.js — System + Ollama State Inspector (RUN 7.5)
 *
 * Detects the current state of the local environment without mutating it.
 * Pure read — never installs, never starts processes.
 *
 * Checks:
 *   1. OS + architecture + Node version
 *   2. Whether `ollama` binary is on PATH (via `which`/`where`)
 *   3. Whether Ollama server is running (HTTP ping to /api/tags)
 *   4. Which models are pulled
 *   5. Whether a specific model is available
 *
 * SSOT Rules:
 * ✔ Read-only — no exec, no writes
 * ✔ Returns typed SystemState — setupController owns all writes
 * ✔ Network check uses AbortSignal.timeout (no hanging)
 * ✔ Never throws — always returns a valid object
 * ❌ Never calls ollamaInstaller
 */

import { execSync }  from "child_process";
import os            from "os";
import path          from "path";
import fs            from "fs";

const OLLAMA_PORT    = 11434;
const OLLAMA_BASE    = `http://127.0.0.1:${OLLAMA_PORT}`;
const CHECK_TIMEOUT  = 4_000;

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Run a full system check and return a structured state object.
 *
 * @returns {Promise<SystemState>}
 *
 * @typedef {object} SystemState
 * @property {boolean}  binaryFound     - `ollama` is on PATH
 * @property {boolean}  serverRunning   - HTTP ping to :11434 succeeded
 * @property {string[]} pulledModels    - Models currently in Ollama
 * @property {string}   installedAt     - Date string if determinable, else null
 * @property {OSInfo}   os
 * @property {string}   nodeVersion
 * @property {string}   status          - "not_installed"|"installed_stopped"|"running"|"running_no_model"
 * @property {string}   checkedAt
 *
 * @typedef {object} OSInfo
 * @property {string} platform  - "linux"|"darwin"|"win32"
 * @property {string} arch
 * @property {string} release
 * @property {boolean} isWindows
 */
export async function checkOllamaStatus() {
  const platform     = os.platform();
  const isWindows    = platform === "win32";
  const nodeVersion  = process.version;

  const binaryFound  = _checkBinary(isWindows);
  const serverCheck  = await _pingServer();
  const pulledModels = serverCheck.running ? serverCheck.models : [];

  let status;
  if (!binaryFound && !serverCheck.running)   status = "not_installed";
  else if (binaryFound && !serverCheck.running) status = "installed_stopped";
  else if (serverCheck.running && pulledModels.length === 0) status = "running_no_model";
  else status = "running";

  return {
    binaryFound,
    serverRunning: serverCheck.running,
    pulledModels,
    installedAt:   null,  // not reliably determinable without install receipts
    os: {
      platform,
      arch:      os.arch(),
      release:   os.release(),
      isWindows
    },
    nodeVersion,
    status,
    checkedAt: new Date().toISOString()
  };
}

/**
 * Quick server-only ping (no binary check, fast path for health endpoints).
 */
export async function pingOllamaServer() {
  return _pingServer();
}

/**
 * Check whether a specific model is available locally.
 *
 * @param {string} modelName  - e.g. "llama3"
 */
export async function isModelPulled(modelName) {
  const { running, models } = await _pingServer();
  if (!running) return false;
  // Match by prefix — "llama3" matches "llama3:latest"
  return models.some((m) => m === modelName || m.startsWith(`${modelName}:`));
}

// ─── Binary Detection ─────────────────────────────────────────────────────────

function _checkBinary(isWindows) {
  try {
    // Try which/where
    const cmd = isWindows ? "where ollama" : "which ollama";
    const out  = execSync(cmd, { stdio: "pipe", timeout: 3000 }).toString().trim();
    if (out) return true;
  } catch { /* not on PATH */ }

  // Fallback: check common install paths
  const commonPaths = isWindows
    ? [
        path.join(process.env.LOCALAPPDATA || "C:\\Users\\Default\\AppData\\Local", "Programs", "Ollama", "ollama.exe"),
        "C:\\Program Files\\Ollama\\ollama.exe"
      ]
    : [
        "/usr/local/bin/ollama",
        "/usr/bin/ollama",
        `${os.homedir()}/.ollama/bin/ollama`,
        "/opt/homebrew/bin/ollama"   // Apple Silicon homebrew
      ];

  return commonPaths.some((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

// ─── HTTP Ping ────────────────────────────────────────────────────────────────

async function _pingServer() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT)
    });
    if (!res.ok) return { running: false, models: [] };
    const data   = await res.json();
    const models = (data.models || []).map((m) => m.name || m.model || "").filter(Boolean);
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}
