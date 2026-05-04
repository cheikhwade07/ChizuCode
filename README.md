# ChizuCode

ChizuCode is a codebase exploration and teaching assistant. It turns a GitHub repository into an interactive architecture map, explains what each file does, shows how files connect, and lets users ask questions about the code with source-backed answers.

## The Problem

Understanding an unfamiliar codebase is slow. New contributors usually have to jump between folders, read files out of order, guess domain boundaries, and ask teammates for context before they can safely make changes.

This is especially hard when:

- The repository has many small files spread across folders.
- Important logic crosses frontend, backend, config, and auth layers.
- Documentation is missing, stale, or too high level.
- A learner needs to understand "how this system works" before reading implementation details.

## The Solution

ChizuCode ingests a repository once, builds a semantic map of the project, and gives users a visual way to learn the codebase.

It provides:

- A graph of high-level domains and file-level components.
- Plain-English summaries for files and clusters.
- Connections between related files.
- Scoped RAG questions over the repository.
- Workflow showcase mode that animates how a process moves through the graph.

Instead of searching file-by-file, users can start from the architecture view, drill into a submap, inspect file responsibilities, and ask targeted questions about the current area.

## How It Works

### 1. Repository Ingestion

The backend receives a GitHub URL and runs a one-time ingestion pipeline:

1. Clone the repository.
2. Walk supported source, config, and documentation files.
3. Split large files into chunks.
4. Generate summaries with Gemini.
5. Create semantic embeddings and code embeddings.
6. Cluster files into meaningful domains.
7. Persist chunks, vectors, domains, and the cluster tree in Postgres with pgvector.

Once a repository is ready, later loads are much faster because the graph and vectors are already stored in the database.

### 2. Graph Exploration

The frontend converts the backend cluster tree into an interactive graph. Users can move from a domain-level map into file-level submaps, inspect responsibilities, and follow edges between related files.

### 3. RAG Questions

Users can ask natural language questions about the repository. The backend embeds the question, retrieves relevant chunks using pgvector similarity search, and asks Gemini to synthesize an answer with sources.

Queries can be scoped to the current cluster so answers stay relevant to the area the user is viewing.

### 4. Workflow Showcase

Workflow mode uses a separate backend endpoint to return animation payloads. The graph can navigate to the right submap, focus on relevant files, expand internal components, and animate a process through the system.

## Impact

ChizuCode helps developers, students, and teams understand code faster.

It can reduce onboarding time by:

- Making project structure visible.
- Explaining file purpose before users read implementation.
- Showing relationships between modules.
- Providing source-backed answers instead of generic chatbot responses.
- Turning code review or mentorship into a guided visual walkthrough.

For hackathons, classrooms, open-source onboarding, and internal teams, ChizuCode acts like a teaching assistant for any repository.

## Tech Stack

### Frontend

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- react-force-graph-2d
- Framer Motion
- Lucide React

### Backend

- FastAPI
- Python
- PostgreSQL
- pgvector
- psycopg2
- Gemini API
- Voyage AI embeddings
- scikit-learn clustering

### Deployment

- Frontend: Vercel
- Backend: DigitalOcean App Platform
- Database: Neon Postgres with pgvector

## Backend Architecture

Main backend modules:

- `backend/main.py` - FastAPI application and router registration.
- `backend/routers/ingest.py` - repository ingestion endpoints.
- `backend/routers/query.py` - RAG question endpoint.
- `backend/routers/workflow.py` - workflow animation endpoint.
- `backend/services/pipeline.py` - ingestion orchestrator.
- `backend/services/embedder.py` - summaries and embeddings.
- `backend/services/clusterer.py` - hierarchical clustering and labeling.
- `backend/services/rag.py` - retrieval and answer synthesis.
- `backend/services/workflow.py` - deterministic workflow animation payloads.
- `backend/db/database.py` - database schema and queries.

Core API endpoints:

```text
GET  /health
POST /repo
GET  /repo/{repo_id}
GET  /repo/{repo_id}/graph
POST /repo/{repo_id}/query
POST /repo/{repo_id}/workflow
```

## Local Setup

Install frontend dependencies:

```bash
npm install
```

Install backend dependencies:

```bash
pip install -r backend/requirements.txt
```

Create a local Postgres database and schema:

```powershell
.\.venv\Scripts\python.exe backend/db/init_local_db.py --database codex --user postgres --password "your_password"
```

Set local backend environment variables:

```powershell
$env:DATABASE_URL="postgresql://postgres:your_password@localhost:5432/codex"
$env:GEMINI_API_KEY="your_gemini_key"
$env:VOYAGE_API_KEY="your_voyage_key"
```

Set local frontend environment in `.env.local`:

```text
NEXT_PUBLIC_API_URL=http://127.0.0.1:8000
```

Run the backend:

```bash
uvicorn backend.main:app --reload
```

Run the frontend:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Production Environment Variables

### Vercel Frontend

```text
NEXT_PUBLIC_API_URL=https://your-digitalocean-backend-url
```

### DigitalOcean Backend

```text
DATABASE_URL=postgresql://USER:PASSWORD@NEON_HOST/neondb?sslmode=require
GEMINI_API_KEY=your_gemini_key
VOYAGE_API_KEY=your_voyage_key
```

Optional Gemini key rotation for faster ingestion:

```text
GEMINI_API_KEY_1=...
GEMINI_API_KEY_2=...
GEMINI_API_KEY_3=...
```

Optional ingestion tuning:

```text
INGEST_BATCH_SIZE=40
GEMINI_GENERATE_TIMEOUT_SECONDS=45
GEMINI_EMBED_TIMEOUT_SECONDS=45
VOYAGE_EMBED_TIMEOUT_SECONDS=45
```

## Deployment Notes

The backend includes a Dockerfile at:

```text
backend/Dockerfile
```

For DigitalOcean App Platform:

```text
Source directory: backend
Dockerfile path: Dockerfile
HTTP port: 8080
Run command: uvicorn backend.main:app --host 0.0.0.0 --port 8080
```

Initialize the production database schema once:

```powershell
.\.venv\Scripts\python.exe backend/db/init_db.py
```

Use `--reset` only when intentionally wiping app tables.

## Status

ChizuCode currently supports repository ingestion, graph generation, scoped RAG answers, and workflow animation payloads. The system is designed for fast demos once a repo has already been ingested and cached in the database.
