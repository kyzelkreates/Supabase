/**
 * wiringValidator.js — System Wiring Auditor (RUN 7.1)
 *
 * Performs a full static analysis of all RUN 0–7 module files:
 *   1. Required module presence check
 *   2. Import boundary violations (frontend/backend coupling)
 *   3. Circular dependency risk detection
 *   4. RUN 7 single-entry-point integrity
 *   5. SSOT file integrity
 *
 * READ-ONLY. Never modifies files — autoRepairEngine owns that.
 *
 * SSOT Rules:
 * ✔ Pure analysis — reads files, returns a WiringReport, never writes
 * ✔ Uses dependencyGraph.js as the source of truth for rules
 * ✔ Returns structured findings with severity levels
 * ❌ Never modifies any file
 * ❌ Never calls RUN 0–7 execution modules
 */

import fs   from "fs";
import path from "path";
import {
  REQUIRED_MODULES,
  BOUNDARY_RULES,
  MODULE_LAYERS,
  LAYER_GRAPH
} from "./dependencyGraph.js";

const PROJECT_ROOT = path.resolve(".");

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Run full wiring validation.
 *
 * @returns {WiringReport}
 *
 * @typedef {object} WiringReport
 * @property {Finding[]} findings          - All issues found
 * @property {Finding[]} frontendViolations
 * @property {Finding[]} backendViolations
 * @property {Finding[]} brokenLinks
 * @property {boolean}   bypassDetected    - Any ERROR-level gate bypass
 * @property {boolean}   systemReady       - No ERROR-severity findings
 * @property {string}    summary
 * @property {string}    timestamp
 *
 * @typedef {object} Finding
 * @property {string} id
 * @property {"ERROR"|"WARN"|"INFO"} severity
 * @property {string} file
 * @property {string} message
 * @property {string} [detail]
 * @property {boolean} autoFixable
 */
export function validateWiring() {
  const findings = [];

  console.log("[wiringValidator] Starting full system wiring audit…");

  // 1. Required modules
  _checkRequiredModules(findings);

  // 2. Boundary violations (import rules)
  _checkBoundaryViolations(findings);

  // 3. RUN 7 single-entry integrity
  _checkRun7Integrity(findings);

  // 4. SSOT file integrity
  _checkSSOTIntegrity(findings);

  // 5. Circular dependency surface check
  _checkCircularRisk(findings);

  // Categorize
  const frontendViolations = findings.filter((f) => f.id?.includes("PWA") || f.category === "frontend");
  const backendViolations  = findings.filter((f) => f.id?.includes("LOWER_RUN") || f.category === "backend");
  const brokenLinks        = findings.filter((f) => f.category === "missing" || f.category === "integrity");
  const bypassDetected     = findings.some((f) => f.severity === "ERROR");
  const systemReady        = !bypassDetected;

  const errors   = findings.filter((f) => f.severity === "ERROR").length;
  const warnings = findings.filter((f) => f.severity === "WARN").length;
  const infos    = findings.filter((f) => f.severity === "INFO").length;

  const summary = systemReady
    ? `PASS — ${findings.length} findings (${warnings} warnings, ${infos} infos)`
    : `FAIL — ${errors} error(s), ${warnings} warning(s), ${infos} info(s)`;

  console.log(`[wiringValidator] Audit complete: ${summary}`);

  return {
    findings,
    frontendViolations,
    backendViolations,
    brokenLinks,
    bypassDetected,
    systemReady,
    summary,
    timestamp: new Date().toISOString()
  };
}

// ─── Check 1: Required Module Presence ───────────────────────────────────────

function _checkRequiredModules(findings) {
  for (const relPath of REQUIRED_MODULES) {
    const fullPath = path.join(PROJECT_ROOT, relPath);
    if (!fs.existsSync(fullPath)) {
      findings.push({
        id:          `MISSING_MODULE_${relPath.replace(/[/.\-]/g, "_").toUpperCase()}`,
        severity:    "ERROR",
        file:        relPath,
        message:     `Required module missing: ${relPath}`,
        detail:      "This module is required for system integrity. The owning RUN layer is incomplete.",
        category:    "missing",
        autoFixable: false // Missing files can't be auto-repaired — need re-running the owning RUN
      });
    }
  }
}

// ─── Check 2: Boundary Violations ────────────────────────────────────────────

