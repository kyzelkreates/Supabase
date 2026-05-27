/**
 * agentRouter.js — Local Agent HTTP Server (RUN 7.2)
 *
 * Express server that runs locally (or on a private host).
 * This is the ONLY network surface the PWA talks to.
 * All heavy execution (ZIP extraction, AI calls, Supabase installs)
 * happens here — never in the browser.
 *
 * Port: 4000 (overridable via AGENT_PORT env var)
 * Auth: Bearer token checked on every request (from vault or .env)
 *
 * Route map:
 *   POST /upload-zip       → zipController.handleZipUpload
 *   POST /analyze          → zipController.handleAnalyze
 *   POST /generate-sql     → sqlGenerator.generateSQLFromProject
 *   POST /run-pipeline     → orchestrator.execute (RUN 7)
 *   GET  /status           → health + pipeline state
 *   GET  /wiring           → architectureGuard.checkWiring (RUN 7.1)
 *
 * SSOT Rules:
 * ✔ Single inbound network surface for the PWA
 * ✔ Auth middleware on all non-health routes
 * ✔ All execution delegated to owning RUN modules
 * ✔ CORS locked to allowed origins (configurable)
 * ✔ RUN 4.1 gate re-checked before pipeline routes
 * ❌ Never imports PWA modules
 * ❌ Never writes to SSOT files directly
 */

import express        from "express";
import multer         from "multer";
import cors           from "cors";
import path           from "path";
import { handleZipUpload, handleAnalyze } from "./zipController.js";
import { generateSQLFromProject }          from "./sqlGenerator.js";

// Lazy imports for heavy RUN 7 modules (keeps startup fast)
let _orchestrator = null;
let _archGuard    = null;

async function getOrchestrator() {
  if (!_orchestrator) _orchestrator = await import("../server/orchestrator.js");
  return _orchestrator;
}
async function getArchGuard() {
  if (!_archGuard) _archGuard = await import("../server/architectureGuard.js");
  return _archGuard;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT           = parseInt(process.env.AGENT_PORT || "4000", 10);
const AGENT_TOKEN    = process.env.AGENT_TOKEN || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173,https://localhost").split(",");

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin requests (curl, Postman) in dev; restrict in production
    if (!origin || ALLOWED_ORIGINS.includes(origin) || process.env.NODE_ENV !== "production") {
      cb(null, true);
    } else {
      cb(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  methods:          ["GET", "POST"],
  allowedHeaders:   ["Content-Type", "Authorization"],
  exposedHeaders:   ["X-Pipeline-Id"],
  credentials:      false
}));

app.use(express.json({ limit: "10mb" }));

// ── File upload (multipart) ───────────────────────────────────────────────────
const upload = multer({
  dest:   path.resolve("./agent/uploads/"),
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  // Skip auth if no token configured (dev mode)
  if (!AGENT_TOKEN) return next();

  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (token !== AGENT_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized — invalid or missing Bearer token" });
  }
  next();
}

// ─── Request Logger ───────────────────────────────────────────────────────────

app.use((req, _res, next) => {
  console.log(`[agentRouter] ${req.method} ${req.path} — ${new Date().toISOString()}`);
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health (no auth required — safe to expose)
app.get("/status", async (req, res) => {
  let pipelineStatus = null;
  let wiringStatus   = null;

  try {
    const orch = await getOrchestrator();
    pipelineStatus = orch.getStatus();
  } catch { pipelineStatus = { status: "unavailable" }; }

  try {
    const { getLastWiringState } = await getArchGuard();
    wiringStatus = getLastWiringState();
  } catch { wiringStatus = { status: "unknown" }; }

  res.json({
    ok:        true,
    agent:     "AI Vault OS — Local Agent",
    version:   "7.2",
    port:      PORT,
    authMode:  AGENT_TOKEN ? "token" : "open (dev)",
    pipeline:  pipelineStatus,
    wiring:    { status: wiringStatus?.status, systemReady: wiringStatus?.systemReady },
    timestamp: new Date().toISOString()
  });
});

// ZIP upload
app.post("/upload-zip", requireAuth, upload.single("zip"), _wrap(handleZipUpload));

// Analyze an already-extracted project directory
app.post("/analyze", requireAuth, _wrap(handleAnalyze));

// Generate SQL from a project directory
app.post("/generate-sql", requireAuth, _wrap(async (req, res) => {
  const { projectPath, projectName, useAI = true } = req.body;
  if (!projectPath) return res.status(400).json({ ok: false, error: "projectPath required" });

  const result = await generateSQLFromProject({ projectPath, projectName, useAI });
  res.json({ ok: true, ...result });
}));

// Full RUN 7 pipeline trigger
app.post("/run-pipeline", requireAuth, _wrap(async (req, res) => {
  const { projectName, ref, password, prompt, dryRun, skipValidation } = req.body;
  if (!projectName || !prompt) {
    return res.status(400).json({ ok: false, error: "projectName and prompt are required" });
  }

  const orch   = await getOrchestrator();
  const result = await orch.execute({ projectName, ref, password, prompt, dryRun, skipValidation });

  // Surface pipeline ID in response header for the PWA to track
  res.setHeader("X-Pipeline-Id", result.pipelineId || "");
  res.json({ ok: result.success, ...result });
}));

// Wiring check (RUN 7.1)
app.get("/wiring", requireAuth, _wrap(async (req, res) => {
  const mode  = req.query.mode || "check";
  const guard = await getArchGuard();
  const result = mode === "repair" ? guard.repairWiring() : guard.checkWiring();
  res.json({ ok: result.systemReady, ...result });
}));

// ─── 404 + Error handlers ─────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route not found: ${req.method} ${req.path}` });
});

app.use((err, req, res, _next) => {
  console.error(`[agentRouter] Unhandled error on ${req.path}:`, err);
  res.status(500).json({ ok: false, error: err.message || "Internal agent error" });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n[agentRouter] ════════════════════════════════`);
  console.log(`[agentRouter]  AI VAULT OS — Local Agent v7.2`);
  console.log(`[agentRouter]  Listening on http://127.0.0.1:${PORT}`);
  console.log(`[agentRouter]  Auth: ${AGENT_TOKEN ? "Token required" : "Open (set AGENT_TOKEN to enable)"}`);
  console.log(`[agentRouter] ════════════════════════════════\n`);
});

export default app;

// ─── Async Route Wrapper ──────────────────────────────────────────────────────

function _wrap(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
