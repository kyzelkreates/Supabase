/**
 * projectNormalizer.js — Unified Project Model Builder (RUN 7.3)
 *
 * Merges inputs from any source (ZIP, GitHub, Firebase) into a single
 * UnifiedProjectModel that the AI schema compiler can consume.
 *
 * The Unified Project Model is the SINGLE data structure passed to
 * schemaCompilerAI.js — it hides all source-specific shapes.
 *
 * SSOT Rules:
 * ✔ ALL schema compilation flows through this normalizer first
 * ✔ Source-specific parsers (zipIngestor, githubFetcher, firebaseParser)
 *   produce NormalizedSource objects — this module merges them
 * ✔ Writes the active model to ssot/unifiedProjectModel.json
 * ✔ Returns UnifiedProjectModel — schemaCompilerAI.js is the sole consumer
 * ❌ Never calls AI modules
 * ❌ Never calls adapters (supabaseAdapter, firebaseAdapter)
 */

import fs   from "fs";
import path from "path";

const MODEL_PATH = path.resolve("./ssot/unifiedProjectModel.json");

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Build a UnifiedProjectModel from one or more NormalizedSources.
 *
 * @param {NormalizeRequest} request
 * @returns {UnifiedProjectModel}
 *
 * @typedef {object} NormalizeRequest
 * @property {NormalizedSource[]} sources       - One or more source objects
 * @property {string}             projectName
 * @property {string[]}           [targetBackends]  - ["supabase","firebase"]
 *
 * @typedef {object} UnifiedProjectModel
 * @property {string}   schemaVersion
 * @property {string}   projectId
 * @property {string}   projectName
 * @property {string[]} sourceTypes
 * @property {string}   primarySourceType
 * @property {string}   projectType
 * @property {string[]} detectedORM
 * @property {ModelEntity[]} entities
 * @property {ModelRelation[]} relations
 * @property {ModelEnum[]} enums
 * @property {ModelIndex[]} indexes
 * @property {object}   authModel
 * @property {ContextFile[]} contextFiles
 * @property {string[]} targetBackends
 * @property {string}   compilationStatus
 * @property {string}   createdAt
 *
 * @typedef {object} ModelEntity
 * @property {string}   name
 * @property {string}   sourceHint   - "firebase_collection"|"schema_file"|"inferred"|"orm"
 * @property {string[]} inferredFields
 * @property {boolean}  hasSubEntities
 *
 * @typedef {object} ModelRelation
 * @property {string} from
 * @property {string} to
 * @property {string} type   - "one_to_many"|"many_to_many"|"one_to_one"
 * @property {string} [via]  - Join table name if many_to_many
 */
