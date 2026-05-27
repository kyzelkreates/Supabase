/**
 * agentRoutes73.js — RUN 7.3 Agent Route Extensions
 *
 * Additional Express routes added in RUN 7.3.
 * Imported and mounted by agentRouter.js (RUN 7.2) — that file is NOT modified.
 *
 * New routes:
 *   POST /ingest            → multi-source ingestion (zip/github/firebase)
 *   POST /compile-schema    → schemaCompilerAI via aiProviderManager
 *   POST /ai-status         → aiProviderManager.checkAllProviders
 *   POST /set-ai-provider   → update aiProviderConfig.json activeProvider
 *   POST /set-ai-key        → set provider API key in process.env (session only)
 *   POST /ollama-health     → ollamaClient.checkOllamaHealth
 *
 * SSOT Rules:
 * ✔ All execution delegated to owning RUN 7.3 modules
 * ✔ Auth enforced via requireAuth (imported from agentRouter pattern)
 * ✔ agentRouter.js (RUN 7.2) is NOT modified — routes mounted via register()
 */

import fs   from "fs";
import path from "path";

import { ingestZipProject }                from "./zipIngestor.js";
import { fetchGitHubRepo }                 from "./githubFetcher.js";
import { parseFirebaseExport }             from "./firebaseParser.js";
import { normalizeProject }                from "./projectNormalizer.js";
import { compileSchema }                   from "./schemaCompilerAI.js";
import { runSupabaseAdapter }              from "./backendAdapters/supabaseAdapter.js";
import { runFirebaseAdapter }              from "./backendAdapters/firebaseAdapter.js";
import { checkAllProviders }               from "./aiProviderManager.js";
import { checkOllamaHealth }               from "./ollamaClient.js";
import { scanProject, summarizeProject }   from "./projectAnalyzer.js";

const CONFIG_PATH = path.resolve("./ssot/aiProviderConfig.json");

// ─── Route Registration ────────────────────────────────────────────────────────

