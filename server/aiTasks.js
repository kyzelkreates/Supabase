/**
 * aiTasks.js — Task Abstraction Layer (RUN 2)
 *
 * Public API for all AI task execution in the system.
 * This is the ONLY module that application code should import for AI work.
 *
 * Rule: All AI calls go through here → aiRouter → aiDispatcher → provider
 * No module outside server/ should call aiRouter.js or aiDispatcher.js directly.
 *
 * SSOT Rules:
 * ✔ Single entry point for all AI task execution
 * ✔ Task names are hardcoded here and must match ssot/aiRouting.json keys
 * ❌ Never handles provider logic
 * ❌ Never reads keys or provider config directly
 */

import { runAITask, resolveProvider } from "./aiRouter.js";
import { isFallbackResponse } from "./aiFallback.js";

// ─── Core Task Functions ──────────────────────────────────────────────────────

/**
 * Run a planning/reasoning task.
 * Routed to: groq (or fallback)
 *
 * @param {string} prompt
 * @param {object} [opts] - { model, providerOverride }
 * @returns {Promise<TaskResult>}
 */
export async function runPlanner(prompt, opts = {}) {
  return executeTask("planner", prompt, opts);
}

/**
 * Run a code/content generation task.
 * Routed to: ollama (local, or fallback)
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {Promise<TaskResult>}
 */
export async function runBuilder(prompt, opts = {}) {
  return executeTask("builder", prompt, opts);
}

/**
 * Run a validation/review task.
 * Routed to: ollama (local, or fallback)
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {Promise<TaskResult>}
 */
export async function runValidator(prompt, opts = {}) {
  return executeTask("validator", prompt, opts);
}

/**
 * Run a bug-fix or correction task.
 * Routed to: deepseek (or fallback)
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {Promise<TaskResult>}
 */
export async function runFixer(prompt, opts = {}) {
  return executeTask("fixer", prompt, opts);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Resolve which provider will handle a task without executing it.
 * Useful for UI status display.
 *
 * @param {string} task - "planner" | "builder" | "validator" | "fixer"
 * @returns {{ name: string, type: string, enabled: boolean, models: string[] } | null}
 */
export function getTaskProvider(task) {
  return resolveProvider(task);
}

/**
 * Check if a result object contains a fallback (degraded) response.
 */
export function isTaskFallback(taskResult) {
  return isFallbackResponse(taskResult?.result);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * @typedef {{ result: string, provider: string, task: string, retries: number, ok: boolean }} TaskResult
 */

async function executeTask(task, prompt, opts) {
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    throw new Error(`[aiTasks] Prompt for task "${task}" must be a non-empty string`);
  }

  const raw = await runAITask(task, prompt.trim(), opts);

  return {
    ...raw,
    ok: !isFallbackResponse(raw.result)
  };
}