export function normalizeProject(request) {
  const { sources, projectName, targetBackends = ["supabase"] } = request;
  if (!sources?.length) throw new Error("normalizeProject: at least one source is required");

  const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // Merge entities from all sources (deduplicated by name)
  const entityMap  = new Map();
  const allFiles   = [];
  const allORM     = new Set();
  const sourceTypes = [];
  let   primaryType = sources[0]?.sourceType || "unknown";

  for (const source of sources) {
    if (source.sourceType) sourceTypes.push(source.sourceType);
    if (source.detectedORM) source.detectedORM.forEach((o) => allORM.add(o));
    if (source.files)       allFiles.push(...source.files);

    // From Firebase collections
    if (source.collections) {
      for (const col of source.collections) {
        _mergeEntity(entityMap, col.name, col.inferredFields || [], "firebase_collection", col.hasSubcollections);
      }
    }

    // From schema files (prisma, sql, dbml)
    if (source.schemaFiles) {
      for (const sf of source.schemaFiles) {
        const name = path.basename(sf, path.extname(sf)).replace(/[^a-zA-Z0-9_]/g, "");
        _mergeEntity(entityMap, name, [], "schema_file", false);
      }
    }

    // Infer from signal files and top-level dirs
    if (source.signalFiles) {
      for (const sig of source.signalFiles) {
        const name = path.basename(sig, path.extname(sig)).toLowerCase().replace(/[^a-z_]/g, "");
        if (name.length > 2) _mergeEntity(entityMap, name, [], "inferred", false);
      }
    }
  }

  // Infer entities from ORM-detected code
  if (allORM.has("prisma")) {
    _extractPrismaEntities(allFiles, entityMap);
  }

  // Remove generic/noise names
  const NOISE = new Set(["index", "schema", "migration", "seed", "test", "spec", "type", "types", "util", "utils", "helper", "helpers", "config", "constants"]);
  for (const key of entityMap.keys()) {
    if (NOISE.has(key.toLowerCase())) entityMap.delete(key);
  }

  // Infer relations from entity names (simple heuristic)
  const relations = _inferRelations([...entityMap.keys()]);

  // Deduplicate context files (by file path)
  const seenFiles = new Set();
  const dedupedFiles = allFiles.filter((f) => {
    if (seenFiles.has(f.file)) return false;
    seenFiles.add(f.file);
    return true;
  }).slice(0, 60); // Cap context at 60 files

  const model = {
    schemaVersion:    "1.0",
    projectId,
    projectName,
    sourceTypes:      [...new Set(sourceTypes)],
    primarySourceType: primaryType,
    projectType:      sources[0]?.projectType || "unknown",
    detectedORM:      [...allORM],
    entities:         [...entityMap.values()],
    relations,
    enums:            [],
    indexes:          [],
    authModel:        _inferAuthModel(sources),
    contextFiles:     dedupedFiles,
    targetBackends,
    compilationStatus: "pending",
    createdAt:        new Date().toISOString()
  };

  // Persist to SSOT
  try {
    fs.writeFileSync(MODEL_PATH, JSON.stringify({ ...model, contextFiles: `[${dedupedFiles.length} files — omitted from SSOT for size]` }, null, 2), "utf-8");
  } catch (err) {
    console.warn("[projectNormalizer] Could not write unifiedProjectModel.json:", err.message);
  }

  console.log(`[projectNormalizer] Built unified model: ${model.entities.length} entities, ${model.relations.length} relations, ${dedupedFiles.length} context files`);
  return model;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _mergeEntity(map, name, fields, sourceHint, hasSubEntities) {
  if (!name || name.length < 2) return;
  const key = name.toLowerCase();
  if (map.has(key)) {
    const existing = map.get(key);
    const merged = new Set([...existing.inferredFields, ...fields]);
    existing.inferredFields = [...merged];
    if (hasSubEntities) existing.hasSubEntities = true;
  } else {
    map.set(key, { name: key, sourceHint, inferredFields: [...new Set(fields)], hasSubEntities: !!hasSubEntities });
  }
}

function _extractPrismaEntities(files, entityMap) {
  for (const f of files) {
    if (!f.file?.endsWith(".prisma")) continue;
    const modelRegex = /model\s+(\w+)\s*\{([^}]+)\}/g;
    let m;
    while ((m = modelRegex.exec(f.content || "")) !== null) {
      const modelName = m[1].toLowerCase();
      const body = m[2];
      const fields = [];
      for (const line of body.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && !parts[0].startsWith("@@") && !parts[0].startsWith("//")) {
          fields.push(parts[0]);
        }
      }
      _mergeEntity(entityMap, modelName, fields, "orm", false);
    }
  }
}

function _inferRelations(entityNames) {
  const relations = [];
  // Simple: if entity A name is in entity B's name + "s", infer one-to-many
  // e.g. "user" + "posts" → user has_many posts
  for (let i = 0; i < entityNames.length; i++) {
    for (let j = 0; j < entityNames.length; j++) {
      if (i === j) continue;
      const a = entityNames[i], b = entityNames[j];
      // Common join patterns: user_posts, post_tags, etc.
      if (b.includes(`${a}_`) || b.includes(`_${a}`)) {
        relations.push({ from: a, to: b, type: "many_to_many", via: b });
      }
    }
  }
  return relations.slice(0, 20); // Cap
}

function _inferAuthModel(sources) {
  for (const source of sources) {
    if (source.collections?.some((c) => c.name === "users" || c.name === "user_profiles")) {
      return { type: "firebase_auth", hasUserProfile: true };
    }
    if (source.detectedORM?.includes("supabase-js")) {
      return { type: "supabase_auth", hasUserProfile: false };
    }
  }
  return { type: "supabase_auth", hasUserProfile: false };
}
