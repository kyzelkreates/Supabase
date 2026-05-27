/**
 * sqlGenerator.js — AI-Powered SQL Generation Engine (RUN 7.2)
 *
 * Reads a project directory, builds a structured AI prompt from its
 * files and detected schema signals, and routes to the RUN 2 AI system.
 *
 * In RUN 7.2 the AI call is a stubbed hook — it returns a structured
 * placeholder with the full prompt and context so RUN 7.3 can drop in
 * real provider calls without changing this module's interface.
 *
 * SSOT Rules:
 * ✔ File reading delegated to projectAnalyzer.js
 * ✔ AI routing reserved for RUN 7.3 (hook pattern, not a real call yet)
 * ✔ Returns SQLGenerationResult — never throws to caller
 * ✔ Prompt engineering lives here — not in projectAnalyzer or aiRouter
 * ❌ Never calls Supabase CLI directly
 * ❌ Never writes SQL files (migrationEngine.js owns that in RUN 3)
 */

import path from "path";
import { scanProject, summarizeProject, readProjectContext } from "./projectAnalyzer.js";

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Generate Supabase-ready SQL from a project directory.
 *
 * @param {SQLGenRequest} request
 * @returns {Promise<SQLGenerationResult>}
 *
 * @typedef {object} SQLGenRequest
 * @property {string}  projectPath
 * @property {string}  [projectName]
 * @property {boolean} [useAI=true]      - false = return analysis only, no SQL
 * @property {object}  [aiOverride]      - { provider, apiKey } — for RUN 7.3 injection
 *
 * @typedef {object} SQLGenerationResult
 * @property {boolean}  ok
 * @property {string}   sql             - Generated SQL (or placeholder)
 * @property {string}   prompt          - Full prompt sent to AI (for debugging)
 * @property {object}   analysis        - Project summary from projectAnalyzer
 * @property {number}   contextFiles    - Number of files included in context
 * @property {number}   contextBytes
 * @property {string}   provider        - Which AI provider was used (or "stub")
 * @property {boolean}  isStub          - True if real AI was not called
 * @property {string}   duration
 * @property {string}   [error]
 */
