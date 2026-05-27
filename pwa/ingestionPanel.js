/**
 * ingestionPanel.js — Multi-Source Ingestion Panel (RUN 7.3)
 *
 * Unified panel for all source types: ZIP, GitHub, Firebase.
 * Routes ingestion to the correct agent endpoint and displays result.
 *
 * SSOT Rules:
 * ✔ All API calls via projectClient.js → apiBridge.js
 * ✔ ZIP upload delegated to zipUploader.mountUploadWidget()
 * ✔ Source selector UI delegated to sourceSelectorUI.js
 * ❌ Never calls server/ or agent/ modules directly
 */

import { showToast, esc }                        from "./dashboard.js";
import { sendToAgent }                           from "./apiBridge.js";
import { mountUploadWidget }                     from "./zipUploader.js";
import { renderSourceSelector, getSelectedSource } from "./sourceSelectorUI.js";

let _lastResult = null;

// ─── Panel Entry ─────────────────────────────────────────────────────────────

export async function loadIngestionPanel(root) {
  root.innerHTML = `
    <div class="panel-title">📥 Source Ingestion</div>

    <!-- Source selector -->
    <div class="card" id="source-selector-card">
      <h3 style="margin-bottom:0.75rem;">Select Source Type</h3>
      <div id="source-selector-root"></div>
    </div>

    <!-- Source-specific input -->
    <div class="card" id="source-input-card" style="display:none;">
      <div id="source-input-root"></div>
    </div>

    <!-- Ingest button -->
    <div class="card" id="ingest-action-card" style="display:none;">
      <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;">
        <div class="form-group" style="margin:0;flex:1;min-width:180px;">
          <label>Project Name</label>
          <input id="ingest-project-name" type="text" placeholder="my-project" />
        </div>
        <div class="form-group" style="margin:0;flex:0 0 auto;align-self:flex-end;">
          <button class="btn btn-primary" id="ingest-btn" onclick="window.__ingest.run()">
            📥 Ingest + Analyse
          </button>
        </div>
      </div>
    </div>

    <!-- Results -->
    <div id="ingest-result" style="display:none;"></div>
  `;

  renderSourceSelector(
    document.getElementById("source-selector-root"),
    _onSourceChanged
  );

  window.__ingest = {
    run: _runIngestion
  };
}

// ─── Source Changed ───────────────────────────────────────────────────────────

function _onSourceChanged(sourceType) {
  const inputCard  = document.getElementById("source-input-card");
  const actionCard = document.getElementById("ingest-action-card");
  const inputRoot  = document.getElementById("source-input-root");
  if (!inputCard || !inputRoot) return;

  inputCard.style.display  = "";
  actionCard.style.display = "";

  switch (sourceType) {
    case "zip":
      inputRoot.innerHTML = `<h3 style="margin-bottom:0.75rem;">Upload ZIP</h3><div id="zip-widget-mount"></div>`;
      mountUploadWidget(document.getElementById("zip-widget-mount"), (result) => {
        if (result.ok) {
          // Pre-fill project name from projectId
          const nameInput = document.getElementById("ingest-project-name");
          if (nameInput && !nameInput.value) nameInput.value = result.projectId;
          window.__ingest._zipResult = result;
          showToast("✔ ZIP extracted — click Ingest to analyse", "ok");
        }
      });
      break;

    case "github":
      inputRoot.innerHTML = `
        <h3 style="margin-bottom:0.75rem;">GitHub Repository</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
          <div class="form-group" style="margin:0;">
            <label>Owner / Username</label>
            <input id="gh-owner" type="text" placeholder="octocat" />
          </div>
          <div class="form-group" style="margin:0;">
            <label>Repository</label>
            <input id="gh-repo" type="text" placeholder="my-app" />
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-top:0.6rem;">
          <div class="form-group" style="margin:0;">
            <label>Branch / Tag <span style="color:#555;font-weight:400">(optional)</span></label>
            <input id="gh-ref" type="text" placeholder="main" />
          </div>
          <div class="form-group" style="margin:0;">
            <label>GitHub Token <span style="color:#555;font-weight:400">(private repos)</span></label>
            <input id="gh-token" type="password" placeholder="ghp_…" />
          </div>
        </div>
      `;
      break;

    case "firebase":
      inputRoot.innerHTML = `
        <h3 style="margin-bottom:0.75rem;">Firebase Export</h3>
        <div class="form-group">
          <label>Firebase Export Path <span style="color:#555;font-weight:400">(on agent server)</span></label>
          <input id="fb-path" type="text" placeholder="/path/to/firebase-export or firebase.json dir" />
        </div>
        <div style="font-size:0.78rem;color:#555;margin-top:0.3rem;">
          💡 Run <code style="background:#1a1a2e;padding:0.1rem 0.3rem;border-radius:3px">firebase firestore:export ./export</code> then point to that directory.
        </div>
      `;
      break;

    default:
      inputRoot.innerHTML = "";
  }
}