function _checkBoundaryViolations(findings) {
  const allFiles = _getAllJSFiles();

  for (const filePath of allFiles) {
    const relPath = path.relative(PROJECT_ROOT, filePath).replace(/\\/g, "/");
    let content;
    try { content = fs.readFileSync(filePath, "utf-8"); }
    catch { continue; }

    for (const rule of BOUNDARY_RULES) {
      if (!rule.scope.test(relPath)) continue;

      for (const forbidden of rule.forbidden) {
        // Check if this file contains an import of the forbidden module
        // We look for import statements specifically to avoid false positives on comments
        const importPattern = new RegExp(
          `(?:^|\\n)\\s*import\\s+[^;]*\\bfrom\\s+['"][^'"]*${_escapeRegex(forbidden)}[^'"]*['"]`,
          "m"
        );
        const dynamicPattern = new RegExp(
          `(?:^|\\n)[^/]*import\\s*\\([^)]*${_escapeRegex(forbidden)}[^)]*\\)`,
          "m"
        );

        const hasViolation = importPattern.test(content) || dynamicPattern.test(content);
        if (!hasViolation) continue;

        // Check exceptions
        const isException = rule.exceptions?.some((ex) => relPath.includes(ex));
        if (isException) continue;

        const category = relPath.startsWith("pwa/") ? "frontend" : "backend";

        findings.push({
          id:          rule.id,
          severity:    rule.severity,
          file:        relPath,
          message:     rule.message,
          detail:      `Forbidden import of "${forbidden}" found in ${relPath}`,
          category,
          autoFixable: rule.severity === "ERROR" // Only auto-fix ERRORs
        });
      }
    }
  }
}

// ─── Check 3: RUN 7 Integrity ─────────────────────────────────────────────────

function _checkRun7Integrity(findings) {
  const kernelPath      = path.join(PROJECT_ROOT, "server/systemKernel.js");
  const orchestratorPath = path.join(PROJECT_ROOT, "server/orchestrator.js");
  const pipelinePath    = path.join(PROJECT_ROOT, "server/pipelineEngine.js");

  if (!fs.existsSync(kernelPath)) return; // Already caught by required modules check

  const kernel      = fs.readFileSync(kernelPath, "utf-8");
  const orchestrator = fs.existsSync(orchestratorPath) ? fs.readFileSync(orchestratorPath, "utf-8") : "";
  const pipeline    = fs.existsSync(pipelinePath) ? fs.readFileSync(pipelinePath, "utf-8") : "";

  // Kernel must export executeProject
  if (!kernel.includes("export async function executeProject")) {
    findings.push({
      id:          "RUN7_KERNEL_MISSING_EXPORT",
      severity:    "ERROR",
      file:        "server/systemKernel.js",
      message:     "systemKernel.js must export executeProject()",
      detail:      "executeProject is the core execution function called by pipelineEngine.",
      category:    "integrity",
      autoFixable: false
    });
  }

  // Orchestrator must re-export the public surface
  if (orchestrator && !orchestrator.includes("export async function execute")) {
    findings.push({
      id:          "RUN7_ORCHESTRATOR_MISSING_EXPORT",
      severity:    "ERROR",
      file:        "server/orchestrator.js",
      message:     "orchestrator.js must export execute()",
      detail:      "execute() is the single public entry point for all pipeline runs.",
      category:    "integrity",
      autoFixable: false
    });
  }

  // pipelineEngine must be the sole owner of executionState.json
  const allServerFiles = _getAllJSFiles("server");
  for (const f of allServerFiles) {
    const rel = path.relative(PROJECT_ROOT, f).replace(/\\/g, "/");
    if (rel === "server/pipelineEngine.js") continue;
    const content = fs.readFileSync(f, "utf-8");
    // Only flag direct fs writes to executionState, not reads
    if (content.includes("executionState.json") && content.includes("writeFileSync")) {
      findings.push({
        id:          "SSOT_OWNERSHIP_VIOLATION_EXECSTATE",
        severity:    "WARN",
        file:        rel,
        message:     `Only pipelineEngine.js should write executionState.json — found write in ${rel}`,
        detail:      "SSOT files should have a single owner module to prevent state conflicts.",
        category:    "backend",
        autoFixable: false
      });
    }
  }

  // pipelineLocked must be present in pipelineEngine
  if (pipeline && !pipeline.includes("pipelineLocked")) {
    findings.push({
      id:          "RUN7_PIPELINE_LOCK_MISSING",
      severity:    "ERROR",
      file:        "server/pipelineEngine.js",
      message:     "pipelineEngine.js must implement pipelineLocked concurrency guard",
      detail:      "Without this guard, concurrent pipeline runs can corrupt state.",
      category:    "integrity",
      autoFixable: false
    });
  }
}

