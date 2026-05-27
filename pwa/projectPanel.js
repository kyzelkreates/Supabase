/**
 * projectPanel.js — Project Management Panel (RUN 5)
 *
 * UI for creating, listing, and managing projects.
 * Projects are stored in IndexedDB ("projects" store).
 * No backend execution here — install is delegated to installPanel.js.
 *
 * SSOT Rules:
 * ✔ Pure UI + IndexedDB CRUD
 * ✔ Install triggers delegated to installPanel.js
 * ❌ Never calls installController.js directly
 * ❌ Never bypasses gate
 */

import { openDB }    from "./db.js";
import { showToast, esc } from "./utils.js";

const DB_STORE = "projects";

// ─── Panel Entry ─────────────────────────────────────────────────────────────

export async function loadProjectsPanel(root) {
  root.innerHTML = `
    <div class="panel-title">📁 Projects</div>

    <!-- Create form -->
    <div class="card" id="create-form-card">
      <h3>New Project</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-top:0.75rem;">
        <div class="form-group" style="margin:0">
          <label>Project Name</label>
          <input id="proj-name" type="text" placeholder="my-app" />
        </div>
        <div class="form-group" style="margin:0">
          <label>Supabase Project Ref</label>
          <input id="proj-ref" type="text" placeholder="abcdefghijklmnop" />
        </div>
      </div>
      <div style="margin-top:0.75rem;display:flex;gap:0.5rem;">
        <button class="btn btn-primary btn-sm" id="create-btn" onclick="window.__projects.create()">+ Create Project</button>
      </div>
    </div>

    <!-- Project list -->
    <div class="card">
      <h3>All Projects</h3>
      <div id="project-list" style="margin-top:0.75rem;">
        <div style="color:#555;font-size:0.82rem;padding:0.5rem 0">Loading projects…</div>
      </div>
    </div>
  `;

  await renderProjectList();

  // Expose handlers
  window.__projects = {
    create: createProject,
    remove: removeProject,
    goInstall: (name, ref) => {
      window.__dash?.nav("install", document.querySelector('[data-panel="install"]'));
      // Pass project context via sessionStorage so installPanel can pick it up
      sessionStorage.setItem("install_target", JSON.stringify({ name, ref }));
    }
  };
}

// ─── Project List Renderer ────────────────────────────────────────────────────

async function renderProjectList() {
  const listEl = document.getElementById("project-list");
  if (!listEl) return;

  let projects = [];
  try {
    projects = await getAllProjects();
  } catch (err) {
    listEl.innerHTML = `<div style="color:#ef4444;font-size:0.82rem">Failed to load projects: ${esc(err.message)}</div>`;
    return;
  }

  if (projects.length === 0) {
    listEl.innerHTML = `<div style="color:#555;font-size:0.82rem;padding:0.5rem 0">No projects yet. Create one above.</div>`;
    return;
  }

  listEl.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Supabase Ref</th>
          <th>Status</th>
          <th>Created</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${projects.map((p) => `
          <tr>
            <td style="font-weight:600;color:#c4b5fd">${esc(p.name)}</td>
            <td style="font-family:monospace;color:#9ca3af;font-size:0.78rem">${esc(p.ref)}</td>
            <td><span class="badge ${_statusClass(p.status)}">${esc(p.status || "idle")}</span></td>
            <td style="color:#6b6b8f;font-size:0.78rem">${_fmtDate(p.createdAt)}</td>
            <td style="display:flex;gap:0.4rem;">
              <button class="btn btn-secondary btn-sm" onclick="window.__projects.goInstall('${esc(p.name)}','${esc(p.ref)}')">Install</button>
              <button class="btn btn-danger btn-sm" onclick="window.__projects.remove(${p.id})">✕</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

async function createProject() {
  const name = document.getElementById("proj-name")?.value.trim();
  const ref  = document.getElementById("proj-ref")?.value.trim();

  if (!name || !ref) { showToast("Project name and ref are required", "err"); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) { showToast("Project name: letters, numbers, - and _ only", "err"); return; }
  if (ref.length < 16) { showToast("Supabase project ref should be at least 16 characters", "err"); return; }

  const btn = document.getElementById("create-btn");
  btn.disabled = true;
  btn.textContent = "Creating…";

  try {
    await putProject({ id: Date.now(), name, ref, status: "idle", createdAt: new Date().toISOString() });
    document.getElementById("proj-name").value = "";
    document.getElementById("proj-ref").value = "";
    showToast(`✅ Project "${name}" created`, "ok");
    await renderProjectList();
  } catch (err) {
    showToast(`Failed to create project: ${err.message}`, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "+ Create Project";
  }
}

async function removeProject(id) {
  if (!confirm("Delete this project? This only removes the local record.")) return;
  try {
    const db = await openDB();
    await idbRequest(db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).delete(id));
    showToast("Project removed", "info");
    await renderProjectList();
  } catch (err) {
    showToast(`Error: ${err.message}`, "err");
  }
}

// ─── IndexedDB Helpers ────────────────────────────────────────────────────────

async function getAllProjects() {
  const db = await openDB();
  return idbRequest(db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll());
}

async function putProject(project) {
  const db = await openDB();
  return idbRequest(db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(project));
}

function idbRequest(req) {
  return new Promise((res, rej) => {
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = (e) => rej(e.target.error);
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _statusClass(status) {
  const map = { installed: "installed", installing: "pending", failed: "fail", idle: "idle", healed: "ok" };
  return map[status] || "unknown";
}

function _fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return iso; }
}
