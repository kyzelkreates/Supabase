/**
 * setupController.js — Ollama Setup Route Controller (RUN 7.5)
 *
 * Adds setup routes to the existing agentRouter (RUN 7.2) via register().
 * Exposes:
 *   POST /setup-ai        → full install pipeline with SSE log streaming
 *   GET  /setup-status    → current state from ssot/systemSetupState.json
 *   POST /setup-check     → quick check (no install, returns SystemState)
 *   GET  /setup-log       → last setup log from state history
 *
 * SSE streaming: POST /setup-ai?stream=1 sends newline-delimited events
 * so the PWA can show live log lines without polling.
 *
 * SSOT Rules:
 * ✔ Delegates all installation to ollamaInstaller.runOllamaSetup()
 * ✔ Delegates all checking to systemChecker.checkOllamaStatus()
 * ✔ agentRouter.js (RUN 7.2) is NOT modified — routes added via register()
 * ✔ Auth enforced on mutating routes (/setup-ai)
 * ✔ /setup-status and /setup-check are read-only (no auth required in dev)
 * ❌ Never runs shell commands directly
 */

import fs   from "fs";
import path from "path";
import { runOllamaSetup }    from "./ollamaInstaller.js";
import { checkOllamaStatus } from "./systemChecker.js";

const STATE_PATH = path.resolve("./ssot/systemSetupState.json");

// ─── Route Registration ───────────────────────────────────────────────────────

export function register(app, requireAuth, wrap) {

  // ── POST /setup-ai ──────────────────────────────────────────────────────────
  // Full setup pipeline. Supports SSE streaming (?stream=1).
  app.post("/setup-ai", requireAuth, (req, res) => {
    const useSSE   = req.query.stream === "1" || req.body?.stream === true;
    const model    = req.body?.model    || "llama3";
    const skipPull = req.body?.skipPull || false;

    if (useSSE) {
      return _setupSSE(req, res, { model, skipPull });
    }
    return _setupJSON(req, res, { model, skipPull });
  });

  // ── GET /setup-status ───────────────────────────────────────────────────────
  // Returns persisted state — no live checks, instant response.
  app.get("/setup-status", wrap(async (req, res) => {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
      res.json({ ok: true, state });
    } catch {
      res.json({ ok: true, state: _defaultState() });
    }
  }));

  // ── POST /setup-check ───────────────────────────────────────────────────────
  // Live check (no install). Returns SystemState from systemChecker.
  app.post("/setup-check", wrap(async (req, res) => {
    const state = await checkOllamaStatus();
    res.json({ ok: true, ...state });
  }));

  // ── GET /setup-log ──────────────────────────────────────────────────────────
  app.get("/setup-log", wrap(async (req, res) => {
    try {
      const state   = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
      res.json({ ok: true, history: state.setupHistory || [] });
    } catch {
      res.json({ ok: true, history: [] });
    }
  }));

  console.log("[setupController] RUN 7.5 routes registered: /setup-ai /setup-status /setup-check /setup-log");
}

// ─── JSON Mode ────────────────────────────────────────────────────────────────

async function _setupJSON(req, res, opts) {
  try {
    const result = await runOllamaSetup({ ...opts, onLog: null });
    res.json({
      ok:            result.success,
      status:        result.success ? "complete" : "failed",
      serverRunning: result.serverRunning,
      modelReady:    result.modelReady,
      finalStatus:   result.finalStatus,
      duration:      result.duration,
      log:           result.log,
      error:         result.error || null
    });
  } catch (err) {
    res.status(500).json({ ok: false, status: "error", error: err.message });
  }
}

// ─── SSE Streaming Mode ───────────────────────────────────────────────────────

function _setupSSE(req, res, opts) {
  // Set SSE headers
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");  // Nginx / Vercel proxy unbuffering
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();  // compression middleware support
  };

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);

  runOllamaSetup({
    ...opts,
    onLog: (msg) => send("log", { message: msg, timestamp: new Date().toISOString() })
  })
    .then((result) => {
      send("complete", {
        ok:            result.success,
        status:        result.success ? "complete" : "failed",
        serverRunning: result.serverRunning,
        modelReady:    result.modelReady,
        finalStatus:   result.finalStatus,
        duration:      result.duration,
        error:         result.error || null
      });
      clearInterval(keepAlive);
      res.end();
    })
    .catch((err) => {
      send("error", { message: err.message });
      clearInterval(keepAlive);
      res.end();
    });

  req.on("close", () => clearInterval(keepAlive));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _defaultState() {
  return {
    ollama:      { installed: false, running: false, model: "llama3", port: 11434, status: "not_initialized" },
    systemReady: false
  };
}
