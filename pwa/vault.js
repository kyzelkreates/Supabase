const DB_NAME = "AI_VAULT_OS";

export function openDB() {
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;

      db.createObjectStore("projects", { keyPath: "id" });
      db.createObjectStore("settings", { keyPath: "id" });
      db.createObjectStore("ai_keys", { keyPath: "id" });
      db.createObjectStore("logs", { keyPath: "id" });
    };

    request.onsuccess = (e) => resolve(e.target.result);
  });
}
