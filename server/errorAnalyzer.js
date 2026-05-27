/**
 * errorAnalyzer.js — Error Classification Layer (RUN 4)
 *
 * Classifies raw Supabase/SQL error strings into known error types.
 * Used by recoveryPlanner.js to build targeted AI fix prompts.
 *
 * SSOT Rules:
 * ✔ Pure classification — no side effects, no I/O
 * ✔ Returns structured ErrorReport — never throws
 * ✔ New error patterns added here only
 * ❌ Never generates fixes (recoveryPlanner.js owns that)
 * ❌ Never retries (healController.js owns that)
 */

// ─── Error Type Registry ──────────────────────────────────────────────────────
// Add new patterns here as the system learns from failures.

const ERROR_PATTERNS = [
  {
    type: "DUPLICATE_TABLE",
    patterns: ["relation already exists", "already exists"],
    severity: "medium",
    fixable: true,
    hint: "Use CREATE TABLE IF NOT EXISTS or DROP TABLE IF EXISTS before CREATE."
  },
  {
    type: "PERMISSION_ERROR",
    patterns: ["permission denied", "must be owner", "insufficient privilege"],
    severity: "high",
    fixable: false,
    hint: "Check Supabase project role/permissions. May require service_role key."
  },
  {
    type: "SQL_SYNTAX_ERROR",
    patterns: ["syntax error", "parse error", "unexpected token", "unterminated"],
    severity: "high",
    fixable: true,
    hint: "SQL has a syntax issue. AI fixer will rewrite the statement."
  },
  {
    type: "MISSING_TABLE",
    patterns: ["relation does not exist", "table does not exist", "no such table"],
    severity: "high",
    fixable: true,
    hint: "A referenced table is missing. Check migration order — table must be created first."
  },
  {
    type: "MISSING_COLUMN",
    patterns: ["column does not exist", "no such column", "column .* of relation"],
    severity: "high",
    fixable: true,
    hint: "A referenced column is missing. May need ALTER TABLE or column rename."
  },
  {
    type: "TYPE_MISMATCH",
    patterns: ["type mismatch", "cannot cast", "invalid input syntax for type"],
    severity: "medium",
    fixable: true,
    hint: "Data type issue. AI fixer will adjust column types or cast expressions."
  },
  {
    type: "DUPLICATE_COLUMN",
    patterns: ["column .* of relation .* already exists", "duplicate column"],
    severity: "medium",
    fixable: true,
    hint: "Column already exists. Use IF NOT EXISTS or check migration idempotency."
  },
  {
    type: "FOREIGN_KEY_VIOLATION",
    patterns: ["foreign key constraint", "violates foreign key", "referenced table"],
    severity: "high",
    fixable: true,
    hint: "FK constraint violation. Check table creation order in migrations."
  },
  {
    type: "RLS_POLICY_ERROR",
    patterns: ["row-level security", "policy already exists", "no policy"],
    severity: "medium",
    fixable: true,
    hint: "RLS policy issue. Check policy names and table-level RLS enable state."
  },
  {
    type: "CONNECTION_ERROR",
    patterns: ["connection refused", "could not connect", "timeout", "network error"],
    severity: "critical",
    fixable: false,
    hint: "Cannot reach Supabase. Check project ref, network, and CLI auth."
  },
  {
    type: "AUTH_ERROR",
    patterns: ["authentication failed", "password authentication", "invalid api key", "unauthorized"],
    severity: "critical",
    fixable: false,
    hint: "Auth failure. Check SUPABASE_ACCESS_TOKEN and project credentials."
  }
];

// ─── Main Classifier ──────────────────────────────────────────────────────────

/**
 * Analyze an error log string and return a structured report.
 *
 * @param {string} errorLog - Raw error string from CLI or migration
 * @returns {ErrorReport}
 *
 * @typedef {object} ErrorReport
 * @property {string}   type       - Error type constant
 * @property {string}   severity   - "low" | "medium" | "high" | "critical"
 * @property {boolean}  fixable    - Whether AI fix is worth attempting
 * @property {string}   hint       - Human-readable fix suggestion
 * @property {string[]} matched    - Which patterns matched
 * @property {string}   raw        - Original error string (truncated)
 */
export function analyzeError(errorLog) {
  if (!errorLog || typeof errorLog !== "string") {
    return _unknownError(errorLog);
  }

  const lower = errorLog.toLowerCase();

  for (const entry of ERROR_PATTERNS) {
    const matched = entry.patterns.filter((p) => {
      // Support simple regex patterns (e.g. "column .* of relation")
      try {
        return new RegExp(p, "i").test(lower);
      } catch {
        return lower.includes(p);
      }
    });

    if (matched.length > 0) {
      return {
        type: entry.type,
        severity: entry.severity,
        fixable: entry.fixable,
        hint: entry.hint,
        matched,
        raw: errorLog.slice(0, 500)
      };
    }
  }

  return _unknownError(errorLog);
}

/**
 * Analyze multiple errors at once.
 * Returns the highest-severity fixable error first.
 *
 * @param {string[]} errorLogs
 * @returns {ErrorReport[]}
 */
export function analyzeErrors(errorLogs) {
  const severityRank = { critical: 4, high: 3, medium: 2, low: 1 };
  return errorLogs
    .map(analyzeError)
    .sort((a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0));
}

/**
 * Quick check: is this error type fixable by AI?
 */
export function isFixable(errorLog) {
  return analyzeError(errorLog).fixable;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _unknownError(raw) {
  return {
    type: "UNKNOWN_ERROR",
    severity: "high",
    fixable: true, // Attempt AI fix — might work
    hint: "Unrecognized error. AI fixer will attempt a general repair.",
    matched: [],
    raw: (raw || "").toString().slice(0, 500)
  };
}
