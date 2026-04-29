"""
backend/main.py — FastAPI application entry point.

Run from project root:
    uvicorn backend.main:app --reload

Endpoints:
    POST /repo                    — submit a GitHub URL for ingestion
    GET  /repo/{repo_id}          — poll ingestion status
    GET  /repo/{repo_id}/graph    — fetch the cluster tree
    POST /repo/{repo_id}/query    — ask a question about the repo
    GET  /health                  — health check
"""

from __future__ import annotations
# change this:
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers.ingest import router as ingest_router
from backend.routers.query import router as query_router

# to this:
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend.routers.ingest import router as ingest_router
from backend.routers.query import router as query_router
from backend.db.database import get_latest_ready_repo
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers.ingest import router as ingest_router
from backend.routers.query import router as query_router

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Codebase Explorer API",
    description="Ingest GitHub repos, build hierarchical maps, and answer natural language questions about code.",
    version="0.1.0",
)


# ---------------------------------------------------------------------------
# CORS — allow frontend to call API from a browser
# ---------------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # for hackathon — restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
@app.get("/repo/latest")
def latest_repo():
    repo = get_latest_ready_repo()
    if not repo:
        raise HTTPException(status_code=404, detail="No ready repo found")
    return {"repo_id": str(repo["id"]), "name": repo["name"]}

app.include_router(ingest_router, tags=["ingestion"])
app.include_router(query_router,  tags=["query"])


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health", tags=["health"])
async def health():
    return {"status": "ok"}


@app.get("/", tags=["health"])
async def root():
    return {
        "service": "Codebase Explorer API",
        "docs": "/docs",
        "endpoints": [
            "POST /repo",
            "GET /repo/{repo_id}",
            "GET /repo/{repo_id}/graph",
            "POST /repo/{repo_id}/query",
        ],
    }


# ---------------------------------------------------------------------------
# Startup log
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def on_startup():
    logger.info("Codebase Explorer API starting up")
    logger.info("Docs available at /docs")