// ─── Check 4: SSOT Integrity ──────────────────────────────────────────────────

function _checkSSOTIntegrity(findings) {
  const requiredSSOT = [
    { file: "ssot/executionState.json", keys: ["status", "pipelineLocked"] },
    { file: "ssot/systemState.json",    keys: ["systemReady", "blockRun5"] },
    { file: "ssot/securityState.json",  keys: ["encryptionEnabled", "maxAttempts"] },
    { file: "ssot/aiRouting.json",      keys: ["tasks"] },
    { file: "ssot/aiProviders.json",    keys: ["providers"] },
    { file: "ssot/installState.json",   keys: ["status"] },
    { file: "ssot/repairState.json",    keys: ["status", "maxRepairs"] }
  ];

  for (const { file, keys } of requiredSSOT) {
    const fullPath = path.join(PROJECT_ROOT, file);
    if (!fs.existsSync(fullPath)) continue; // Already caught above

    let json;
    try { json = JSON.parse(fs.readFileSync(fullPath, "utf-8")); }
    catch (err) {
      findings.push({
        id:          `SSOT_INVALID_JSON_${file.replace(/[/.\-]/g,"_").toUpperCase()}`,
        severity:    "ERROR",
        file,
        message:     `SSOT file ${file} contains invalid JSON`,
        detail:      err.message,
        category:    "integrity",
        autoFixable: false
      });
      continue;
    }

    for (const key of keys) {
      if (!(key in json)) {
        findings.push({
          id:          `SSOT_MISSING_KEY_${key.toUpperCase()}_IN_${file.replace(/[/.\-]/g,"_").toUpperCase()}`,
          severity:    "WARN",
          file,
          message:     `SSOT file ${file} is missing required key: "${key}"`,
          detail:      "This key is expected by system modules at runtime.",
          category:    "integrity",
          autoFixable: false
        });
      }
    }
  }
}

// ─── Check 5: Circular Dependency Risk ────────────────────────────────────────

function _checkCircularRisk(findings) {
  // Surface-level check: detect when a lower layer imports a higher layer
  // Full cycle detection would require a full AST — this is a pragmatic heuristic

  const higherLayerPatterns = [
    { file: /^server\/(aiRouter|aiDispatcher|providerRegistry)/, forbidden: /orchestrator|pipelineEngine|systemKernel/ },
    { file: /^server\/(installController|supabaseRunner)/,       forbidden: /orchestrator|pipelineEngine|systemKernel|aiRouter/ },
    { file: /^server\/(healController|aiFixEngine)/,             forbidden: /orchestrator|pipelineEngine|projectRunner/ }
  ];

  const allFiles = _getAllJSFiles("server");

  for (const filePath of allFiles) {
    const relPath = path.relative(PROJECT_ROOT, filePath).replace(/\\/g, "/");
    let content;
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { continue; }

    for (const rule of higherLayerPatterns) {
      if (!rule.file.test(relPath)) continue;
      if (rule.forbidden.test(content)) {
        findings.push({
          id:          `CIRCULAR_RISK_${relPath.replace(/[/.\-]/g,"_").toUpperCase()}`,
          severity:    "ERROR",
          file:        relPath,
          message:     `Potential circular dependency: ${relPath} imports from higher orchestration layer`,
          detail:      "Lower RUN layers must never import from orchestrator/pipelineEngine/systemKernel.",
          category:    "backend",
          autoFixable: false
        });
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _getAllJSFiles(subdir = "") {
  const dir = subdir ? path.join(PROJECT_ROOT, subdir) : PROJECT_ROOT;
  const results = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        results.push(full);
      }
    }
  };
  // Only walk pwa/ and server/ — not storage/ or node_modules
  if (!subdir) {
    walk(path.join(PROJECT_ROOT, "server"));
    walk(path.join(PROJECT_ROOT, "pwa"));
  } else {
    walk(dir);
  }
  return results;
}

function _escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
