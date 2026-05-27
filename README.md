# AI Vault OS — Supabase AI Backend Compiler

> Self-installing, offline-first AI backend compiler. One-click setup → multi-source ingestion → local AI schema generation → Supabase/Firebase deployment.

## What it does

Ingests your project from **GitHub, ZIP, or Firebase** → builds a **Unified Project Model** → runs it through **Ollama (local AI)** or cloud providers → outputs a **production-ready Supabase PostgreSQL migration** or **Firebase Firestore schema**.

## Architecture

```
SOURCE INPUT (GitHub / ZIP / Firebase)
   ↓
projectNormalizer → UnifiedProjectModel
   ↓
🧠 Ollama (primary) → Groq → OpenRouter → Together → HuggingFace (fallback)
   ↓
schemaCompilerAI
   ↓
supabaseAdapter (SQL) or firebaseAdapter (Firestore + Rules)
   ↓
Optional: deploy via Supabase CLI / Firebase Admin SDK
```

## Stack

| Layer      | Technology |
|------------|------------|
| PWA        | Vanilla JS, IndexedDB vault, SSE streaming |
| Agent      | Node.js / Express (local, port 4000) |
| AI         | Ollama (llama3), Groq, OpenRouter, Together, HuggingFace |
| Backend    | Supabase (PostgreSQL + RLS) / Firebase (Firestore + Rules) |
| Security   | AES-GCM encryption, PBKDF2 key derivation, vault lock screen |

## Quick Start

### 1. Start the local agent
```bash
cd agent
npm install
node agentRouter.js
```

### 2. Open the PWA
Open `pwa/index.html` in your browser (or deploy to Vercel — see below).

### 3. One-click AI setup
Click **🚀 Setup AI Environment** — the agent installs Ollama and pulls `llama3` automatically.

### 4. Ingest a project
Choose GitHub repo, ZIP upload, or Firebase export → click **Ingest + Analyse**.

### 5. Compile schema
Select Supabase or Firebase output → click **🧠 Compile Schema**.

## Deploy to Vercel

The `pwa/` directory is a static site — deploy it directly:

```bash
vercel --cwd pwa
```

The local agent must run on your machine (or a VPS) — it handles all AI and OS-level operations. Set `AGENT_URL` in your Vercel environment to point the PWA at your agent.

## Run Architecture (7 Runs)

| Run   | What was built |
|-------|----------------|
| 0     | Core SSOT structure + IndexedDB vault |
| 1     | AI provider registry + key vault + health |
| 2     | AI router + dispatcher + fallback chain |
| 3     | Supabase installer + migration engine |
| 4     | Auto-heal engine + error analyzer |
| 4.1   | Health gate + dependency validator |
| 5     | PWA control dashboard |
| 6     | AES-GCM encryption vault + lock screen |
| 7     | Orchestration engine + pipeline |
| 7.1   | Wiring validator + auto-repair |
| 7.2   | Runtime bridge + ZIP ingestion engine |
| 7.3   | Multi-source ingestion + AI schema compiler |
| 7.4   | AI Provider Control Dashboard |
| 7.5   | One-click Ollama installer + SSE streaming |

## License

MIT
