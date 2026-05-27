/**
 * setupBridge.js — Setup API Bridge (RUN 7.5)
 *
 * Typed wrapper around apiBridge for all setup-related agent calls.
 * Two modes:
 *   - JSON mode:   single request/response (simpler)
 *   - Stream mode: SSE EventSource for live log lines (default for UI)
 *
 * SSOT Rules:
 * ✔ All agent calls go through apiBridge.sendToAgent / getFromAgent
 * ✔ SSE is the PWA's only direct fetch (EventSource doesn't go via apiBridge)
 * ✔ Never calls shell commands
 * ✔ Returns typed results to setupAIButton / setupStatusPanel
 */

import { getFromAgent, sendToAgent, getAgentURL } from "../apiBridge.js";

// ─── Quick Check (no install) ─────────────────────────────────────────────────

/**
 * @returns {Promise<{ok, binaryFound, serverRunning, pulledModels, status, os}>}
 */
export async function checkSetupStatus() {
  const res = await sendToAgent("setup-check", {});
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, ...res.data };
}

/**
 * Read the persisted setup state from ssot/systemSetupState.json (via agent).
 */
export async function getPersistedSetupState() {
  const res = await getFromAgent("setup-status");
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, state: res.data?.state || {} };
}

// ─── Full Setup — JSON Mode ───────────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {string} [opts.model="llama3"]
 * @returns {Promise<SetupResult>}
 */
export async function triggerSetup(opts = {}) {
  const res = await sendToAgent("setup-ai", { model: opts.model || "llama3", skipPull: opts.skipPull || false }, { timeout: 700_000 });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: res.data?.ok, ...res.data };
}

// ─── Full Setup — SSE Streaming Mode ─────────────────────────────────────────

/**
 * Trigger setup and receive live log lines via SSE.
 *
 * @param {object}   opts
 * @param {string}   [opts.model="llama3"]
 * @param {function} opts.onLog      - (message: string) => void
 * @param {function} opts.onComplete - (SetupResult) => void
 * @param {function} [opts.onError]  - (message: string) => void
 * @returns {{ cancel: function }}  - Call cancel() to close the stream
 */
export function triggerSetupStream(opts) {
  const { model = "llama3", onLog, onComplete, onError } = opts;
  const url = `${getAgentURL()}/setup-ai?stream=1`;

  // EventSource only supports GET — use fetch with ReadableStream for POST SSE
  const controller = new AbortController();

  fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ model, stream: true }),
    signal:  controller.signal
  }).then(async (res) => {
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      if (onError) onError(`Agent HTTP ${res.status}: ${err.slice(0, 120)}`);
      return;
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";  // keep incomplete line

      let event = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) { event = line.slice(7).trim(); }
        else if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (event === "log"      && onLog)      onLog(data.message || "");
            if (event === "complete" && onComplete) onComplete({ ok: data.ok, ...data });
            if (event === "error"    && onError)    onError(data.message || "Unknown error");
          } catch { /* partial JSON */ }
          event = null;
        }
      }
    }
  }).catch((err) => {
    if (err.name !== "AbortError" && onError) onError(err.message);
  });

  return { cancel: () => controller.abort() };
}
