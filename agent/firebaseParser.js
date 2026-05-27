/**
 * firebaseParser.js — Firebase Export Parser (RUN 7.3)
 *
 * Parses Firebase project exports and live Firebase config into a
 * NormalizedSource for projectNormalizer.js.
 *
 * Supports three input shapes:
 *   1. Firestore export JSON (from `firebase firestore:export`)
 *   2. firestore.rules source text
 *   3. firebase.json + firestore.rules + firestore.indexes.json (project dir)
 *
 * SSOT Rules:
 * ✔ Returns NormalizedSource — normalizer owns the merge
 * ✔ Pure parsing — no AI calls, no network calls
 * ✔ Never writes files
 * ❌ Never calls Supabase or Firebase Admin SDK (installer owns that)
 */

import fs   from "fs";
import path from "path";

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Parse a Firebase export directory or export JSON file.
 *
 * @param {string} inputPath - Path to firebase.json, export dir, or rules file
 * @returns {FirebaseParseResult}
 *
 * @typedef {object} FirebaseParseResult
 * @property {boolean}         ok
 * @property {string}          sourceType   - "firestore_export"|"firebase_project"|"rules_only"
 * @property {ParsedCollection[]} collections
 * @property {ParsedRule[]}    rules
 * @property {ParsedIndex[]}   indexes
 * @property {object}          [projectConfig]
 * @property {string}          [error]
 *
 * @typedef {object} ParsedCollection
 * @property {string}   name
 * @property {string[]} inferredFields
 * @property {boolean}  hasSubcollections
 *
 * @typedef {object} ParsedRule
 * @property {string} path
 * @property {string} read
 * @property {string} write
 *
 * @typedef {object} ParsedIndex
 * @property {string}   collectionGroup
 * @property {object[]} fields
 */
export function parseFirebaseExport(inputPath) {
  if (!fs.existsSync(inputPath)) {
    return { ok: false, error: `Path not found: ${inputPath}`, collections: [], rules: [], indexes: [] };
  }

  const stat = fs.statSync(inputPath);

  try {
    if (stat.isDirectory()) {
      return _parseProjectDir(inputPath);
    } else {
      const ext = path.extname(inputPath).toLowerCase();
      if (ext === ".json") return _parseExportJSON(inputPath);
      if (ext === ".rules") return _parseRulesFile(inputPath);
      return { ok: false, error: `Unsupported file type: ${ext}`, collections: [], rules: [], indexes: [] };
    }
  } catch (err) {
    return { ok: false, error: `Firebase parse error: ${err.message}`, collections: [], rules: [], indexes: [] };
  }
}

// ─── Project Directory Parser ─────────────────────────────────────────────────

function _parseProjectDir(dir) {
  const result = {
    ok:            true,
    sourceType:    "firebase_project",
    collections:   [],
    rules:         [],
    indexes:       [],
    projectConfig: null
  };

  // firebase.json
  const fbConfigPath = path.join(dir, "firebase.json");
  if (fs.existsSync(fbConfigPath)) {
    try { result.projectConfig = JSON.parse(fs.readFileSync(fbConfigPath, "utf-8")); } catch {}
  }

  // firestore.rules
  const rulesPath = path.join(dir, "firestore.rules");
  if (fs.existsSync(rulesPath)) {
    result.rules = _parseRulesText(fs.readFileSync(rulesPath, "utf-8"));
  }

  // firestore.indexes.json
  const indexesPath = path.join(dir, "firestore.indexes.json");
  if (fs.existsSync(indexesPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(indexesPath, "utf-8"));
      result.indexes = _parseIndexes(raw);
    } catch {}
  }

  // Look for Firestore export data
  const exportDirs = ["firestore_export", "exports", "data"].map((d) => path.join(dir, d));
  for (const expDir of exportDirs) {
    if (fs.existsSync(expDir)) {
      const exportResult = _parseExportDir(expDir);
      result.collections.push(...exportResult.collections);
      break;
    }
  }

  // Try to infer collections from rules if no export data
  if (result.collections.length === 0 && result.rules.length > 0) {
    result.collections = _inferCollectionsFromRules(result.rules);
  }

  return result;
}

// ─── Firestore Export JSON ────────────────────────────────────────────────────

