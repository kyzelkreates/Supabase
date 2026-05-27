/**
 * preflight-check.js — PWA Preflight Gate (RUN 4.1, patched RUN 7.5+)
 *
 * PATCH: Removed dynamic import of server/runGateController.js which
 * fails in browser context. Static Vercel deploys now always get OPEN
 * gate with a warning that the agent is offline — panels load freely.
 *
 * Gate logic:
 *   1. Try to reach the local agent /status endpoint
 *   2. If agent reachable → use its health data for gate status
 *   3. If agent offline → return WARN (not CLOSED) so panels still load
 *   4. Vault check always runs client-side
 */

import { getAIKeys } from "./ai-vault.js";
import { checkAgentStatus } from "./apiBridge.js";

// ─── Main Preflight ───────────────────────────────────────────────────────────

export async function preflight() {
  // 1. Vault check (client-side, always available)
  let vaultOk = false;
  try {
    const keys = await getAIKeys();
    vaultOk = keys !== null && keys !== undefined;
  } catch { vaultOk = false; }

  // 2. Agent reachability check
  let agentStatus = { reachable: false, error: "Not checked" };
  try {
    agentStatus = await checkAgentStatus(true);
  } catch { /* agent offline — non-fatal */ }

  // 3. Build gate result
  //    - Agent offline = WARN (not CLOSED) — static PWA works without agent
  //    - Agent online  = OPEN or WARN based on its health
  const agentOnline = agentStatus.reachable;

  const checks = {
    vault:          vaultOk      ? "OK"      : "WARN",
    agent:          agentOnline  ? "OK"      : "OFFLINE",
    pipeline:       agentStatus.pipelineStatus || (agentOnline ? "unknown" : "offline"),
    wiring:         agentStatus.wiringStatus   || (agentOnline ? "unknown" : "offline"),
  };

  const warnings      = [];
  const blockingIssues = [];

  if (!agentOnline) {
    warnings.push("Local agent offline — AI execution, setup, and install panels require the agent running on port 4000");
  }
  if (!vaultOk) {
    warnings.push("AI key vault is empty — add API keys in Settings to use cloud providers");
  }
  if (agentOnline && agentStatus.pipelineStatus === "ERROR") {
    blockingIssues.push("Agent pipeline in error state — check agent logs");
  }
  if (agentOnline && agentStatus.wiringStatus === "INVALID") {
    blockingIssues.push("Agent wiring invalid — restart agent");
  }

  // Never fully close the gate on a static deploy — panels degrade gracefully
  const gate = blockingIssues.length > 0 ? "WARN"
             : warnings.length > 0       ? "WARN"
             : "OPEN";

  return {
    systemReady:    gate !== "CLOSED",
    blockRun5:      false,   // Never block panels on static deploy
    gate,
    status:         gate === "OPEN" ? "READY" : "DEGRADED",
    blockingIssues,
    warnings,
    checks,
    agentOnline,
    source:         agentOnline ? "agent" : "static",
    lastCheck:      new Date().toISOString()
  };
}
