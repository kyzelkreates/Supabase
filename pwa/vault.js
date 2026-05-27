/**
 * vault.js — IndexedDB Open + Schema (RUN 0, patched RUN 7.5+)
 *
 * PATCH v2: Added secure_store object store for RUN 6 encrypted vault.
 * Version bumped 1 → 2 so onupgradeneeded fires on existing browsers.
 * All existing stores preserved — no data lost.
 */

const DB_NAME    = "AI_VAULT_OS";
const DB_VERSION = 2;

export function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db      = e.target.result;
      const oldVer  = e.oldVersion;

      // v1 stores — create if missing (fresh install or upgrade from 0)
      if (!db.objectStoreNames.contains("projects"))
        db.createObjectStore("projects",  { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings"))
        db.createObjectStore("settings",  { keyPath: "id" });
      if (!db.objectStoreNames.contains("ai_keys"))
        db.createObjectStore("ai_keys",   { keyPath: "id" });
      if (!db.objectStoreNames.contains("logs"))
        db.createObjectStore("logs",      { keyPath: "id" });

      // v2 — secure_store for AES-GCM encrypted values (RUN 6)
      if (oldVer < 2 && !db.objectStoreNames.contains("secure_store"))
        db.createObjectStore("secure_store", { keyPath: "key" });
    };

    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror   = (e) => reject(e.target.error);
    request.onblocked = ()  => {
      // Another tab has an old version open — prompt user
      console.warn("[vault] DB upgrade blocked — close other tabs of this app and reload");
    };
  });
}
