/**
 * zipUploader.js — ZIP Upload UI Controller (RUN 7.2)
 *
 * Provides the PWA-side upload flow:
 *   1. File picker / drag-and-drop
 *   2. Client-side pre-validation (type, size)
 *   3. Upload to agent via apiBridge.uploadZipToAgent()
 *   4. Progress tracking
 *   5. Returns { projectId, projectPath, summary } on success
 *
 * SSOT Rules:
 * ✔ All uploads go through apiBridge.js — never direct fetch
 * ✔ Client-side validation runs before any network call
 * ✔ Never extracts ZIP in browser — always delegates to agent
 * ❌ Never stores file contents in IndexedDB
 * ❌ Never calls server/ modules
 */

import { uploadZipToAgent, checkAgentStatus } from "./apiBridge.js";

const MAX_CLIENT_SIZE_MB = 50;
const ALLOWED_MIME       = new Set(["application/zip", "application/x-zip-compressed", "application/x-zip", "application/octet-stream"]);

// ─── Main Upload Function ─────────────────────────────────────────────────────

/**
 * Upload a ZIP file to the agent and return the extracted project info.
 *
 * @param {File}     file
 * @param {function} [onProgress]  - (phase: string, pct: number) => void
 * @returns {Promise<UploadResult>}
 *
 * @typedef {object} UploadResult
 * @property {boolean} ok
 * @property {string}  [projectId]
 * @property {string}  [projectPath]
 * @property {number}  [fileCount]
 * @property {object}  [summary]
 * @property {string}  [error]
 * @property {"validation"|"agent_offline"|"upload"|"unknown"} [reason]
 */
export async function uploadZip(file, onProgress = null) {
  const progress = (phase, pct) => { if (onProgress) onProgress(phase, pct); };

  // 1. Client-side validation
  progress("validating", 0);
  const validation = _validateFile(file);
  if (!validation.ok) return { ok: false, error: validation.error, reason: "validation" };
  progress("validating", 100);

  // 2. Check agent is reachable before uploading
  progress("connecting", 0);
  const agentStatus = await checkAgentStatus();
  if (!agentStatus.reachable) {
    return {
      ok:     false,
      error:  `Agent is offline: ${agentStatus.error}`,
      reason: "agent_offline"
    };
  }
  progress("connecting", 100);

  // 3. Upload
  progress("uploading", 0);
  const result = await uploadZipToAgent(file, 120_000);
  progress("uploading", 100);

  if (!result.ok) {
    return { ok: false, error: result.error, reason: "upload" };
  }

  const data = result.data;
  progress("complete", 100);

  return {
    ok:          true,
    projectId:   data.projectId,
    projectPath: data.projectPath,
    fileCount:   data.fileCount,
    summary:     data.summary,
    uploadedAt:  data.uploadedAt
  };
}

// ─── Render Upload Widget ─────────────────────────────────────────────────────

/**
 * Mount a drag-and-drop upload widget into a container element.
 *
 * @param {HTMLElement|string} container
 * @param {function}           onComplete  - (UploadResult) => void
 */
