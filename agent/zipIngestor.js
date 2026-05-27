/**
 * zipIngestor.js — ZIP Source Ingestor Adapter (RUN 7.3)
 *
 * Thin adapter between zipController.js (RUN 7.2) and projectNormalizer.js.
 * Converts an already-extracted project directory into a NormalizedSource.
 * Can also accept a raw File/path and trigger extraction if needed.
 *
 * SSOT Rules:
 * ✔ Delegates file reading to projectAnalyzer.js (RUN 7.2)
 * ✔ Returns NormalizedSource — normalizer owns the merge
 * ✔ Does not duplicate zipController logic
 * ❌ Never extracts ZIPs directly (zipController owns that)
 */

import path from "path";
import { scanProject, summarizeProject, readProjectContext } from "./projectAnalyzer.js";

/**
 * Ingest an already-extracted project directory as a NormalizedSource.
 *
 * @param {ZipIngestRequest} request
 * @returns {ZipIngestResult}
 *
 * @typedef {object} ZipIngestRequest
 * @property {string} projectPath  - Path to extracted project dir
 * @property {string} [projectId]
 * @property {string} [projectName]
 * @property {string} [originalFilename]
 *
 * @typedef {object} ZipIngestResult
 * @property {boolean}     ok
 * @property {NormalizedSource} [source]
 * @property {string}      [error]
 */
export function ingestZipProject(request) {
  const { projectPath, projectId, projectName, originalFilename } = request;

  try {
    const files   = scanProject(projectPath);
    const summary = summarizeProject(files, projectPath);
    const context = readProjectContext(projectPath, files, summary);

    return {
      ok:     true,
      source: {
        sourceType:       "zip",
        sourceUri:        originalFilename || path.basename(projectPath),
        projectId:        projectId || path.basename(projectPath),
        projectName:      projectName || path.basename(projectPath),
        projectType:      summary.projectType,
        detectedORM:      summary.detectedORM,
        files:            context.files,
        totalFiles:       files.length,
        includedFiles:    context.includedFiles,
        signalFiles:      summary.signalFiles || summary.signalMatches,
        schemaFiles:      summary.schemaFiles,
        topLevelDirs:     summary.topLevelDirs,
        byCategory:       summary.byCategory,
        ingestedAt:       new Date().toISOString()
      }
    };
  } catch (err) {
    return { ok: false, error: `ZIP ingest failed: ${err.message}` };
  }
}
