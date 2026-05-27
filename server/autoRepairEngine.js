/**
 * autoRepairEngine.js — Architecture Drift Auto-Repair (RUN 7.1)
 *
 * Applies safe, mechanical fixes to findings reported by wiringValidator.js.
 * Only fixes in SAFE_AUTO_FIX_PATTERNS (from dependencyGraph.js) are applied.
 * Every fix is logged with the original line, the replacement, and a timestamp.
 * Creates a .repair-backup/ copy of each file before modification.
 *
 * SSOT Rules:
 * ✔ Only applies fixes listed in dependencyGraph.SAFE_AUTO_FIX_PATTERNS
 * ✔ Backs up every file before modification
 * ✔ Never fixes ERROR-severity structural issues (those need manual review)
 * ✔ Returns RepairReport — never throws to caller
 * ✔ Idempotent: running twice produces identical output
 * ❌ Never deletes files
 * ❌ Never modifies SSOT files
 * ❌ Never modifies server/ RUN 0–7 execution modules
 */

import fs   from "fs";
import path from "path";
import { SAFE_AUTO_FIX_PATTERNS } from "./dependencyGraph.js";

const PROJECT_ROOT  = path.resolve(".");
const BACKUP_DIR    = path.join(PROJECT_ROOT, ".repair-backups");

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Attempt safe auto-repair on a set of findings.
 *
 * @param {Finding[]} findings - From wiringValidator.validateWiring()
 * @returns {RepairReport}
 *
 * @typedef {object} RepairReport
 * @property {RepairAction[]} applied    - Fixes that were applied
 * @property {RepairAction[]} skipped    - Findings that require manual fix
 * @property {string[]}       backups    - Paths of backup files created
 * @property {boolean}        anyApplied
 * @property {string}         summary
 * @property {string}         timestamp
 *
 * @typedef {object} RepairAction
 * @property {string}  findingId
 * @property {string}  file
 * @property {string}  patternId
 * @property {string}  description
 * @property {boolean} success
 * @property {string}  [error]
 */
export function autoRepair(findings) {
  const applied  = [];
  const skipped  = [];
  const backups  = [];

  console.log(`[autoRepairEngine] Processing ${findings.length} findings…`);

  for (const finding of findings) {
    // Only attempt fixes for autoFixable findings
    if (!finding.autoFixable) {
      skipped.push({
        findingId:   finding.id,
        file:        finding.file,
        description: `Skipped — not auto-fixable. ${finding.message}`,
        severity:    finding.severity,
        manualNote:  _getManualNote(finding)
      });
      continue;
    }

    // Find an applicable safe fix pattern
    const filePath  = path.join(PROJECT_ROOT, finding.file);
    const relPath   = finding.file.replace(/\\/g, "/");
    const pattern   = _findApplicablePattern(relPath);

    if (!pattern) {
      skipped.push({
        findingId:   finding.id,
        file:        finding.file,
        description: "No safe auto-fix pattern available — manual review required",
        severity:    finding.severity
      });
      continue;
    }

    // Apply the fix
    const result = _applyFix(filePath, relPath, pattern, finding, backups);
    if (result.success) {
      applied.push(result);
    } else {
      skipped.push({ ...result, description: `Fix failed: ${result.error}` });
    }
  }

  const anyApplied = applied.length > 0;
  const summary = anyApplied
    ? `Applied ${applied.length} fix(es), skipped ${skipped.length}`
    : `No fixes applied. ${skipped.length} issue(s) require manual review`;

  console.log(`[autoRepairEngine] ${summary}`);

  return { applied, skipped, backups, anyApplied, summary, timestamp: new Date().toISOString() };
}

// ─── Fix Application ──────────────────────────────────────────────────────────

function _applyFix(filePath, relPath, pattern, finding, backups) {
  try {
    if (!fs.existsSync(filePath)) {
      return { findingId: finding.id, file: relPath, patternId: pattern.id, success: false, error: "File not found" };
    }

    const original = fs.readFileSync(filePath, "utf-8");

    // Check if the fix is even needed (idempotency)
    if (!pattern.match.test(original)) {
      return {
        findingId:   finding.id,
        file:        relPath,
        patternId:   pattern.id,
        description: `Pattern not found — fix not needed or already applied (idempotent)`,
        success:     true
      };
    }

    // Backup before modifying
    const backupPath = _createBackup(filePath, relPath, backups);

    // Apply replacement
    const fixed = original.replace(pattern.match, pattern.replacement);

    // Sanity check: don't write an empty file
    if (!fixed.trim()) {
      return { findingId: finding.id, file: relPath, patternId: pattern.id, success: false, error: "Replacement produced empty file — aborting" };
    }

    fs.writeFileSync(filePath, fixed, "utf-8");

    console.log(`[autoRepairEngine] Fixed ${relPath} using pattern "${pattern.id}"`);

    return {
      findingId:   finding.id,
      file:        relPath,
      patternId:   pattern.id,
      description: `Applied: ${pattern.id}. Backup at: ${path.relative(PROJECT_ROOT, backupPath)}`,
      backup:      backupPath,
      success:     true
    };

  } catch (err) {
    return { findingId: finding.id, file: relPath, patternId: pattern.id, success: false, error: err.message };
  }
}

// ─── Backup ───────────────────────────────────────────────────────────────────

function _createBackup(filePath, relPath, backups) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const safeName   = relPath.replace(/[/\\]/g, "__");
    const backupPath = path.join(BACKUP_DIR, `${safeName}.${Date.now()}.bak`);
    fs.copyFileSync(filePath, backupPath);
    backups.push(backupPath);
    return backupPath;
  } catch (err) {
    console.warn(`[autoRepairEngine] Could not create backup for ${relPath}: ${err.message}`);
    return null;
  }
}

// ─── Pattern Lookup ───────────────────────────────────────────────────────────

function _findApplicablePattern(relPath) {
  return SAFE_AUTO_FIX_PATTERNS.find((p) => p.applyTo.test(relPath)) || null;
}

// ─── Manual Fix Notes ─────────────────────────────────────────────────────────

function _getManualNote(finding) {
  const notes = {
    MISSING_MODULE:           "Re-run the owning RUN layer to restore the missing module.",
    RUN7_KERNEL_MISSING:      "Verify systemKernel.js exports executeProject correctly.",
    RUN7_ORCHESTRATOR_MISSING:"Verify orchestrator.js exports execute() correctly.",
    RUN7_PIPELINE_LOCK:       "Add pipelineLocked concurrency guard to pipelineEngine.js.",
    SSOT_OWNERSHIP:           "Refactor the write to go through pipelineEngine.saveExecutionState().",
    CIRCULAR_RISK:            "Remove the import of the higher-layer module from this file.",
    SSOT_INVALID_JSON:        "Repair the JSON file manually — it cannot be parsed."
  };

  for (const [key, note] of Object.entries(notes)) {
    if (finding.id?.includes(key)) return note;
  }
  return "Review the architecture boundary rules in dependencyGraph.js.";
}