// ─── Ingestion Runner ─────────────────────────────────────────────────────────

async function _runIngestion() {
  const source      = getSelectedSource();
  const projectName = document.getElementById("ingest-project-name")?.value.trim();

  if (!source) { showToast("Select a source type first", "err"); return; }
  if (!projectName) { showToast("Enter a project name", "err"); return; }

  const btn = document.getElementById("ingest-btn");
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner">⟳</span> Ingesting…`; }

  try {
    let payload = { projectName, sourceType: source };

    switch (source) {
      case "zip":
        if (!window.__ingest._zipResult?.projectPath) {
          showToast("Upload a ZIP first", "err"); return;
        }
        payload.projectPath = window.__ingest._zipResult.projectPath;
        break;
      case "github":
        payload.owner = document.getElementById("gh-owner")?.value.trim();
        payload.repo  = document.getElementById("gh-repo")?.value.trim();
        payload.ref   = document.getElementById("gh-ref")?.value.trim() || undefined;
        payload.token = document.getElementById("gh-token")?.value.trim() || undefined;
        if (!payload.owner || !payload.repo) { showToast("Owner and repo are required", "err"); return; }
        break;
      case "firebase":
        payload.firebasePath = document.getElementById("fb-path")?.value.trim();
        if (!payload.firebasePath) { showToast("Enter the Firebase export path", "err"); return; }
        break;
    }

    const res = await sendToAgent("ingest", payload, { timeout: 60_000 });

    if (res.ok) {
      _lastResult = res.data;
      _renderIngestionResult(res.data);
      showToast("✔ Ingestion complete", "ok");
    } else {
      showToast(`Ingestion failed: ${res.error}`, "err");
    }

  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "📥 Ingest + Analyse"; }
  }
}

// ─── Result Renderer ──────────────────────────────────────────────────────────

function _renderIngestionResult(data) {
  const el = document.getElementById("ingest-result");
  if (!el) return;
  el.style.display = "";

  const model = data.unifiedModel || {};
  const entities = model.entities || [];
  const files    = model.contextFiles?.length || data.fileCount || 0;

  el.innerHTML = `
    <div class="card">
      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;">
        <span style="font-size:1.5rem">✅</span>
        <div>
          <div style="font-weight:700;color:var(--ok)">Ingestion Complete</div>
          <div style="font-size:0.78rem;color:var(--text-muted)">${esc(data.projectName || "")} · ${esc(data.sourceType || "")}</div>
        </div>
        <button class="btn btn-primary btn-sm" style="margin-left:auto;" onclick="window.__ingest.compileSchema()">
          🧠 Compile Schema →
        </button>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.5rem;margin-bottom:0.75rem;">
        ${_stat("Entities", entities.length, "var(--accent-lt)")}
        ${_stat("Context Files", files, "#9ca3af")}
        ${_stat("Source Type", data.sourceType || "—", "#6b6b8f")}
      </div>

      ${entities.length ? `
        <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.4rem">Detected Entities</div>
        <div style="display:flex;flex-wrap:wrap;gap:0.3rem;">
          ${entities.slice(0, 20).map((e) => `<span style="background:#1e1b4b;color:#a78bfa;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.75rem">${esc(e.name)}</span>`).join("")}
          ${entities.length > 20 ? `<span style="color:#555;font-size:0.75rem">+${entities.length - 20} more</span>` : ""}
        </div>
      ` : ""}
    </div>
  `;

  window.__ingest.compileSchema = async () => {
    if (!_lastResult) return;
    await import("./backendSelector.js").then(({ openBackendSelector }) => openBackendSelector(_lastResult));
  };
}

function _stat(label, value, color) {
  return `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:0.6rem;text-align:center;">
      <div style="font-size:1.1rem;font-weight:700;color:${color}">${esc(String(value))}</div>
      <div style="font-size:0.7rem;color:var(--text-muted);margin-top:0.1rem">${label}</div>
    </div>
  `;
}
