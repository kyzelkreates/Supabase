/**
 * executionGraph.js — Pipeline Stage Registry + Execution Trace (RUN 7)
 *
 * Defines the canonical execution graph — all stages, their order,
 * dependencies, and metadata. Used by pipelineEngine.js to drive
 * execution order and by runConsole.js to render trace output.
 *
 * SSOT Rules:
 * ✔ Pure data + trace helpers — no I/O, no async, no side effects
 * ✔ Stage definitions are the SSOT for pipeline shape
 * ✔ Trace events are immutable records — append-only
 * ❌ Never triggers execution (pipelineEngine owns that)
 * ❌ Never reads/writes SSOT files
 */

// ─── Stage Definitions ────────────────────────────────────────────────────────

/**
 * Ordered pipeline stages. Each stage maps to exactly one RUN layer.
 * `requires` lists stage IDs that must have succeeded before this stage runs.
 */
export const STAGES = [
  {
    id:          "gate",
    label:       "Safety Gate Check",
    run:         "4.1",
    description: "Validate all system layers are healthy before execution",
    requires:    [],
    critical:    true   // Pipeline aborts if this fails
  },
  {
    id:          "security",
    label:       "Security / Vault Check",
    run:         "6",
    description: "Verify vault is unlocked and AI keys are accessible",
    requires:    ["gate"],
    critical:    true
  },
  {
    id:          "planner",
    label:       "AI Planning",
    run:         "2",
    description: "AI generates system architecture and migration plan",
    requires:    ["security"],
    critical:    true
  },
  {
    id:          "builder",
    label:       "AI Build (SQL Generation)",
    run:         "2",
    description: "AI generates Supabase SQL schema from the plan",
    requires:    ["planner"],
    critical:    true
  },
  {
    id:          "validator",
    label:       "AI Validation",
    run:         "2",
    description: "AI validates the generated SQL before execution",
    requires:    ["builder"],
    critical:    false  // Warn but continue if validation is non-blocking
  },
  {
    id:          "installer",
    label:       "Supabase Install",
    run:         "3",
    description: "Write migration files and execute against Supabase project",
    requires:    ["builder"],
    critical:    true
  },
  {
    id:          "healer",
    label:       "Auto-Heal",
    run:         "4",
    description: "Detect install failures and run AI fix loop",
    requires:    ["installer"],
    critical:    false, // Only runs if installer fails — not in happy path
    conditional: true   // Only executed if its trigger condition is met
  },
  {
    id:          "finalValidation",
    label:       "Final Schema Validation",
    run:         "3",
    description: "Verify remote schema matches expectations after install",
    requires:    ["installer"],
    critical:    false
  }
];

// Stage map for O(1) lookup
export const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.id, s]));

// Ordered happy-path IDs (no conditional stages)
export const HAPPY_PATH = STAGES.filter((s) => !s.conditional).map((s) => s.id);

// ─── Trace Event System ───────────────────────────────────────────────────────

/**
 * Create a new trace event (immutable record).
 *
 * @param {string}  stageId
 * @param {"start"|"success"|"fail"|"skip"|"warn"} type
 * @param {object}  [data]
 * @returns {TraceEvent}
 *
 * @typedef {object} TraceEvent
 * @property {string} id        - Unique event ID
 * @property {string} stageId
 * @property {string} type
 * @property {string} timestamp - ISO string
 * @property {object} [data]
 */
export function traceEvent(stageId, type, data = {}) {
  return {
    id:        `${stageId}_${type}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    stageId,
    type,
    timestamp: new Date().toISOString(),
    data
  };
}

/**
 * Build a pipeline run ID.
 * Format: pipe_<project>_<timestamp>
 */
export function newPipelineId(projectName) {
  const safe = (projectName || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `pipe_${safe}_${Date.now()}`;
}

/**
 * Compute aggregate pipeline status from a trace array.
 *
 * @param {TraceEvent[]} trace
 * @returns {"running"|"success"|"failed"|"partial"}
 */
export function summarizeTrace(trace) {
  const hasStart   = trace.some((e) => e.type === "start");
  const hasFailure = trace.some((e) => e.type === "fail");
  const hasCriticalFail = trace.some((e) => {
    if (e.type !== "fail") return false;
    const stage = STAGE_MAP[e.stageId];
    return stage?.critical !== false;
  });

  const completedIds = new Set(
    trace.filter((e) => e.type === "success").map((e) => e.stageId)
  );
  const allDone = HAPPY_PATH.every((id) => completedIds.has(id));

  if (!hasStart)        return "idle";
  if (hasCriticalFail)  return "failed";
  if (allDone)          return "success";
  if (hasFailure)       return "partial";
  return "running";
}

/**
 * Format a trace as a readable log string (for runConsole.js).
 *
 * @param {TraceEvent[]} trace
 * @returns {string}
 */
export function formatTrace(trace) {
  const icons = { start: "▶", success: "✔", fail: "✘", skip: "⏭", warn: "⚠" };
  return trace.map((e) => {
    const stage = STAGE_MAP[e.stageId];
    const time  = e.timestamp.slice(11, 19);
    const icon  = icons[e.type] || "·";
    const label = stage?.label || e.stageId;
    const note  = e.data?.message ? ` — ${e.data.message}` : "";
    const dur   = e.data?.durationMs ? ` (${(e.data.durationMs / 1000).toFixed(1)}s)` : "";
    return `[${time}] ${icon} ${label}${dur}${note}`;
  }).join("\n");
}
