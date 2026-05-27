/**
 * sourceSelectorUI.js — Source Type Selector Widget (RUN 7.3)
 *
 * Renders the source type picker (ZIP / GitHub / Firebase / Local Folder)
 * and tracks the current selection.
 *
 * SSOT Rules:
 * ✔ Pure UI widget — no API calls, no state mutations
 * ✔ Calls onSelect callback on change
 */

let _selected = null;

const SOURCES = [
  { id: "zip",      icon: "📦", label: "ZIP Upload",    desc: "Upload a .zip of your project" },
  { id: "github",   icon: "🐙", label: "GitHub Repo",   desc: "Public or private repository" },
  { id: "firebase", icon: "🔥", label: "Firebase",      desc: "Firestore export or rules file" },
  { id: "local",    icon: "📁", label: "Local Folder",  desc: "Path on the agent server" }
];

export function renderSourceSelector(container, onSelect) {
  container.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0.5rem;" id="source-grid">
      ${SOURCES.map((s) => `
        <button
          class="source-btn"
          data-source="${s.id}"
          onclick="window.__srcSel.select('${s.id}')"
          style="
            background:var(--surface2);
            border:2px solid var(--border);
            border-radius:10px;
            padding:0.75rem 1rem;
            text-align:left;
            cursor:pointer;
            transition:border-color 0.15s,background 0.15s;
          ">
          <div style="font-size:1.35rem">${s.icon}</div>
          <div style="font-weight:600;color:var(--accent-lt);font-size:0.85rem;margin-top:0.2rem">${s.label}</div>
          <div style="font-size:0.72rem;color:#555;margin-top:0.1rem">${s.desc}</div>
        </button>
      `).join("")}
    </div>
  `;

  window.__srcSel = {
    select: (id) => {
      _selected = id;
      document.querySelectorAll(".source-btn").forEach((b) => {
        const active = b.dataset.source === id;
        b.style.borderColor = active ? "#a78bfa" : "var(--border)";
        b.style.background  = active ? "#2d1b69" : "var(--surface2)";
      });
      if (onSelect) onSelect(id);
    }
  };
}

export function getSelectedSource() { return _selected; }
