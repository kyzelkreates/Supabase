/**
 * recoveryPlanner.js — AI Fix Prompt Builder (RUN 4)
 *
 * Builds targeted prompts based on error type + broken SQL,
 * then sends them through the RUN 2 AI router (fixer task).
 *
 * SSOT Rules:
 * ✔ All AI calls go through aiRouter.js (RUN 2) only
 * ✔ Prompt strategy is owned here — not in aiRouter or aiTasks
 * ✔ Returns { sql, provider, retries, ok } — callers handle application
 * ❌ Never writes files (migrationEngine.js owns that)
 * ❌ Never retries independently (healController.js owns retry logic)
 */

import { runAITask } from "./aiRouter.js";

// ─── Prompt Templates by Error Type ──────────────────────────────────────────

const PROMPT_STRATEGIES = {
  DUPLICATE_TABLE: (sql) => `
You are a Supabase SQL repair assistant.

The following migration failed because a table or relation already exists.

Fix ONLY this issue by adding IF NOT EXISTS to all CREATE TABLE statements,
or by adding DROP TABLE IF EXISTS before each CREATE TABLE.
Do not change any other logic.

Broken SQL:
\`\`\`sql
${sql}
\`\`\`

Return ONLY the corrected SQL. No explanation, no markdown, no code fences.
`.trim(),

  SQL_SYNTAX_ERROR: (sql, raw) => `
You are a Supabase SQL repair assistant.

The following SQL has a syntax error and failed to execute.

Error details:
${raw}

Fix ALL syntax errors in this SQL so it runs cleanly on PostgreSQL 15+.
Do not change table names, column names, or data types unless required.

Broken SQL:
\`\`\`sql
${sql}
\`\`\`

Return ONLY the corrected SQL. No explanation, no markdown, no code fences.
`.trim(),

  MISSING_TABLE: (sql, raw) => `
You are a Supabase SQL repair assistant.

The following migration references a table that does not exist yet.

Error details:
${raw}

Fix this by adding the missing CREATE TABLE statement(s) BEFORE the statement
that references them. Infer the table structure from context in the SQL.

Broken SQL:
\`\`\`sql
${sql}
\`\`\`

Return ONLY the corrected SQL. No explanation, no markdown, no code fences.
`.trim(),

  MISSING_COLUMN: (sql, raw) => `
You are a Supabase SQL repair assistant.

The following migration references a column that does not exist.

Error details:
${raw}

Fix this by adding the missing column via ALTER TABLE IF NOT EXISTS,
or by correcting the column reference.

Broken SQL:
\`\`\`sql
${sql}
\`\`\`

Return ONLY the corrected SQL. No explanation, no markdown, no code fences.
`.trim(),

  TYPE_MISMATCH: (sql, raw) => `
You are a Supabase SQL repair assistant.

The following migration has a data type mismatch or invalid cast.

Error details:
${raw}

Fix the type issue. Use explicit CAST() or correct the column type definition.
Use PostgreSQL-compatible types only (UUID, TEXT, BIGINT, TIMESTAMPTZ, JSONB, BOOLEAN).

Broken SQL:
\`\`\`sql
${sql}
\`\`\`

Return ONLY the corrected SQL. No explanation, no markdown, no code fences.
`.trim(),

  DUPLICATE_COLUMN: (sql) => `
You are a Supabase SQL repair assistant.

The following migration fails because a column already exists.

Fix this by wrapping the ADD COLUMN statement with IF NOT EXISTS,
or by removing the duplicate column definition.

Broken SQL:
\`\`\`sql
${sql}
\`\`\`

Return ONLY the corrected SQL. No explanation, no markdown, no code fences.
`.trim(),

  FOREIGN_KEY_VIOLATION: (sql, raw) => `
You are a Supabase SQL repair assistant.

The following migration has a foreign key constraint issue.

Error details:
${raw}

Fix this by ensuring the referenced table is created first,
or by adding DEFERRABLE INITIALLY DEFERRED to the constraint if needed.

Broken SQL:
\`\`\`sql
${sql}
\`\`\`

Return ONLY the corrected SQL. No explanation, no markdown, no code fences.
`.trim(),

  RLS_POLICY_ERROR: (sql, raw) => `
You are a Supabase SQL repair assistant.

The following migration has an RLS policy conflict.

Error details:
${raw}

Fix this by adding DROP POLICY IF EXISTS before CREATE POLICY,
or by using CREATE POLICY IF NOT EXISTS where supported.

Broken SQL:
\`\`\`sql
${sql}
\`\`\`

Return ONLY the corrected SQL. No explanation, no markdown, no code fences.
`.trim(),

  // Default fallback for unknown/general errors
  DEFAULT: (sql, raw) => `
You are a Supabase SQL repair assistant.

The following migration failed with this error:
${raw}

Analyze the error and fix the SQL so it runs cleanly on PostgreSQL 15 / Supabase.
Preserve all table names, column names, and intended logic.

Broken SQL:
\`\`\`sql
${sql}
\`\`\`

Return ONLY the corrected SQL. No explanation, no markdown, no code fences.
`.trim()
};

// ─── Main Fix Generator ───────────────────────────────────────────────────────

/**
 * Build a targeted fix prompt and send it to the AI fixer.
 *
 * @param {import("./errorAnalyzer.js").ErrorReport} errorReport
 * @param {string} rawSQL     - The broken SQL string
 * @returns {Promise<FixResult>}
 *
 * @typedef {object} FixResult
 * @property {string}  sql       - The AI-generated fixed SQL
 * @property {string}  provider  - Which AI provider handled the fix
 * @property {number}  retries   - Retry count from router
 * @property {boolean} ok        - Whether a real response came back (not fallback)
 * @property {string}  errorType - The classified error type
 */
export async function generateFix(errorReport, rawSQL) {
  const { type, raw: rawError } = errorReport;

  const strategy = PROMPT_STRATEGIES[type] || PROMPT_STRATEGIES.DEFAULT;
  const prompt = strategy(rawSQL, rawError);

  console.log(`[recoveryPlanner] Sending fix prompt for error type: ${type}`);

  const response = await runAITask("fixer", prompt);

  // Strip any accidental markdown fences the AI might include
  const cleanSQL = stripCodeFences(response.result || "");

  return {
    sql: cleanSQL,
    provider: response.provider,
    retries: response.retries,
    ok: response.ok,
    errorType: type
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripCodeFences(text) {
  return text
    .replace(/^```(?:sql)?\s*/im, "")
    .replace(/\s*```$/im, "")
    .trim();
}
