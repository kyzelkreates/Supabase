/**
 * schemaValidator.js — Schema Validation Layer (RUN 3)
 *
 * Validates that the remote Supabase DB matches the expected local schema.
 * Used by retryLoop.js to determine if an install attempt succeeded.
 *
 * SSOT Rules:
 * ✔ All CLI calls go through supabaseRunner.js
 * ✔ Returns structured validation results — never throws
 * ❌ Never modifies schema (migrationEngine owns that)
 * ❌ Never retries (retryLoop.js owns that)
 */

import { getDBDiff, runCLI } from "./supabaseRunner.js";

// ─── Primary Validator ────────────────────────────────────────────────────────

/**
 * Validate DB schema by diffing local against linked remote.
 *
 * @returns {{ valid: boolean, clean: boolean, raw: string, issues: string[], error: string|null }}
 */
export function validateSchema() {
  const diff = getDBDiff();

  if (!diff.success) {
    return {
      valid: false,
      clean: false,
      raw: "",
      issues: [],
      error: diff.error
    };
  }

  const raw = diff.output || "";
  const issues = parseSchemaIssues(raw);
  const clean = isCleanDiff(raw);

  return {
    valid: clean,
    clean,
    raw,
    issues,
    error: null
  };
}

// ─── Table Existence Check ────────────────────────────────────────────────────

/**
 * Check whether specific tables exist in the remote DB.
 *
 * @param {string[]} tableNames
 * @returns {{ valid: boolean, missing: string[], found: string[], error: string|null }}
 */
export function validateTables(tableNames) {
  const result = runCLI(
    `supabase db execute --command "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';"`
  );

  if (!result.success) {
    return { valid: false, missing: tableNames, found: [], error: result.error };
  }

  const output = result.output.toLowerCase();
  const found = tableNames.filter((t) => output.includes(t.toLowerCase()));
  const missing = tableNames.filter((t) => !output.includes(t.toLowerCase()));

  return {
    valid: missing.length === 0,
    missing,
    found,
    error: null
  };
}

// ─── Column Existence Check ───────────────────────────────────────────────────

/**
 * Validate that a table has the expected columns.
 *
 * @param {string} tableName
 * @param {string[]} expectedColumns
 * @returns {{ valid: boolean, missing: string[], found: string[], error: string|null }}
 */
export function validateColumns(tableName, expectedColumns) {
  const result = runCLI(
    `supabase db execute --command "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${tableName}';"`
  );

  if (!result.success) {
    return { valid: false, missing: expectedColumns, found: [], error: result.error };
  }

  const output = result.output.toLowerCase();
  const found = expectedColumns.filter((c) => output.includes(c.toLowerCase()));
  const missing = expectedColumns.filter((c) => !output.includes(c.toLowerCase()));

  return {
    valid: missing.length === 0,
    missing,
    found,
    error: null
  };
}

/**
 * Run all standard validations in sequence.
 * Returns a combined report.
 *
 * @param {object} [expectations] - { tables: string[], columns: { [table]: string[] } }
 * @returns {ValidationReport}
 */
export function runFullValidation(expectations = {}) {
  const report = {
    timestamp: new Date().toISOString(),
    schemaSync: null,
    tables: null,
    columns: {},
    passed: false,
    summary: []
  };

  // Schema diff
  report.schemaSync = validateSchema();
  if (!report.schemaSync.valid) {
    report.summary.push(`Schema diff: FAIL — ${report.schemaSync.issues.join("; ") || report.schemaSync.error}`);
  } else {
    report.summary.push("Schema diff: PASS");
  }

  // Table checks
  if (expectations.tables?.length) {
    report.tables = validateTables(expectations.tables);
    if (!report.tables.valid) {
      report.summary.push(`Missing tables: ${report.tables.missing.join(", ")}`);
    } else {
      report.summary.push(`Tables (${expectations.tables.length}): PASS`);
    }
  }

  // Column checks
  if (expectations.columns) {
    for (const [table, cols] of Object.entries(expectations.columns)) {
      const colResult = validateColumns(table, cols);
      report.columns[table] = colResult;
      if (!colResult.valid) {
        report.summary.push(`Table "${table}" missing columns: ${colResult.missing.join(", ")}`);
      } else {
        report.summary.push(`Columns in "${table}": PASS`);
      }
    }
  }

  report.passed =
    report.schemaSync.valid &&
    (report.tables === null || report.tables.valid) &&
    Object.values(report.columns).every((c) => c.valid);

  return report;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isCleanDiff(output) {
  return (
    output.includes("No differences") ||
    output.trim() === "" ||
    output.includes("Schema is up to date")
  );
}

function parseSchemaIssues(output) {
  if (isCleanDiff(output)) return [];
  // Each line starting with + or - represents a change
  return output
    .split("\n")
    .filter((l) => /^[+-]/.test(l.trim()))
    .map((l) => l.trim())
    .slice(0, 20); // Cap at 20 for readability
}
