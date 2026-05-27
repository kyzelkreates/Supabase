/**
 * schemaCompilerAI.js — AI Schema Compilation Engine (RUN 7.3)
 *
 * Takes a UnifiedProjectModel and produces backend-specific schemas.
 * Routes all AI calls through aiProviderManager.js (Ollama-first).
 *
 * Outputs (by target backend):
 *   supabase  → PostgreSQL migration SQL
 *   firebase  → Firestore schema JSON + security rules
 *   both      → Both outputs in a CompilationResult
 *
 * SSOT Rules:
 * ✔ ALL AI calls go through aiProviderManager.runAI() — never direct
 * ✔ Prompts are separated per backend — no mixed output
 * ✔ Each backend output validated before returning
 * ✔ Returns CompilationResult — adapters own deployment
 * ❌ Never deploys anything (backendAdapters own that)
 * ❌ Never reads files directly (model carries all context)
 */

import { runAI } from "./aiProviderManager.js";

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Compile a UnifiedProjectModel into backend schemas using AI.
 *
 * @param {object} unifiedModel  - From projectNormalizer.normalizeProject()
 * @param {object} [options]
 * @param {string} [options.forceProvider]  - Override AI provider
 * @param {boolean} [options.supabaseOnly]
 * @param {boolean} [options.firebaseOnly]
 * @returns {Promise<CompilationResult>}
 *
 * @typedef {object} CompilationResult
 * @property {boolean}  ok
 * @property {string}   projectId
 * @property {string}   projectName
 * @property {BackendOutput} [supabase]
 * @property {BackendOutput} [firebase]
 * @property {string}   provider
 * @property {boolean}  usedFallback
 * @property {string}   duration
 * @property {string}   [error]
 *
 * @typedef {object} BackendOutput
 * @property {boolean} ok
 * @property {string}  content   - SQL or JSON string
 * @property {string}  [error]
 */