export function register(app, requireAuth, wrap) {

  // ── POST /ingest ────────────────────────────────────────────────────────────
  app.post("/ingest", requireAuth, wrap(async (req, res) => {
    const { sourceType, projectName, projectPath, owner, repo, ref: ghRef, token, firebasePath } = req.body;
    if (!sourceType || !projectName) return res.status(400).json({ ok: false, error: "sourceType and projectName required" });

    let source;

    switch (sourceType) {
      case "zip":
      case "local": {
        if (!projectPath) return res.status(400).json({ ok: false, error: "projectPath required for zip/local source" });
        const ingestResult = ingestZipProject({ projectPath, projectName });
        if (!ingestResult.ok) return res.status(422).json({ ok: false, error: ingestResult.error });
        source = ingestResult.source;
        break;
      }
      case "github": {
        if (!owner || !repo) return res.status(400).json({ ok: false, error: "owner and repo required for GitHub source" });
        const ghResult = await fetchGitHubRepo({ owner, repo, ref: ghRef, token });
        if (!ghResult.ok) return res.status(422).json({ ok: false, error: ghResult.error });
        source = {
          sourceType:    "github",
          sourceUri:     `${owner}/${repo}@${ghResult.usedRef}`,
          projectId:     `${owner}_${repo}`.replace(/[^a-zA-Z0-9_]/g, "_"),
          projectName,
          projectType:   "unknown",
          detectedORM:   [],
          files:         (ghResult.files || []).map((f) => ({ file: f.path, content: f.content, category: "code", bytes: f.content.length, truncated: f.truncated })),
          totalFiles:    ghResult.files?.length || 0,
          includedFiles: ghResult.files?.length || 0,
          signalFiles:   [],
          schemaFiles:   ghResult.files?.filter((f) => f.path.endsWith(".prisma") || f.path.endsWith(".sql")).map((f) => f.path) || [],
          ingestedAt:    new Date().toISOString()
        };
        break;
      }
      case "firebase": {
        if (!firebasePath) return res.status(400).json({ ok: false, error: "firebasePath required" });
        const fbResult = parseFirebaseExport(firebasePath);
        if (!fbResult.ok) return res.status(422).json({ ok: false, error: fbResult.error });
        source = {
          sourceType:    "firebase",
          sourceUri:     firebasePath,
          projectId:     projectName.replace(/[^a-zA-Z0-9_]/g, "_"),
          projectName,
          projectType:   "firebase",
          detectedORM:   [],
          files:         [],
          collections:   fbResult.collections,
          rules:         fbResult.rules,
          indexes:       fbResult.indexes,
          ingestedAt:    new Date().toISOString()
        };
        break;
      }
      default:
        return res.status(400).json({ ok: false, error: `Unknown sourceType: ${sourceType}` });
    }

    // Normalize into UnifiedProjectModel
    const cfg          = _loadConfig();
    const targetBackends = req.body.targetBackends || ["supabase"];
    const unifiedModel  = normalizeProject({ sources: [source], projectName, targetBackends });

    res.json({ ok: true, projectName, sourceType, projectId: source.projectId, fileCount: source.totalFiles || 0, unifiedModel });
  }));

  // ── POST /compile-schema ────────────────────────────────────────────────────
  app.post("/compile-schema", requireAuth, wrap(async (req, res) => {
    const { projectId, projectName, target = "supabase", forceProvider } = req.body;
    if (!projectName) return res.status(400).json({ ok: false, error: "projectName required" });

    // Re-load the unified model if we have a stored projectPath
    // For now, compile from the body's model if provided, else error
    if (!req.body.unifiedModel) {
      return res.status(400).json({ ok: false, error: "unifiedModel required in request body" });
    }

    const model = { ...req.body.unifiedModel, targetBackends: target === "both" ? ["supabase","firebase"] : [target] };
    const result = await compileSchema(model, { forceProvider, supabaseOnly: target === "supabase", firebaseOnly: target === "firebase" });

    res.json({ ok: result.ok, ...result });
  }));

  // ── POST /ai-status ─────────────────────────────────────────────────────────
  app.post("/ai-status", requireAuth, wrap(async (req, res) => {
    const providers = await checkAllProviders();
    const cfg       = _loadConfig();
    res.json({ ok: true, activeProvider: cfg.activeProvider, providers, ollama: cfg.ollama });
  }));

  // ── POST /set-ai-provider ────────────────────────────────────────────────────
  app.post("/set-ai-provider", requireAuth, wrap(async (req, res) => {
    const { provider } = req.body;
    if (!provider) return res.status(400).json({ ok: false, error: "provider required" });
    try {
      const cfg = _loadConfig();
      cfg.activeProvider = provider;
      cfg.updatedAt = new Date().toISOString();
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
      res.json({ ok: true, activeProvider: provider });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }));

  // ── POST /set-ai-key ─────────────────────────────────────────────────────────
  // Stores key in process.env for this session (vault persistence is PWA-side)
  app.post("/set-ai-key", requireAuth, wrap(async (req, res) => {
    const { provider, apiKey } = req.body;
    if (!provider || !apiKey) return res.status(400).json({ ok: false, error: "provider and apiKey required" });
    const keyMap = { groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY", together: "TOGETHER_API_KEY", huggingface: "HUGGINGFACE_API_KEY" };
    const envKey = keyMap[provider];
    if (!envKey) return res.status(400).json({ ok: false, error: `Unknown provider: ${provider}` });
    process.env[envKey] = apiKey;
    console.log(`[agentRoutes73] ${envKey} set (session-only)`);
    res.json({ ok: true, provider, keySet: true });
  }));

  // ── POST /ollama-health ──────────────────────────────────────────────────────
  app.post("/ollama-health", requireAuth, wrap(async (req, res) => {
    const result = await checkOllamaHealth();
    res.json({ ok: true, ...result });
  }));

  console.log("[agentRoutes73] RUN 7.3 routes registered: /ingest /compile-schema /ai-status /set-ai-provider /set-ai-key /ollama-health");
}

function _loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); }
  catch { return { activeProvider: "ollama", fallbackOrder: ["ollama"] }; }
}
