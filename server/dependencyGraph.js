/**
 * dependencyGraph.js — System Dependency Graph + Boundary Rules (RUN 7.1)
 *
 * Defines the canonical dependency graph for all RUN layers and the
 * architecture boundary rules that wiringValidator.js enforces.
 *
 * Two types of rules:
 *   1. LAYER_GRAPH      — which RUN may call which (directional dependency)
 *   2. BOUNDARY_RULES   — which import patterns are illegal in which file paths
 *
 * SSOT Rules:
 * ✔ Pure data — no I/O, no async, no side effects
 * ✔ This is the single source of truth for architecture rules
 * ✔ Adding a new allowed import requires updating this file only
 * ❌ Never modified by autoRepairEngine (rules are not auto-generated)
 */

// ─── Layer Graph ──────────────────────────────────────────────────────────────
// Key = layer, value = layers it is ALLOWED to call
// Direction: top-down only (higher RUN → lower RUN, never reverse)

export const LAYER_GRAPH = {
  RUN7_ORCHESTRATOR: ["RUN7_KERNEL", "RUN6_SECURITY", "RUN41_GATE", "RUN5_DASHBOARD"],
  RUN7_KERNEL:       ["RUN2_ROUTER", "RUN3_INSTALLER", "RUN4_HEALER", "RUN41_GATE", "RUN6_SECURITY", "RUN7_GRAPH"],
  RUN5_DASHBOARD:    ["RUN7_ORCHESTRATOR", "RUN41_GATE", "RUN6_SECURITY"],
  RUN41_GATE:        ["RUN3_INSTALLER", "RUN4_HEALER", "RUN2_ROUTER", "RUN1_VAULT"],
  RUN4_HEALER:       ["RUN2_ROUTER", "RUN3_MIGRATIONS"],
  RUN3_INSTALLER:    ["RUN3_MIGRATIONS", "RUN3_SCHEMA", "RUN3_RETRY", "SUPABASE_CLI"],
  RUN2_ROUTER:       ["RUN1_PROVIDERS", "RUN2_DISPATCHER", "RUN2_FALLBACK"],
  RUN6_SECURITY:     ["RUN0_VAULT"],
  RUN0_VAULT:        [],
  RUN1_PROVIDERS:    ["RUN0_VAULT"]
};

// ─── Module → Layer Mapping ───────────────────────────────────────────────────
// Maps file path fragments to their owning layer

export const MODULE_LAYERS = {
  // RUN 7
  "server/orchestrator":       "RUN7_ORCHESTRATOR",
  "server/projectRunner":      "RUN7_ORCHESTRATOR",
  "server/pipelineEngine":     "RUN7_ORCHESTRATOR",
  "server/systemKernel":       "RUN7_KERNEL",
  "server/executionGraph":     "RUN7_GRAPH",
  // RUN 5 (PWA dashboard)
  "pwa/dashboard":             "RUN5_DASHBOARD",
  "pwa/orchestrationPanel":    "RUN5_DASHBOARD",
  "pwa/runConsole":            "RUN5_DASHBOARD",
  "pwa/installPanel":          "RUN5_DASHBOARD",
  "pwa/aiPanel":               "RUN5_DASHBOARD",
  "pwa/systemPanel":           "RUN5_DASHBOARD",
  "pwa/projectPanel":          "RUN5_DASHBOARD",
  "pwa/logsPanel":             "RUN5_DASHBOARD",
  // RUN 6
  "pwa/secureVault":           "RUN6_SECURITY",
  "pwa/cryptoLayer":           "RUN6_SECURITY",
  "pwa/authSession":           "RUN6_SECURITY",
  "pwa/lockScreen":            "RUN6_SECURITY",
  "pwa/vaultWrapper":          "RUN6_SECURITY",
  // RUN 4.1
  "server/runGateController":  "RUN41_GATE",
  "server/dependencyValidator":"RUN41_GATE",
  "server/systemHealthCheck":  "RUN41_GATE",
  "pwa/preflight-check":       "RUN41_GATE",
  "pwa/health-dashboard":      "RUN41_GATE",
  // RUN 4
  "server/healController":     "RUN4_HEALER",
  "server/aiFixEngine":        "RUN4_HEALER",
  "server/errorAnalyzer":      "RUN4_HEALER",
  "server/recoveryPlanner":    "RUN4_HEALER",
  // RUN 3
  "server/installController":  "RUN3_INSTALLER",
  "server/migrationEngine":    "RUN3_MIGRATIONS",
  "server/schemaValidator":    "RUN3_SCHEMA",
  "server/retryLoop":          "RUN3_RETRY",
  "server/supabaseRunner":     "SUPABASE_CLI",
  // RUN 2
  "server/aiRouter":           "RUN2_ROUTER",
  "server/aiDispatcher":       "RUN2_DISPATCHER",
  "server/aiFallback":         "RUN2_FALLBACK",
  "server/aiTasks":            "RUN2_ROUTER",
  // RUN 1
  "server/providerRegistry":   "RUN1_PROVIDERS",
  "pwa/ai-vault":              "RUN1_VAULT",
  // RUN 0
  "pwa/db":                    "RUN0_VAULT",
  "pwa/vault":                 "RUN0_VAULT",
  "storage/vault":             "RUN0_VAULT"
};