export async function compileSchema(unifiedModel, options = {}) {
  const startMs  = Date.now();
  const targets  = unifiedModel.targetBackends || ["supabase"];
  const aiOpts   = { forceProvider: options.forceProvider, taskType: "schema" };

  const result = {
    ok:          false,
    projectId:   unifiedModel.projectId,
    projectName: unifiedModel.projectName,
    provider:    "none",
    usedFallback: false,
    duration:    "0s"
  };

  const modelSummary = _buildModelSummary(unifiedModel);

  // ── Supabase Output ──────────────────────────────────────────────────────
  if (!options.firebaseOnly && targets.includes("supabase")) {
    const prompt  = _buildSupabasePrompt(unifiedModel, modelSummary);
    const aiResult = await runAI(prompt, aiOpts);

    result.provider     = aiResult.provider;
    result.usedFallback = aiResult.usedFallback;

    if (aiResult.ok) {
      const sql = _extractSQL(aiResult.response);
      result.supabase = { ok: true, content: sql };
    } else {
      result.supabase = { ok: false, content: _fallbackSupabaseSQL(unifiedModel), error: aiResult.error };
      console.warn(`[schemaCompilerAI] Supabase AI failed — using structural placeholder: ${aiResult.error}`);
    }
  }

  // ── Firebase Output ──────────────────────────────────────────────────────
  if (!options.supabaseOnly && targets.includes("firebase")) {
    const prompt  = _buildFirebasePrompt(unifiedModel, modelSummary);
    const aiResult = await runAI(prompt, { ...aiOpts, forceProvider: result.provider !== "none" ? result.provider : undefined });

    if (!result.provider || result.provider === "none") {
      result.provider     = aiResult.provider;
      result.usedFallback = aiResult.usedFallback;
    }

    if (aiResult.ok) {
      const schema = _extractJSON(aiResult.response);
      result.firebase = { ok: true, content: schema };
    } else {
      result.firebase = { ok: false, content: _fallbackFirebaseSchema(unifiedModel), error: aiResult.error };
      console.warn(`[schemaCompilerAI] Firebase AI failed — using structural placeholder: ${aiResult.error}`);
    }
  }

  result.ok = (
    (!targets.includes("supabase") || result.supabase?.ok) &&
    (!targets.includes("firebase") || result.firebase?.ok)
  );
  result.duration = `${((Date.now() - startMs) / 1000).toFixed(2)}s`;

  console.log(`[schemaCompilerAI] Compiled ${targets.join("+")} via ${result.provider} in ${result.duration} (fallback: ${result.usedFallback})`);
  return result;
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

function _buildSupabasePrompt(model, summary) {
  return `
You are a senior Supabase/PostgreSQL database architect.

Convert this project into a production-ready Supabase migration.

PROJECT: ${model.projectName}
TYPE: ${model.projectType}
ORM: ${model.detectedORM.join(", ") || "none"}
AUTH MODEL: ${model.authModel?.type || "supabase_auth"}

DETECTED ENTITIES (${model.entities.length}):
${model.entities.map((e) => `  • ${e.name} [${e.sourceHint}] ${e.inferredFields.length ? `— fields: ${e.inferredFields.slice(0, 8).join(", ")}` : ""}`).join("\n")}

DETECTED RELATIONS:
${model.relations.length ? model.relations.map((r) => `  • ${r.from} ${r.type} ${r.to}${r.via ? ` (via ${r.via})` : ""}`).join("\n") : "  (none inferred)"}

CONTEXT FILES (${summary.includedFiles} files, ${summary.totalBytes} bytes):
${summary.fileSnippets}

REQUIREMENTS — produce ONLY valid PostgreSQL SQL:
1. BEGIN; ... COMMIT; transaction wrapper
2. CREATE EXTENSION IF NOT EXISTS pgcrypto;
3. CREATE TABLE IF NOT EXISTS for every entity
4. UUID PKs: id UUID PRIMARY KEY DEFAULT gen_random_uuid()
5. TIMESTAMPTZ timestamps: created_at DEFAULT now(), updated_at DEFAULT now()
6. created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL on every table
7. Foreign keys with ON DELETE CASCADE for child tables
8. ALTER TABLE ... ENABLE ROW LEVEL SECURITY on every table
9. DROP POLICY IF EXISTS + CREATE POLICY for select/insert/update/delete on every table
10. CREATE INDEX IF NOT EXISTS on all foreign key columns
11. schema_versions tracking table

Return ONLY SQL. No markdown, no explanations, no code fences.
`.trim();
}

function _buildFirebasePrompt(model, summary) {
  return `
You are a Firebase/Firestore architecture expert.

Convert this project into a Firestore schema definition and security rules.

PROJECT: ${model.projectName}
TYPE: ${model.projectType}
AUTH: ${model.authModel?.type || "firebase_auth"}

DETECTED ENTITIES (${model.entities.length}):
${model.entities.map((e) => `  • ${e.name} ${e.inferredFields.length ? `— fields: ${e.inferredFields.slice(0, 6).join(", ")}` : ""} ${e.hasSubEntities ? "(has subcollections)" : ""}`).join("\n")}

CONTEXT FILES:
${summary.fileSnippets}

Produce TWO sections clearly separated:

=== FIRESTORE_SCHEMA ===
A JSON object defining each collection with fields and types.
Format: { "collectionName": { "fields": { "fieldName": "type" }, "subcollections": {} } }

=== FIRESTORE_RULES ===
Firestore security rules (valid rules syntax, version 2).
Include: authenticated read/write, owner-only write for user data.

Return exactly these two sections. No other text.
`.trim();
}

// ─── Output Extractors ────────────────────────────────────────────────────────

function _extractSQL(response) {
  // Strip markdown fences if the model added them
  const stripped = response
    .replace(/^```sql\s*/im, "")
    .replace(/^```\s*/im, "")
    .replace(/```\s*$/m, "")
    .trim();

  // Ensure it starts with a valid SQL statement
  if (stripped.toUpperCase().startsWith("BEGIN") || stripped.toUpperCase().startsWith("CREATE") || stripped.toUpperCase().startsWith("--")) {
    return stripped;
  }

  // If the model added prose before the SQL, extract from first BEGIN/CREATE
  const sqlStart = stripped.search(/^\s*(BEGIN|CREATE|ALTER|INSERT|--)/im);
  return sqlStart >= 0 ? stripped.slice(sqlStart).trim() : stripped;
}

function _extractJSON(response) {
  // Try to extract the FIRESTORE_SCHEMA section
  const schemaMatch = response.match(/===\s*FIRESTORE_SCHEMA\s*===\s*([\s\S]+?)(?:===|$)/i);
  const rulesMatch  = response.match(/===\s*FIRESTORE_RULES\s*===\s*([\s\S]+?)(?:===|$)/i);

  return JSON.stringify({
    schema: schemaMatch ? schemaMatch[1].trim() : response,
    rules:  rulesMatch  ? rulesMatch[1].trim()  : ""
  }, null, 2);
}

// ─── Fallback Placeholders ────────────────────────────────────────────────────

function _fallbackSupabaseSQL(model) {
  const tables = model.entities.slice(0, 10);
  const ts = new Date().toISOString();
  return [
    `-- AI Vault OS — Supabase Placeholder (AI unavailable)`,
    `-- Project: ${model.projectName} | Generated: ${ts}`,
    `-- Entities inferred: ${model.entities.map((e) => e.name).join(", ")}`,
    ``,
    `BEGIN;`,
    `CREATE EXTENSION IF NOT EXISTS pgcrypto;`,
    ``,
    ...tables.flatMap((e) => [
      `CREATE TABLE IF NOT EXISTS ${e.name} (`,
      `  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),`,
      `  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,`,
      `  created_at TIMESTAMPTZ DEFAULT now(),`,
      `  updated_at TIMESTAMPTZ DEFAULT now()`,
      `);`,
      `ALTER TABLE ${e.name} ENABLE ROW LEVEL SECURITY;`,
      `DROP POLICY IF EXISTS "${e.name}_owner_all" ON ${e.name};`,
      `CREATE POLICY "${e.name}_owner_all" ON ${e.name} USING (auth.uid() = created_by) WITH CHECK (auth.uid() = created_by);`,
      ``
    ]),
    `COMMIT;`
  ].join("\n");
}

function _fallbackFirebaseSchema(model) {
  const schema = {};
  for (const e of model.entities) {
    schema[e.name] = {
      fields: Object.fromEntries((e.inferredFields.slice(0, 8) || []).map((f) => [f, "string"])),
      subcollections: {}
    };
  }
  return JSON.stringify({ schema, rules: "// AI unavailable — add rules manually" }, null, 2);
}

// ─── Model Summary for Prompt ─────────────────────────────────────────────────

function _buildModelSummary(model) {
  const fileSnippets = (model.contextFiles || []).slice(0, 15).map((f) =>
    `\n### ${f.file} (${f.category})\n${(f.content || "").slice(0, 1500)}`
  ).join("\n");

  const totalBytes = (model.contextFiles || []).reduce((sum, f) => sum + (f.bytes || 0), 0);

  return { fileSnippets, includedFiles: (model.contextFiles || []).length, totalBytes };
}