export async function generateSQLFromProject(request) {
  const { projectPath, projectName = "project", useAI = true, aiOverride = null } = request;
  const startMs = Date.now();

  try {
    // 1. Scan + analyze
    const files   = scanProject(projectPath);
    if (files.length === 0) {
      return _result({ ok: false, error: `No files found in ${projectPath}`, startMs });
    }

    const summary = summarizeProject(files, projectPath);
    const context = readProjectContext(projectPath, files, summary);

    // 2. Build the prompt
    const prompt = _buildSQLPrompt(projectName, summary, context);

    // 3. AI call (hook — real call injected in RUN 7.3)
    let sql, provider, isStub;

    if (useAI && aiOverride) {
      // RUN 7.3 injection point: aiOverride.call(prompt) → sql
      const aiResult = await aiOverride.call(prompt);
      sql      = aiResult.sql || aiResult.result || "";
      provider = aiOverride.provider || "override";
      isStub   = false;
    } else if (useAI) {
      // Attempt to use RUN 2 AI router if available in local agent context
      const routerResult = await _tryRun2Router(prompt);
      sql      = routerResult.sql;
      provider = routerResult.provider;
      isStub   = routerResult.isStub;
    } else {
      // Analysis-only mode
      sql      = _buildStructuredPlaceholder(summary, context);
      provider = "none";
      isStub   = true;
    }

    return _result({
      ok:           true,
      sql:          sql || _buildStructuredPlaceholder(summary, context),
      prompt,
      analysis:     summary,
      contextFiles: context.includedFiles,
      contextBytes: context.totalBytes,
      provider,
      isStub,
      startMs
    });

  } catch (err) {
    return _result({ ok: false, error: err.message, startMs });
  }
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function _buildSQLPrompt(projectName, summary, context) {
  const ormNote = summary.detectedORM.length
    ? `Detected ORM/schema tools: ${summary.detectedORM.join(", ")}. Convert their models to native PostgreSQL.`
    : "No ORM detected — infer schema from code patterns.";

  const fileLines = context.files.map((f) =>
    `\n### FILE: ${f.file} (${f.category}${f.truncated ? ", truncated" : ""})\n\`\`\`\n${f.content}\n\`\`\``
  ).join("\n");

  return `
You are a senior Supabase/PostgreSQL database architect.

Analyse the following project and generate a complete, production-ready PostgreSQL migration SQL.

PROJECT: ${projectName}
TYPE: ${summary.projectType}
${ormNote}

REQUIREMENTS:
1. Produce ONLY valid PostgreSQL SQL — no markdown, no explanations
2. Use CREATE TABLE IF NOT EXISTS for all tables
3. Use UUID primary keys: id UUID PRIMARY KEY DEFAULT gen_random_uuid()
4. Use TIMESTAMPTZ for all timestamps: DEFAULT now()
5. Add appropriate foreign key constraints with ON DELETE CASCADE where logical
6. Enable Row Level Security on every table:
   ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
7. Add basic RLS policies (owner-based: auth.uid() = user_id or auth.uid() = created_by)
8. Use DROP POLICY IF EXISTS before every CREATE POLICY
9. Add CREATE INDEX IF NOT EXISTS for all foreign key columns and common filter columns
10. Include a schema_version table for migration tracking
11. Wrap everything in a single transaction: BEGIN; ... COMMIT;

SUPABASE COMPATIBILITY:
- Use auth.uid() for user references
- Use auth.users.id as the reference target for user foreign keys
- Do NOT use SERIAL — use gen_random_uuid()
- Enable pgcrypto if needed: CREATE EXTENSION IF NOT EXISTS pgcrypto;

PROJECT FILES:
${fileLines}

Generate the complete SQL migration now:
`.trim();
}

// ─── RUN 2 Router Hook ────────────────────────────────────────────────────────

async function _tryRun2Router(prompt) {
  try {
    // Try to import RUN 2's task layer
    const { runBuilder } = await import("../server/aiTasks.js");
    const result = await runBuilder(prompt);
    return {
      sql:    result.result?.trim() || "",
      provider: result.provider || "run2",
      isStub: !result.ok || result.result?.startsWith("[FALLBACK")
    };
  } catch {
    // RUN 7.3 will replace this stub with real provider calls
    return {
      sql:      "",
      provider: "stub",
      isStub:   true
    };
  }
}

// ─── Structured Placeholder ───────────────────────────────────────────────────

function _buildStructuredPlaceholder(summary, context) {
  const tables = _inferTableNames(summary, context);
  const ts = new Date().toISOString();

  return [
    `-- ============================================================`,
    `-- AI VAULT OS — SQL Placeholder (RUN 7.2)`,
    `-- Real AI generation available in RUN 7.3`,
    `-- Generated: ${ts}`,
    `-- Project type: ${summary.projectType}`,
    `-- Detected ORM: ${summary.detectedORM.join(", ") || "none"}`,
    `-- Signal files: ${summary.signalMatches.slice(0, 5).join(", ") || "none"}`,
    `-- ============================================================`,
    ``,
    `BEGIN;`,
    ``,
    `CREATE EXTENSION IF NOT EXISTS pgcrypto;`,
    ``,
    `-- Schema version tracking`,
    `CREATE TABLE IF NOT EXISTS schema_versions (`,
    `  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),`,
    `  version     TEXT NOT NULL,`,
    `  description TEXT,`,
    `  applied_at  TIMESTAMPTZ DEFAULT now()`,
    `);`,
    ``,
    ...tables.flatMap((t) => [
      `-- Table: ${t}`,
      `CREATE TABLE IF NOT EXISTS ${t} (`,
      `  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),`,
      `  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,`,
      `  created_at TIMESTAMPTZ DEFAULT now(),`,
      `  updated_at TIMESTAMPTZ DEFAULT now()`,
      `);`,
      ``,
      `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
      ``,
      `DROP POLICY IF EXISTS "${t}_owner_select" ON ${t};`,
      `CREATE POLICY "${t}_owner_select" ON ${t}`,
      `  FOR SELECT USING (auth.uid() = created_by);`,
      ``,
      `DROP POLICY IF EXISTS "${t}_owner_insert" ON ${t};`,
      `CREATE POLICY "${t}_owner_insert" ON ${t}`,
      `  FOR INSERT WITH CHECK (auth.uid() = created_by);`,
      ``,
      `DROP POLICY IF EXISTS "${t}_owner_update" ON ${t};`,
      `CREATE POLICY "${t}_owner_update" ON ${t}`,
      `  FOR UPDATE USING (auth.uid() = created_by);`,
      ``,
      `DROP POLICY IF EXISTS "${t}_owner_delete" ON ${t};`,
      `CREATE POLICY "${t}_owner_delete" ON ${t}`,
      `  FOR DELETE USING (auth.uid() = created_by);`,
      ``
    ]),
    `COMMIT;`
  ].join("\n");
}

function _inferTableNames(summary, context) {
  const names = new Set();

  // From schema signal files
  for (const sig of summary.signalMatches) {
    const base = path.basename(sig, path.extname(sig)).toLowerCase();
    if (base.length > 2 && base !== "index" && base !== "schema") names.add(base);
  }

  // From top-level dirs that look like model names
  for (const dir of summary.topLevelDirs) {
    const d = dir.toLowerCase();
    if (["models","entities","types","db","database"].includes(d)) continue;
    if (d.length > 2 && /^[a-z_]+$/.test(d)) names.add(d);
  }

  // From code files in models/ entities/ types/
  for (const f of context.files) {
    if (f.category === "code" && (f.file.includes("model") || f.file.includes("entit") || f.file.includes("schema"))) {
      const base = path.basename(f.file, path.extname(f.file)).toLowerCase().replace(/[^a-z_]/g, "");
      if (base.length > 2 && base !== "index") names.add(base);
    }
  }

  const result = [...names].slice(0, 8); // Cap at 8 tables in placeholder
  return result.length > 0 ? result : ["items", "users_profiles"];
}

// ─── Internal Result Builder ──────────────────────────────────────────────────

function _result({ ok, sql = "", prompt = "", analysis = {}, contextFiles = 0, contextBytes = 0, provider = "stub", isStub = true, error, startMs }) {
  return {
    ok,
    sql,
    prompt,
    analysis,
    contextFiles,
    contextBytes,
    provider,
    isStub,
    duration: `${((Date.now() - startMs) / 1000).toFixed(2)}s`,
    ...(error ? { error } : {})
  };
}
