/**
 * utils.js — Shared browser utilities (no imports, no deps)
 * All panels import from here instead of dashboard.js to avoid circular deps.
 */

export function showToast(msg, type = "info") {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = `show-${type}`;
  clearTimeout(t._tmr);
  t._tmr = setTimeout(() => { t.className = ""; }, 3200);
}

export function esc(str) {
  return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

export function ts() {
  return new Date().toLocaleTimeString();
}

export function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return iso; }
}
