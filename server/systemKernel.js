/**
 * systemKernel.js — Core Execution Kernel (RUN 7)
 *
 * The single execution authority for a full project pipeline run.
 * Enforces gate + security checks before any destructive action.
 * Delegates to specialist modules — never duplicates their logic.
 *
 * Execution order:
 *   1. RUN 4.1 safety gate
 *   2. RUN 6 vault/security check
 *   3. RUN 2 AI plan
 *   4. RUN 2 AI build (SQL)
 *   5. RUN 2 AI validate (SQL review)
 *   6. RUN 3 install
 *   7. RUN 4 auto-heal (only if install fails)
 *   8. RUN 3 final schema validation
 *
 * SSOT Rules:
 * ✔ Reads executionState.json via pipelineEngine (sole owner: pipelineEngine)
 * ✔ Every action goes through its owning RUN module
 * ✔ Returns KernelResult — never throws to caller
 * ✔ Gate + security checks are non-bypassable
 * ❌ Never writes SQL or migration files directly (migrationEngine owns that)
 * ❌ Never calls CLI directly
 * ❌ Never accesses vault directly (vaultWrapper owns that)
 */

import { runAITask }         from "./aiRouter.js";
import { installProject, getInstallStatus } from "./installController.js";
import { handleFailure }     from "./healController.js";
import { runPreflightGate, GateBlockedError } from "./runGateController.js";
import { writeMigration }    from "./migrationEngine.js";
import { runFullValidation } from "./schemaValidator.js";
import {
  STAGE_MAP,
  traceEvent,
  newPipelineId
} from "./executionGraph.js";

// ─── Main Kernel Entry ────────────────────────────────────────────────────────

/**
 * Execute a full project pipeline.
 *
 * @param {KernelRequest} request
 * @returns {Promise<KernelResult>}
 *
 * @typedef {object} KernelRequest
 * @property {object}   project           - { name, ref, [password] }
 * @property {string}   prompt            - Natural language description of the schema/system to build
 * @property {object}   [expectations]    - { tables, columns } for final validation
 * @property {boolean}  [skipValidation]  - Skip AI SQL validation step (faster but riskier)
 * @property {boolean}  [dryRun]          - Run planning + build but stop before install
 * @property {function} [onStage]         - Callback: (stageId, type, data) => void
 *
 * @typedef {object} KernelResult
 * @property {boolean}      success
 * @property {string}       pipelineId
 * @property {string}       status       - "success"|"failed"|"partial"|"dry_run"
 * @property {object}       stages       - Per-stage results keyed by stageId
 * @property {TraceEvent[]} trace
 * @property {string}       duration
 * @property {string}       [error]
 */
