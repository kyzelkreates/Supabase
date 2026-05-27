/**
 * supabaseRunner.js — Supabase CLI Execution Layer (RUN 3)
 *
 * The ONLY module allowed to invoke Supabase CLI commands.
 * All other modules call this — never exec() directly.
 *
 * SSOT Rules:
 * ✔ Single point of CLI execution
 * ✔ Returns structured { success, output, error } — never throws
 * ✔ Logs all executions with timestamp for audit trail
 * ❌ Never reads AI output directly (installController owns that)
 * ❌ Never defines migrations (migrationEngine owns that)
 */

import { execSync } from "child_process";

const CLI_TIMEOUT_MS = 60_000; // 60s max per CLI command

// ─── Core CLI Runner ─────────────────────────────────────────────────────────

/**
 * Execute a Supabase CLI command safely.
 *
 * @param {string} command - Full CLI command string
 * @param {object} [opts]  - { cwd, env, timeout }
 * @returns {{ success: boolean, output: string, error: string|null, command: string, timestamp: string }}
 */
export function runCLI(command, opts = {}) {
  const timestamp = new Date().toISOString();
  const { cwd = process.cwd(), env = process.env, timeout = CLI_TIMEOUT_MS } = opts;

  console.log(`[supabaseRunner] ${timestamp} → ${command}`);

  try {
    const output = execSync(command, {
      encoding: "utf-8",
      cwd,
      env,
      timeout,
      stdio: ["pipe", "pipe", "pipe"]
    });

    console.log(`[supabaseRunner] ✔ success`);
    return { success: true, output: output.trim(), error: null, command, timestamp };

  } catch (err) {
    const error = err.stderr?.trim() || err.stdout?.trim() || err.message;
    console.error(`[supabaseRunner] ✘ failed: ${error}`);
    return { success: false, output: "", error, command, timestamp };
  }
}

// ─── Named Operations ────────────────────────────────────────────────────────

/**
 * Link CLI to a remote Supabase project.
 * @param {string} ref - Project reference ID from Supabase dashboard
 * @param {string} [password] - DB password (passed via env for safety — not as arg)
 */
export function linkProject(ref, password) {
  const env = { ...process.env };
  if (password) env.SUPABASE_DB_PASSWORD = password;
  return runCLI(`supabase link --project-ref ${ref}`, { env });
}

/**
 * Push all pending local migrations to the linked remote DB.
 */
export function pushMigrations() {
  return runCLI("supabase db push");
}

/**
 * Reset the local/remote DB (dev use only — destructive).
 */
export function resetDB() {
  return runCLI("supabase db reset");
}

/**
 * Get DB diff between local schema and linked remote.
 * Used by schemaValidator.js.
 */
export function getDBDiff() {
  return runCLI("supabase db diff --linked");
}

/**
 * Execute a raw SQL file against the linked DB.
 * @param {string} filePath - Absolute or relative path to .sql file
 */
export function executeSQLFile(filePath) {
  return runCLI(`supabase db execute --file "${filePath}"`);
}

/**
 * Execute a raw SQL string (written to a temp file first for safety).
 * @param {string} sql - Raw SQL string
 * @param {string} tmpPath - Temp file path to write SQL before executing
 */
export function executeSQL(sql, tmpPath) {
  const { writeFileSync } = await import("fs");
  writeFileSync(tmpPath, sql, "utf-8");
  return executeSQLFile(tmpPath);
}

/**
 * Check Supabase CLI version (also used as a health/presence check).
 */
export function checkCLI() {
  return runCLI("supabase --version");
}

/**
 * Get current project status.
 */
export function getProjectStatus() {
  return runCLI("supabase status");
}