export function mountUploadWidget(container, onComplete) {
  const el = typeof container === "string" ? document.querySelector(container) : container;
  if (!el) return;

  el.innerHTML = `
    <div id="zip-drop-zone" style="
      border: 2px dashed #252540;
      border-radius: 12px;
      padding: 2rem;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
      background: #10101e;
      position: relative;
    ">
      <div style="font-size: 2rem; margin-bottom: 0.5rem;">📦</div>
      <div style="font-weight: 600; color: #a78bfa; margin-bottom: 0.25rem;">Drop your project ZIP here</div>
      <div style="font-size: 0.78rem; color: #555;">or click to browse — max ${MAX_CLIENT_SIZE_MB}MB</div>
      <input type="file" id="zip-file-input" accept=".zip,application/zip" style="
        position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
      " />
    </div>

    <div id="zip-progress-row" style="display:none;margin-top:0.75rem;">
      <div style="font-size:0.8rem;color:#a78bfa;margin-bottom:0.3rem;" id="zip-progress-label">Uploading…</div>
      <div style="height:4px;background:#252540;border-radius:2px;overflow:hidden;">
        <div id="zip-progress-bar" style="height:100%;background:#7c3aed;width:0%;transition:width 0.3s;"></div>
      </div>
    </div>

    <div id="zip-result" style="margin-top:0.75rem;display:none;"></div>
  `;

  const dropZone  = el.querySelector("#zip-drop-zone");
  const fileInput = el.querySelector("#zip-file-input");

  // Drag events
  dropZone.addEventListener("dragover",  (e) => { e.preventDefault(); dropZone.style.borderColor = "#7c3aed"; dropZone.style.background = "#16162a"; });
  dropZone.addEventListener("dragleave", ()  => { dropZone.style.borderColor = "#252540"; dropZone.style.background = "#10101e"; });
  dropZone.addEventListener("drop",      (e) => {
    e.preventDefault();
    dropZone.style.borderColor = "#252540";
    dropZone.style.background  = "#10101e";
    const file = e.dataTransfer?.files?.[0];
    if (file) _handleFile(file, el, onComplete);
  });

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) _handleFile(file, el, onComplete);
  });
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function _handleFile(file, container, onComplete) {
  const progressRow   = container.querySelector("#zip-progress-row");
  const progressBar   = container.querySelector("#zip-progress-bar");
  const progressLabel = container.querySelector("#zip-progress-label");
  const resultEl      = container.querySelector("#zip-result");
  const dropZone      = container.querySelector("#zip-drop-zone");

  if (progressRow) progressRow.style.display = "";
  if (resultEl)    resultEl.style.display = "none";
  if (dropZone)    dropZone.style.pointerEvents = "none";

  const setProgress = (phase, pct) => {
    if (progressBar)   progressBar.style.width = `${pct}%`;
    if (progressLabel) progressLabel.textContent = _phaseLabel(phase);
  };

  const result = await uploadZip(file, setProgress);

  if (progressRow) progressRow.style.display = "none";
  if (dropZone)    dropZone.style.pointerEvents = "";

  if (resultEl) {
    resultEl.style.display = "";
    if (result.ok) {
      resultEl.innerHTML = `
        <div style="background:#14532d;border:1px solid #22c55e;border-radius:8px;padding:0.75rem 1rem;font-size:0.82rem;">
          <div style="font-weight:600;color:#22c55e;margin-bottom:0.25rem;">✔ Upload complete</div>
          <div style="color:#9ca3af;font-size:0.75rem;">
            ${result.fileCount} files extracted &nbsp;·&nbsp; 
            Project type: ${_esc(result.summary?.projectType || "unknown")} &nbsp;·&nbsp;
            ${result.summary?.detectedORM?.length ? "ORM: " + _esc(result.summary.detectedORM.join(", ")) : ""}
          </div>
          <div style="color:#6b6b8f;font-size:0.72rem;margin-top:0.3rem;font-family:monospace">${_esc(result.projectId)}</div>
        </div>
      `;
    } else {
      resultEl.innerHTML = `
        <div style="background:#450a0a;border:1px solid #ef4444;border-radius:8px;padding:0.75rem 1rem;font-size:0.82rem;">
          <div style="font-weight:600;color:#ef4444;margin-bottom:0.25rem;">✘ Upload failed</div>
          <div style="color:#9ca3af;">${_esc(result.error)}</div>
        </div>
      `;
    }
  }

  if (onComplete) onComplete(result);
}

function _validateFile(file) {
  if (!file) return { ok: false, error: "No file selected" };

  const sizeMB = file.size / 1024 / 1024;
  if (sizeMB > MAX_CLIENT_SIZE_MB) {
    return { ok: false, error: `File too large: ${sizeMB.toFixed(1)}MB (max ${MAX_CLIENT_SIZE_MB}MB)` };
  }

  const name = file.name.toLowerCase();
  if (!name.endsWith(".zip")) {
    return { ok: false, error: "Only .zip files are accepted" };
  }

  return { ok: true };
}

function _phaseLabel(phase) {
  return { validating: "Validating…", connecting: "Connecting to agent…", uploading: "Uploading…", complete: "Complete!" }[phase] || phase;
}

function _esc(str) {
  return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
