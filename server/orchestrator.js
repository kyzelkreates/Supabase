/**
 * orchestrator.js — Top-Level System Orchestrator (RUN 7)
 *
 * The outermost API. Wires together the full system and provides
 * the clean, versioned public interface that external callers
 * (CLI, tests, future API endpoints) use to interact with the engine.
 *
 * Also handles system-mode switching:
 *   "manual"  — operator triggers each run explicitly (default)
 *   "auto"    — future: event-driven pipelines (RUN 7+ extension point)
 *
 * SSOT Rules:
 * ✔ Thin orchestration shell — all logic in projectRunner / pipelineEngine
 * ✔ Validates system mode before any execution
 * ✔ Re-exports the full public API surface as a single import
 * ❌ Never calls RUN 0–6 modules directly
 */

import {
  runProject,
  planOnly,
  healProject,
  getStatus,
  forceUnlock,
  onStageEvent
} from "./projectRunner.js";
import { loadExecutionState, saveExecutionState } from "./pipelineEngine.js";
import { STAGES, HAPPY_PATH, STAGE_MAP }          from "./executionGraph.js";

// ─── System Mode ──────────────────────────────────────────────────────────────

/**
 * Set the system execution mode.
 *
 * @param {"manual"|"auto"} mode
 */
export function setSystemMode(mode) {
  if (!["manual", "auto"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  saveExecutionState({ systemMode: mode });
  console.log(`[orchestrator] System mode set to: ${mode}`);
}

/**
 * Get current system mode.
 */
export function getSystemMode() {
  return loadExecutionState().systemMode || "manual";
}

// ─── Primary Execute ──────────────────────────────────────────────────────────

/**
 * Execute a full AI → Build → Install → Heal pipeline.
 * The single entry point for the complete autonomous system.
 *
 * @param {object} params
 * @param {string} params.projectName
 * @param {string} params.ref             - Supabase project ref
 * @param {string} [params.password]      - DB password
 * @param {string} params.prompt          - Natural language description
 * @param {object} [params.expectations]
 * @param {boolean} [params.dryRun]
 * @param {boolean} [params.skipValidation]
 * @returns {Promise<PipelineReport>}
 */
export async function execute(params) {
  const state = loadExecutionState();
  if (state.pipelineLocked) {
    throw new Error(`Pipeline is locked (running: ${state.currentPipelineId}). Call forceUnlock() if it crashed.`);
  }
  return runProject({ mode: getSystemMode(), ...params });
}

/**
 * Preview what the AI would generate without touching Supabase.
 * Safe to call anytime — no installs, no migrations, no state changes.
 */
export async function preview(projectName, prompt) {
  return planOnly(projectName, prompt);
}

/**
 * Manually trigger the heal system for a project with a known error.
 */
export async function heal(projectName, ref, errorLog, sql) {
  return healProject(projectName, ref, errorLog, sql);
}

// ─── Status & Diagnostics ─────────────────────────────────────────────────────

/**
 * Full system status snapshot.
 *
 * @returns {SystemStatus}
 *
 * @typedef {object} SystemStatus
 * @property {object} execution    - Current executionState.json
 * @property {object} pipeline     - Pipeline stage definitions
 * @property {string} systemMode
 * @property {string} timestamp
 */
export function status() {
  const exec = loadExecutionState();
  return {
    execution:   exec,
    pipeline: {
      stages:    STAGES.map((s) => ({ id: s.id, label: s.label, run: s.run, critical: s.critical })),
      happyPath: HAPPY_PATH,
      stageCount: STAGES.length
    },
    systemMode:  exec.systemMode || "manual",
    timestamp:   new Date().toISOString()
  };
}

// ─── Re-exports (single import surface) ──────────────────────────────────────

export {
  onStageEvent,   // Subscribe to live stage events
  forceUnlock,    // Force-unlock a stuck pipeline
  getStatus,      // Quick pipeline status
  STAGES,         // Stage definitions (for UI rendering)
  HAPPY_PATH,     // Ordered stage IDs
  STAGE_MAP       // Stage lookup by ID
};