function _parseExportJSON(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return {
    ok:          true,
    sourceType:  "firestore_export",
    collections: _extractCollectionsFromExport(raw),
    rules:       [],
    indexes:     []
  };
}

function _parseExportDir(exportDir) {
  const collections = [];
  try {
    // Look for .export_metadata or document files
    const entries = fs.readdirSync(exportDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        collections.push({
          name:               entry.name,
          inferredFields:     _scanCollectionDir(path.join(exportDir, entry.name)),
          hasSubcollections:  _hasSubdirs(path.join(exportDir, entry.name))
        });
      }
    }
  } catch {}
  return { collections };
}

function _extractCollectionsFromExport(data) {
  const collections = [];
  // Firebase export format: { kind: "datastore#export", entityResults: [...] }
  // or flat: { [collectionId]: { documents: [...] } }
  if (data.entityResults) {
    const seen = new Map();
    for (const entity of data.entityResults) {
      const key  = entity.entity?.key?.path?.[0];
      if (!key) continue;
      const name = key.kind || key.name || "unknown";
      if (!seen.has(name)) seen.set(name, new Set());
      const fields = Object.keys(entity.entity?.properties || {});
      fields.forEach((f) => seen.get(name).add(f));
    }
    for (const [name, fieldSet] of seen.entries()) {
      collections.push({ name, inferredFields: [...fieldSet], hasSubcollections: false });
    }
  } else {
    for (const [name, value] of Object.entries(data)) {
      if (typeof value === "object" && value !== null) {
        const docs = value.documents || [];
        const fields = new Set();
        docs.forEach((d) => Object.keys(d.fields || {}).forEach((f) => fields.add(f)));
        collections.push({ name, inferredFields: [...fields], hasSubcollections: false });
      }
    }
  }
  return collections;
}

// ─── Rules Parser ─────────────────────────────────────────────────────────────

function _parseRulesFile(filePath) {
  const text = fs.readFileSync(filePath, "utf-8");
  return {
    ok:          true,
    sourceType:  "rules_only",
    collections: _inferCollectionsFromRules(_parseRulesText(text)),
    rules:       _parseRulesText(text),
    indexes:     []
  };
}

function _parseRulesText(text) {
  const rules = [];
  // Match: match /collectionName/{docId} { allow read: if ...; allow write: if ...; }
  const matchRegex = /match\s+(\/[^\s{]+)\s*\{([^}]+)\}/g;
  let m;
  while ((m = matchRegex.exec(text)) !== null) {
    const rulePath = m[1];
    const body     = m[2];
    const readMatch  = body.match(/allow\s+read\s*:\s*if\s+([^;]+)/);
    const writeMatch = body.match(/allow\s+write\s*:\s*if\s+([^;]+)/);
    rules.push({
      path:  rulePath,
      read:  readMatch?.[1]?.trim() || "false",
      write: writeMatch?.[1]?.trim() || "false"
    });
  }
  return rules;
}

function _inferCollectionsFromRules(rules) {
  const collections = [];
  const seen = new Set();
  for (const rule of rules) {
    // Extract top-level collection from path like /users/{userId} or /users/{userId}/posts/{postId}
    const segments = rule.path.split("/").filter(Boolean);
    if (segments.length > 0 && !segments[0].startsWith("{")) {
      const name = segments[0];
      if (!seen.has(name)) {
        seen.add(name);
        collections.push({ name, inferredFields: [], hasSubcollections: segments.length > 2 });
      }
    }
  }
  return collections;
}

// ─── Indexes ──────────────────────────────────────────────────────────────────

function _parseIndexes(raw) {
  return (raw.indexes || []).map((idx) => ({
    collectionGroup: idx.collectionGroup,
    fields:          idx.fields || []
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _scanCollectionDir(dir) {
  const fields = new Set();
  try {
    const files = fs.readdirSync(dir).slice(0, 20); // Sample first 20 docs
    for (const f of files) {
      const fp = path.join(dir, f);
      if (!fs.statSync(fp).isFile()) continue;
      try {
        const doc = JSON.parse(fs.readFileSync(fp, "utf-8"));
        Object.keys(doc.fields || doc || {}).forEach((k) => fields.add(k));
      } catch {}
    }
  } catch {}
  return [...fields];
}

function _hasSubdirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory()); }
  catch { return false; }
}
