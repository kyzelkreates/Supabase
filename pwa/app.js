import { openDB } from "./vault.js";
import { saveRecord, getRecord } from "./db.js";

// Register service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then(() => {
    console.log("[SW] Registered");
  });
}

// Boot sequence
async function boot() {
  const statusEl = document.getElementById("status-msg");
  try {
    await openDB();
    statusEl.textContent = "✅ Vault DB ready. SSOT loaded.";

    // Seed default settings if not present
    const existing = await getRecord("settings", "system");
    if (!existing) {
      await saveRecord("settings", {
        id: "system",
        theme: "dark",
        aiEnabled: false,
        activeRun: 0
      });
    }
  } catch (err) {
    statusEl.textContent = "❌ Vault init failed: " + err.message;
    console.error(err);
  }
}

function goSettings() {
  window.location.href = "settings.html";
}

window.goSettings = goSettings;

boot();