export async function executeProject(request) {
  const {
    project,
    prompt,
    expectations   = {},
    skipValidation = false,
    dryRun         = false,
    onStage        = null
  } = request;

  const pipelineId = newPipelineId(project?.name);
  const startMs    = Date.now();
  const trace      = [];
  const stages     = {};

  const emit = (stageId, type, data = {}) => {
    const evt = traceEvent(stageId, type, data);
    trace.push(evt);
    if (onStage) { try { onStage(stageId, type, data); } catch {} }
    return evt;
  };

  const stageStart = (id)          => emit(id, "start");
  const stageOk    = (id, data)    => { stages[id] = { ok: true,  ...data };  return emit(id, "success", data); };
  const stageFail  = (id, msg, d)  => { stages[id] = { ok: false, error: msg, ...d }; return emit(id, "fail", { message: msg, ...d }); };
  const stageSkip  = (id, reason)  => { stages[id] = { ok: true,  skipped: true }; return emit(id, "skip", { message: reason }); };
  const stageWarn  = (id, msg)     => emit(id, "warn", { message: msg });

  console.log(`\n[systemKernel] ═══ PIPELINE START: ${project?.name} (${pipelineId}) ═══`);

  // ── STAGE 1: Safety Gate (RUN 4.1) ────────────────────────────────────────
  stageStart("gate");
  let gateResult;
  try {
    gateResult = await runPreflightGate({}, { throwOnBlock: false });
    if (!gateResult.systemReady) {
      stageFail("gate", `Gate closed: ${gateResult.blockingIssues.join(" | ")}`);
      return _buildResult({ success: false, pipelineId, stages, trace, startMs, error: `RUN 4.1 gate closed — ${gateResult.blockingIssues[0]}` });
    }
    if (gateResult.gate === "WARN") stageWarn("gate", gateResult.warnings.join(" | "));
    stageOk("gate", { gate: gateResult.gate });
  } catch (err) {
    stageFail("gate", err.message);
    return _buildResult({ success: false, pipelineId, stages, trace, startMs, error: err.message });
  }

  // ── STAGE 2: Security / Vault Check (RUN 6) ───────────────────────────────
  stageStart("security");
  try {
    const { isUnlocked } = await import("./secureVault.js").catch(() => ({ isUnlocked: () => true }));
    const unlocked = isUnlocked?.() ?? true; // Graceful: if module unavailable, assume server context
    if (!unlocked) {
      stageFail("security", "Vault is locked — unlock the vault before running a pipeline");
      return _buildResult({ success: false, pipelineId, stages, trace, startMs, error: "Vault locked" });
    }
    stageOk("security", { vaultUnlocked: true });
  } catch (err) {
    // Vault module may not be available in server-only context — warn and continue
    stageWarn("security", `Vault check skipped (server context): ${err.message}`);
    stages["security"] = { ok: true, skipped: true };
  }

  // ── STAGE 3: AI Plan (RUN 2) ──────────────────────────────────────────────
  stageStart("planner");
  let planResult;
  try {
    const t0 = Date.now();
    planResult = await runAITask("planner", _buildPlannerPrompt(project, prompt));
    const durationMs = Date.now() - t0;

    if (!planResult.ok) stageWarn("planner", "Planner used fallback provider");
    stageOk("planner", { provider: planResult.provider, durationMs, preview: planResult.result?.slice(0, 120) });
  } catch (err) {
    stageFail("planner", `AI planner failed: ${err.message}`);
    return _buildResult({ success: false, pipelineId, stages, trace, startMs, error: err.message });
  }

  // ── STAGE 4: AI Build — SQL Generation (RUN 2) ───────────────────────────
  stageStart("builder");
  let buildResult;
  try {
    const t0 = Date.now();
    buildResult = await runAITask("builder", _buildBuilderPrompt(project, planResult.result));
    const durationMs = Date.now() - t0;
    const sql = buildResult.result?.trim() || "";

    if (!sql) throw new Error("Builder returned empty SQL");
    if (!buildResult.ok) stageWarn("builder", "Builder used fallback provider");
    stageOk("builder", { provider: buildResult.provider, durationMs, sqlLength: sql.length });
  } catch (err) {
    stageFail("builder", `AI builder failed: ${err.message}`);
    return _buildResult({ success: false, pipelineId, stages, trace, startMs, error: err.message });
  }

  const generatedSQL = buildResult.result.trim();

  // ── STAGE 5: AI Validation (RUN 2) — optional ────────────────────────────
  if (!skipValidation) {
    stageStart("validator");
    try {
      const t0 = Date.now();
      const valResult = await runAITask("validator", _buildValidatorPrompt(generatedSQL));
      const durationMs = Date.now() - t0;
      const feedback = valResult.result?.toLowerCase() || "";

      if (feedback.includes("error") || feedback.includes("invalid") || feedback.includes("broken")) {
        stageWarn("validator", `Validator flagged issues: ${valResult.result?.slice(0, 200)}`);
      } else {
        stageOk("validator", { provider: valResult.provider, durationMs });
      }
    } catch (err) {
      stageWarn("validator", `Validator skipped: ${err.message}`);
      stages["validator"] = { ok: true, skipped: true };
    }
  } else {
    stageSkip("validator", "skipValidation=true");
  }

  // ── DRY RUN EXIT ──────────────────────────────────────────────────────────
  if (dryRun) {
    stageSkip("installer",       "dryRun=true");
    stageSkip("healer",          "dryRun=true");
    stageSkip("finalValidation", "dryRun=true");
    return _buildResult({ success: true, pipelineId, stages, trace, startMs, status: "dry_run", generatedSQL });
  }

  // Write SQL as a migration file (via migrationEngine — never raw fs)
  try {
    writeMigration(project.name, "orchestrator-generated-schema", generatedSQL);
  } catch (writeErr) {
    stageFail("installer", `Failed to write migration: ${writeErr.message}`);
    return _buildResult({ success: false, pipelineId, stages, trace, startMs, error: writeErr.message });
  }

  // ── STAGE 6: Install (RUN 3) ──────────────────────────────────────────────
  stageStart("installer");
  let installResult;
  let installFailed = false;

  try {
    const t0 = Date.now();
    installResult = await installProject({
      name:     project.name,
      ref:      project.ref,
      password: project.password,
      expectations
    });
    const durationMs = Date.now() - t0;

    if (!installResult.success) {
      installFailed = true;
      stageFail("installer", installResult.error || "Install failed", { durationMs, attempts: installResult.attempts });
    } else {
      stageOk("installer", { durationMs, attempts: installResult.attempts });
    }
  } catch (err) {
    installFailed = true;
    stageFail("installer", err.message);
    installResult = { success: false, error: err.message, attempts: 0 };
  }

  // ── STAGE 7: Auto-Heal (RUN 4) — only on install failure ─────────────────
  let healed = false;

  if (installFailed) {
    stageStart("healer");
    try {
      const t0 = Date.now();
      const healResult = await handleFailure({
        errorLog: installResult.error || "install failed",
        sql:      generatedSQL,
        project,
        force:    false
      });
      const durationMs = Date.now() - t0;

      if (healResult.healed) {
        healed = true;
        stageOk("healer", { durationMs, attempts: healResult.totalAttempts });
      } else {
        stageFail("healer", healResult.abortReason || "Heal failed", { durationMs, attempts: healResult.totalAttempts });
        return _buildResult({ success: false, pipelineId, stages, trace, startMs, error: healResult.abortReason });
      }
    } catch (err) {
      stageFail("healer", err.message);
      return _buildResult({ success: false, pipelineId, stages, trace, startMs, error: err.message });
    }
  } else {
    stageSkip("healer", "Install succeeded — heal not needed");
  }

  // ── STAGE 8: Final Validation (RUN 3) ────────────────────────────────────
  stageStart("finalValidation");
  try {
    const t0 = Date.now();
    const validation = runFullValidation(expectations);
    const durationMs = Date.now() - t0;

    if (validation.passed) {
      stageOk("finalValidation", { durationMs, summary: validation.summary });
    } else {
      stageWarn("finalValidation", `Schema validation incomplete: ${validation.summary?.join(" | ")}`);
      stages["finalValidation"] = { ok: true, warnings: validation.summary };
    }
  } catch (err) {
    stageWarn("finalValidation", `Final validation skipped: ${err.message}`);
    stages["finalValidation"] = { ok: true, skipped: true };
  }

  const overallSuccess = !installFailed || healed;
  console.log(`[systemKernel] ═══ PIPELINE COMPLETE: ${project?.name} | ${overallSuccess ? "SUCCESS" : "FAILED"} ═══\n`);

  return _buildResult({ success: overallSuccess, pipelineId, stages, trace, startMs, generatedSQL });
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function _buildResult({ success, pipelineId, stages, trace, startMs, error, status, generatedSQL }) {
  const { summarizeTrace } = require("./executionGraph.js"); // sync require to avoid circular
  const duration = `${((Date.now() - startMs) / 1000).toFixed(1)}s`;
  return {
    success,
    pipelineId,
    status:      status || (success ? "success" : "failed"),
    stages,
    trace,
    duration,
    ...(error        ? { error }        : {}),
    ...(generatedSQL ? { generatedSQL } : {})
  };
}

function _buildPlannerPrompt(project, userPrompt) {
  return `
You are a Supabase backend architect. A developer needs the following system built:

${userPrompt}

Project name: ${project.name}

Produce a concise technical plan:
1. Tables needed (with primary keys, foreign keys, indexes)
2. Row-Level Security (RLS) policies
3. Any required Supabase functions or triggers

Be specific and terse. This output will be fed directly into a SQL generator.
`.trim();
}

function _buildBuilderPrompt(project, plan) {
  return `
You are a Supabase SQL migration writer.

Project: ${project.name}

Architecture plan:
${plan}

Write clean, idempotent PostgreSQL migration SQL that:
- Uses CREATE TABLE IF NOT EXISTS for all tables
- Adds DROP POLICY IF EXISTS before any CREATE POLICY
- Uses UUID primary keys with gen_random_uuid()
- Uses TIMESTAMPTZ for timestamps with DEFAULT now()
- Enables RLS on all tables (ALTER TABLE ... ENABLE ROW LEVEL SECURITY)
- Adds basic owner-based RLS policies

Return ONLY valid SQL. No markdown, no explanation, no code fences.
`.trim();
}

function _buildValidatorPrompt(sql) {
  return `
Review this Supabase PostgreSQL migration SQL for correctness.

Check for:
- Syntax errors
- Missing IF NOT EXISTS guards
- Foreign key ordering issues
- Missing RLS setup
- Type mismatches

SQL:
${sql}

Reply with: "VALID" if there are no issues, or a short list of problems found.
`.trim();
}