// ─── Boundary Rules ───────────────────────────────────────────────────────────
// Defines what is ILLEGAL to import in specific file path scopes.
// Each rule: { scope: regex pattern for file path, forbidden: [import substrings] }

export const BOUNDARY_RULES = [
  {
    id:        "NO_PWA_DIRECT_SERVER_EXECUTION",
    scope:     /^pwa\//,
    forbidden: [
      "installController",
      "systemKernel",
      "supabaseRunner",
      "migrationEngine",
      "schemaValidator",
      "retryLoop"
    ],
    severity:  "ERROR",
    message:   "PWA files must not import server execution modules directly. Use orchestrator.js or projectRunner.js."
  },
  {
    id:        "NO_PWA_DIRECT_AI_ROUTER",
    scope:     /^pwa\//,
    forbidden: ["server/aiRouter", "aiDispatcher"],
    severity:  "WARN",
    message:   "PWA files should call AI through aiTasks.js or orchestrator.js, not the router directly."
  },
  {
    id:        "NO_RUN0_CALLER_BYPASSING_VAULT_WRAPPER",
    scope:     /^pwa\//,
    forbidden: ["secureVault"],
    exceptions: ["vaultWrapper", "authSession", "lockScreen"], // These are allowed
    severity:  "WARN",
    message:   "PWA application code should use vaultWrapper.js, not secureVault.js directly."
  },
  {
    id:        "NO_LOWER_RUN_IMPORTING_ORCHESTRATOR",
    scope:     /^server\/(aiRouter|aiDispatcher|installController|healController|migrationEngine|schemaValidator|retryLoop|supabaseRunner|providerRegistry)/,
    forbidden: ["orchestrator", "pipelineEngine", "systemKernel", "projectRunner"],
    severity:  "ERROR",
    message:   "Lower RUN modules must not import from the orchestration layer (circular dependency risk)."
  },
  {
    id:        "NO_GATE_BYPASS",
    scope:     /^server\/(systemKernel|orchestrator|pipelineEngine|projectRunner)/,
    forbidden: ["installController.js"],
    exceptions: ["installController"], // These must always be called via systemKernel, not directly from orchestrator
    severity:  "INFO",
    message:   "Orchestrator layer should call installController only through systemKernel."
  }
];

// ─── Required Module Presence ─────────────────────────────────────────────────
// These files MUST exist for the system to be considered intact

export const REQUIRED_MODULES = [
  // RUN 7 core
  "server/orchestrator.js",
  "server/systemKernel.js",
  "server/pipelineEngine.js",
  "server/projectRunner.js",
  "server/executionGraph.js",
  // RUN 6 security
  "pwa/secureVault.js",
  "pwa/cryptoLayer.js",
  "pwa/authSession.js",
  "pwa/lockScreen.js",
  "pwa/vaultWrapper.js",
  // RUN 4.1 gate
  "server/runGateController.js",
  "server/dependencyValidator.js",
  "server/systemHealthCheck.js",
  // RUN 4
  "server/healController.js",
  "server/aiFixEngine.js",
  "server/errorAnalyzer.js",
  "server/recoveryPlanner.js",
  // RUN 3
  "server/installController.js",
  "server/migrationEngine.js",
  "server/schemaValidator.js",
  "server/supabaseRunner.js",
  // RUN 2
  "server/aiRouter.js",
  "server/aiDispatcher.js",
  "server/aiFallback.js",
  "server/aiTasks.js",
  // RUN 1
  "server/providerRegistry.js",
  // SSOT
  "ssot/executionState.json",
  "ssot/systemState.json",
  "ssot/installState.json",
  "ssot/repairState.json",
  "ssot/securityState.json",
  "ssot/aiRouting.json",
  "ssot/aiProviders.json"
];

// ─── Auto-Repair Safe Fixes ────────────────────────────────────────────────────
// Only these patterns are safe for autoRepairEngine to remove/replace.
// Anything not listed here requires MANUAL review.

export const SAFE_AUTO_FIX_PATTERNS = [
  {
    id:          "remove_direct_install_controller_import",
    match:       /^import\s+.*installController.*from\s+['"]\.\.\/server\/installController\.js['"]\s*;?\s*$/m,
    replacement: "// [ARCH-REPAIR] Direct installController import removed — use orchestrationPanel.js instead",
    applyTo:     /^pwa\//
  },
  {
    id:          "remove_direct_systemkernel_import",
    match:       /^import\s+.*systemKernel.*from\s+['"]\.\.\/server\/systemKernel\.js['"]\s*;?\s*$/m,
    replacement: "// [ARCH-REPAIR] Direct systemKernel import removed — use orchestrator.js",
    applyTo:     /^pwa\//
  },
  {
    id:          "remove_direct_airouter_import",
    match:       /^import\s+.*aiRouter.*from\s+['"]\.\.\/server\/aiRouter\.js['"]\s*;?\s*$/m,
    replacement: "// [ARCH-REPAIR] Direct aiRouter import removed — use aiTasks.js",
    applyTo:     /^pwa\//
  },
  {
    id:          "remove_direct_supabaserunner_import",
    match:       /^import\s+.*supabaseRunner.*from\s+['"]\.\.\/server\/supabaseRunner\.js['"]\s*;?\s*$/m,
    replacement: "// [ARCH-REPAIR] Direct supabaseRunner import removed — use installPanel.js → orchestrator.js",
    applyTo:     /^pwa\//
  }
];
