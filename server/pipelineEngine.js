/**
 * pipelineEngine.js — Pipeline Lifecycle Manager (RUN 7)
 *
 * Manages the lifecycle of a full execution pipeline:
 *   - Validates request before passing to systemKernel
 *   - Owns executionState.json (sole reader/writer)
 *   - Prevents concurrent pipelines (pipelineLocked flag)
 *   - Streams stage events to registered listeners
 *   - Returns PipelineReport with full trace
 *
 * SSOT Rules:
 * ✔ SOLE writer of ssot/executionState.json
 * ✔ All execution delegated to systemKernel.js
 * ✔ pipelineLocked prevents concurrent runs
 * ✔ Always unlocks state on completion/error
 * ❌ Never calls RUN 0–6 modules directly (systemKernel owns that)
 */

import fs   from "fs";
import path from "path";
import { executeProject }                 from "./systemKernel.js";
import { newPipelineId, summarizeTrace, formatTrace } from "./executionGraph.js";

const EXEC_STATE_PATH = path.resolve("./ssot/executionState.json");

// ─── State Management ─────────────────────────────────────────────────────────

export function loadExecutionState() {
  try {
    return JSON.parse(fs.readFileSync(EXEC_STATE_PATH, "utf-8"));
  } catch {
    return {
      activeProject: null, status: "idle", stage: null,
      lastAction: null, systemMode: "manual", pipelineLocked: false,
      currentPipelineId: null, stageHistory: []
    };
  }
}

export function saveExecutionState(patch) {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(EXEC_STATE_PATH, "utf-8")); } catch {}
  const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(EXEC_STATE_PATH, JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

const _listeners = new Set();

/**
 * Register a stage event listener.
 * Listener receives: (stageId, type, data, pipelineId)
 *
 * @param {function} fn
 * @returns {function} Unsubscribe function
 */
export function onStageEvent(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _emitStage(stageId, type, data, pipelineId) {
  for (const fn of _listeners) {
    try { fn(stageId, type, data, pipelineId); } catch {}
  }
}

// ─── Main Pipeline Runner ─────────────────────────────────────────────────────

/**
 * Run a full project pipeline.
 * Only one pipeline may run at a time — concurrent calls throw.
 *
 * @param {PipelineRequest} request
 * @returns {Promise<PipelineReport>}
 *
 * @typedef {object} PipelineRequest
 * @property {object}  project
 * @property {string}  prompt
 * @property {object}  [expectations]
 * @property {boolean} [skipValidation]
 * @property {boolean} [dryRun]
 * @property {string}  [mode]  - "manual" | "auto"
 *
 * @typedef {object} PipelineReport
 * @property {boolean}  success
 * @property {string}   pipelineId
 * @property {string}   status
 * @property {object}   stages
 * @property {string}   formattedTrace
 * @property {string}   duration
 * @property {string}   [error]
 * @property {string}   [generatedSQL]
 */
export async function runPipeline(request) {
  const { project, prompt, mode = "manual", ...rest } = request;

  // Input validation
  if (!project?.name) throw new Error("pipelineEngine: project.name is required");
  if (!prompt?.trim()) throw new Error("pipelineEngine: prompt is required");

  // Concurrency guard
  const state = loadExecutionState();
  if (state.pipelineLocked) {
    throw new Error(
      `Pipeline already running for "${state.activeProject}" (${state.currentPipelineId}). ` +
      `Wait for it to complete or call forceUnlockPipeline() to abort.`
    );
  }

  const pipelineId = newPipelineId(project.name);
  const startMs    = Date.now();

  console.log(`[pipelineEngine] Starting pipeline ${pipelineId}`);

  // Lock and set active state
  saveExecutionState({
    pipelineLocked:   true,
    activeProject:    project.name,
    currentPipelineId: pipelineId,
    status:           "running",
    stage:            "gate",
    lastAction:       new Date().toISOString(),
    systemMode:       mode
  });

  try {
    const result = await executeProject({
      project,
      prompt,
      ...rest,
      onStage: (stageId, type, data) => {
        // Update live execution state on each stage transition
        saveExecutionState({ stage: stageId, lastAction: new Date().toISOString() });
        _emitStage(stageId, type, data, pipelineId);
      }
    });

    const finalStatus = result.status || (result.success ? "success" : "failed");

    // Persist final state
    saveExecutionState({
      pipelineLocked:    false,
      status:            finalStatus,
      stage:             finalStatus,
      stageHistory:      _appendHistory(state.stageHistory, pipelineId, finalStatus, Date.now() - startMs),
      activeProject:     project.name
    });

    console.log(`[pipelineEngine] Pipeline ${pipelineId} complete: ${finalStatus} (${result.duration})`);

    return {
      ...result,
      formattedTrace: formatTrace(result.trace || [])
    };

  } catch (err) {
    // Always unlock on unexpected error
    saveExecutionState({
      pipelineLocked: false,
      status:         "error",
      stage:          "error"
    });

    console.error(`[pipelineEngine] Pipeline ${pipelineId} threw: ${err.message}`);
    throw err;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Force-unlock the pipeline (use after a crashed run).
 * Does NOT abort any in-progress execution — call only when you're sure it stopped.
 */
export function forceUnlockPipeline() {
  saveExecutionState({ pipelineLocked: false, status: "idle", stage: null, currentPipelineId: null });
  console.warn("[pipelineEngine] Pipeline force-unlocked");
}

/**
 * Get current execution status (sync, from SSOT file).
 */
export function getPipelineStatus() {
  return loadExecutionState();
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _appendHistory(existing, pipelineId, status, durationMs) {
  const arr = Array.isArray(existing) ? existing : [];
  arr.unshift({ pipelineId, status, durationMs, timestamp: new Date().toISOString() });
  return arr.slice(0, 20); // Keep last 20
}
