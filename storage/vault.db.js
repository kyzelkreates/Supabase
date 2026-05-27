/**
 * vault.db.js
 * Project storage system — wraps IndexedDB via db.js for project-scoped operations.
 * RUN 0: Structure only. Extended in future runs.
 */

import { saveRecord, getRecord, getAllRecords, deleteRecord } from "../pwa/db.js";

const STORE = "projects";

export async function createProject(project) {
  if (!project.id) project.id = crypto.randomUUID();
  project.createdAt = new Date().toISOString();
  project.updatedAt = project.createdAt;
  await saveRecord(STORE, project);
  return project;
}

export async function getProject(id) {
  return getRecord(STORE, id);
}

export async function listProjects() {
  return getAllRecords(STORE);
}

export async function updateProject(id, updates) {
  const existing = await getRecord(STORE, id);
  if (!existing) throw new Error(`Project ${id} not found`);
  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  await saveRecord(STORE, updated);
  return updated;
}

export async function deleteProject(id) {
  return deleteRecord(STORE, id);
}
