/**
 * firebaseAdapter.js — Firebase Output Adapter (RUN 7.3)
 *
 * Saves or deploys compiled Firebase schema + rules.
 * Writes firestore.rules and schema.json to the project output directory.
 * Optional deploy via Firebase Admin SDK REST API (no CLI required).
 *
 * SSOT Rules:
 * ✔ Writes output to agent/projects/<projectId>/firebase-output/ only
 * ✔ Deploy uses Firebase Management REST API (no CLI)
 * ✔ Returns AdapterResult — never throws to caller
 * ✔ "deploy" mode requires explicit trigger + FIREBASE_TOKEN env var
 * ❌ Never mixes Supabase and Firebase output formats
 */

import fs   from "fs";
import path from "path";

const OUTPUT_BASE = path.resolve("./agent/projects");

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * @param {FirebaseAdapterRequest} request
 * @returns {Promise<AdapterResult>}
 *
 * @typedef {object} FirebaseAdapterRequest
 * @property {string} content          - JSON string from schemaCompilerAI (firebase output)
 * @property {string} projectName
 * @property {string} [projectId]      - Firebase project ID (required for deploy)
 * @property {"save"|"deploy"} [mode]
 */
export async function runFirebaseAdapter(request) {
  const { content, projectName, projectId, mode = "save" } = request;

  if (!content)     return { ok: false, mode, error: "No Firebase schema content provided" };
  if (!projectName) return { ok: false, mode, error: "projectName required" };

  const outputDir = path.join(OUTPUT_BASE, projectName, "firebase-output");
  try { fs.mkdirSync(outputDir, { recursive: true }); } catch {}

  try {
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = { schema: content, rules: "" }; }

    const schemaPath = path.join(outputDir, "firestore-schema.json");
    const rulesPath  = path.join(outputDir, "firestore.rules");

    // Write schema
    fs.writeFileSync(schemaPath, typeof parsed.schema === "string" ? parsed.schema : JSON.stringify(parsed.schema, null, 2), "utf-8");

    // Write rules
    const rules = parsed.rules || _generateDefaultRules();
    fs.writeFileSync(rulesPath, rules, "utf-8");

    console.log(`[firebaseAdapter] Saved Firebase output to ${outputDir}`);

    if (mode === "save") {
      return { ok: true, mode: "save", schemaFile: schemaPath, rulesFile: rulesPath };
    }

    // Deploy mode — requires Firebase project ID + token
    if (!projectId) return { ok: false, mode, error: "Firebase projectId required for deploy mode" };
    const deployResult = await _deployRules(projectId, rules);

    return {
      ok:        deployResult.ok,
      mode:      "deploy",
      schemaFile: schemaPath,
      rulesFile:  rulesPath,
      error:     deployResult.error
    };

  } catch (err) {
    return { ok: false, mode, error: err.message };
  }
}

// ─── Firebase Rules Deploy (REST API) ────────────────────────────────────────

async function _deployRules(fbProjectId, rulesContent) {
  const token = process.env.FIREBASE_TOKEN;
  if (!token) return { ok: false, error: "FIREBASE_TOKEN not set — add it to agent .env" };

  try {
    // Create a new ruleset via Firebase Rules REST API
    const createRes = await fetch(
      `https://firebaserules.googleapis.com/v1/projects/${fbProjectId}/rulesets`,
      {
        method:  "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source: { files: [{ name: "firestore.rules", content: rulesContent }] } }),
        signal: AbortSignal.timeout(30_000)
      }
    );

    if (!createRes.ok) {
      const err = await createRes.text().catch(() => "");
      return { ok: false, error: `Firebase ruleset create failed: ${createRes.status} — ${err.slice(0, 200)}` };
    }

    const ruleset = await createRes.json();
    const rulesetName = ruleset.name;

    // Release the ruleset to the Firestore service
    const releaseRes = await fetch(
      `https://firebaserules.googleapis.com/v1/projects/${fbProjectId}/releases/cloud.firestore`,
      {
        method:  "PATCH",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: `projects/${fbProjectId}/releases/cloud.firestore`, rulesetName }),
        signal: AbortSignal.timeout(30_000)
      }
    );

    if (!releaseRes.ok) {
      return { ok: false, error: `Firebase ruleset release failed: ${releaseRes.status}` };
    }

    console.log(`[firebaseAdapter] Deployed rules to ${fbProjectId} (ruleset: ${rulesetName})`);
    return { ok: true, rulesetName };

  } catch (err) {
    return { ok: false, error: `Firebase deploy error: ${err.message}` };
  }
}

// ─── Default Rules Template ───────────────────────────────────────────────────

function _generateDefaultRules() {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Default: authenticated users only
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;
}
