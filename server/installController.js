/**
 * installController.js — Main Install Orchestrator (RUN 3)
 *
 * The single entry point for all Supabase project installations.
 * Connects AI-generated output (RUN 2) → migration files → live DB.
 *
 * Execution order:
 *   1. Validate inputs + pre-flight CLI check
 *   2. Link remote Supabase project
 *   3. Write AI-generated SQL as migration files (if provided)
 *   4. Run migrations with retry loop
 *   5. Push final state
 *   6. Validate and return report
 *
 * SSOT Rules:
 * ✔ Orchestrates only — delegates to specialist modules
 * ✔ Owns installState.json (read/write)
 * ✔ Integrates with RUN 2 AI output via aiTasks.js (optional)
 * ❌ Never calls CLI directly (supabaseRunner.js only)
 * ❌ Never writes SQL directly (migrationEngine.js only)
 * ❌ Never validates schema directly (schemaValidator.js only)
 */

import fs from "fs";
import path from "path";
import { linkProject, pushMigrations, checkCLI, getProjectStatus } from "./supabaseRunner.js";
import { runMigrations, writeMigration, listMigrations } from "./migrationEngine.js";
import { retryUntilValid } from "./retryLoop.js";
import { runFullValidation } from "./schemaValidator.js";

const INSTALL_STATE_PATH = path.resolve("./ssot/installState.json");

// ─── SSOT State Management ────────────────────────────────────────────────────

export function loadInstallState() {
  try {
    const raw = fs.readFileSync(INSTALL_STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      status: "idle",
      currentProject: null,
      currentRun: 0,
      lastMigration: null,
      retryCount: 0,
      maxRetries: 3,
      completedMigrations: {}
    };
  }
}

export function saveInstallState(state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(INSTALL_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// ─── Main Install Entry Point ─────────────────────────────────────────────────

/**
 * Full install pipeline for a Supabase project.
 *
 * @param {InstallConfig} project
 * @returns {Promise<InstallReport>}
 *
 * @typedef {object} InstallConfig
 * @property {string}   name          - Project slug (used for migration folder)
 * @property {string}   ref           - Supabase project reference ID
 * @property {string}   [password]    - DB password (never logged)
 * @property {string[]} [sqlMigrations] - AI-generated SQL strings to apply
 * @property {object}   [expectations] - { tables, columns } for validation
 *
 * @typedef {object} InstallReport
 * @property {boolean} success
 * @property {string}  project
 * @property {number}  attempts
 * @property {object}  validation
 * @property {string}  [error]
 * @property {string}  duration
 */
export async function installProject(project) {
  const startTime = Date.now();
  const { name, ref, password, sqlMigrations = [], expectations = {} } = project;

  console.log(`\n[installController] ═══ INSTALL START: ${name} ═══`);

  // Update SSOT state
  const state = loadInstallState();
  state.status = "installing";
  state.currentProject = name;
  state.currentRun = (state.currentRun || 0) + 1;
  saveInstallState(state);

  try {
    // STEP 1 — Pre-flight: check CLI is available
    const cliCheck = checkCLI();
    if (!cliCheck.success) {
      throw new Error(`Supabase CLI not found or not working: ${cliCheck.error}`);
    }
    console.log(`[installController] ✔ CLI ready (${cliCheck.output})`);

    // STEP 2 — Link remote project
    console.log(`[installController] Linking project ref: ${ref}`);
    const link = linkProject(ref, password);
    if (!link.success) {
      throw new Error(`Failed to link project "${ref}": ${link.error}`);
    }
    console.log(`[installController] ✔ Project linked`);

    // STEP 3 — Write AI-generated SQL as migration files
    if (sqlMigrations.length > 0) {
      console.log(`[installController] Writing ${sqlMigrations.length} AI-generated migration(s)...`);
      for (const migration of sqlMigrations) {
        const { description = "ai-generated-schema", sql } = migration;
        writeMigration(name, description, sql);
      }
    }

    // STEP 4 — Run migrations with retry loop
    console.log(`[installController] Starting migration + retry loop...`);
    const retryResult = await retryUntilValid(
      async () => {
        runMigrations(name);
        pushMigrations();
      },
      {
        maxRetries: state.maxRetries || 3,
        delayMs: 3000,
        expectations,
        projectName: name,
        onRetry: (attempt, err) => {
          console.warn(`[installController] Retry ${attempt}: ${err?.message || "schema invalid"}`);
        }
      }
    );

    if (!retryResult.success) {
      throw new Error(
        `Install failed after ${retryResult.attempts} attempts: ${retryResult.error}`
      );
    }

    // STEP 5 — Final validation report
    const validation = runFullValidation(expectations);
    const duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

    // Update SSOT state — success
    const finalState = loadInstallState();
    finalState.status = "installed";
    finalState.lastMigration = listMigrations(name).slice(-1)[0] || null;
    saveInstallState(finalState);

    console.log(`[installController] ═══ INSTALL COMPLETE: ${name} (${duration}) ═══\n`);

    return {
      success: true,
      project: name,
      attempts: retryResult.attempts,
      validation,
      duration
    };

  } catch (err) {
    const duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
    console.error(`[installController] ✘ INSTALL FAILED: ${err.message}`);

    // Update SSOT state — failed
    const failState = loadInstallState();
    failState.status = "failed";
    saveInstallState(failState);

    return {
      success: false,
      project: name,
      attempts: state.retryCount || 0,
      validation: null,
      error: err.message,
      duration
    };
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Check current install state without triggering anything.
 */
export function getInstallStatus() {
  return loadInstallState();
}

/**
 * Reset install state back to idle (use before a fresh install attempt).
 */
export function resetInstallState(projectName) {
  const state = loadInstallState();
  state.status = "idle";
  state.currentProject = projectName || null;
  state.retryCount = 0;
  state.lastMigration = null;
  saveInstallState(state);
  return state;
}
