"""
routers/ingest.py — ingestion endpoints

POST /repo   — submit a GitHub URL, returns repo_id immediately, ingests in background
GET  /repo/{repo_id} — poll ingestion status
"""

from __future__ import annotations
from backend.services.pipeline import run_pipeline
from backend.services.github import RepoIngestionError
import asyncio
import logging
from pydantic import BaseModel, HttpUrl

from fastapi import APIRouter, BackgroundTasks, HTTPException

from backend.services.github import clone_repo, walk_files, cleanup_repo, parse_github_url
from backend.services.chunker import chunk_files
from backend.services.embedder import process_chunks
from backend.db.database import (
    create_repo,
    set_repo_status,
    insert_chunks_batch,
    insert_vectors_batch,
    update_repo_chunk_count,
    get_repo,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class IngestRequest(BaseModel):
    github_url: str


class IngestResponse(BaseModel):
    repo_id: str
    status: str



# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/repo", response_model=IngestResponse, status_code=202)
async def ingest_repo(body: IngestRequest, background_tasks: BackgroundTasks):
    """
    Submit a GitHub repo for ingestion.
    Returns immediately with repo_id and status='ingesting'.
    """
    github_url = str(body.github_url).rstrip("/")

    # parse_github_url raises ValueError if the URL is not a valid GitHub repo URL
    try:
        owner, repo_name = parse_github_url(github_url)
        name = f"{owner}/{repo_name}" # returns "owner/repo"

    except RepoIngestionError as e:
        raise HTTPException(status_code=422, detail=str(e))

    repo_id = create_repo(github_url, name)
    background_tasks.add_task(run_pipeline, repo_id, github_url)

    return IngestResponse(repo_id=repo_id, status="ingesting")


@router.get("/repo/{repo_id}", response_model=dict)
async def get_repo_status(repo_id: str):

    """
    Poll ingestion status for a repo.
    Returns the full repo row: id, status, chunk_count, error, created_at, updated_at.
    """
    repo_id = repo_id.strip('"')
    repo = await asyncio.to_thread(get_repo, repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repo not found")

    # psycopg2 RealDictRow may contain non-JSON-serialisable types (UUID, datetime)
    # convert to plain strings so FastAPI can serialise without extra config
    return {k: str(v) if v is not None else None for k, v in repo.items()}

@router.get("/repo/{repo_id}/graph")
async def get_repo_graph(repo_id: str):
    """
    Return the cluster tree JSON for a fully ingested repo.
    """
    repo_id = repo_id.strip('"')
    repo = await asyncio.to_thread(get_repo, repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repo not found")
    if repo["status"] != "ready":
        raise HTTPException(
            status_code=409,
            detail=f"repo is not ready — current status: {repo['status']}",
        )
    tree = repo.get("cluster_tree")
    if tree is None:
        raise HTTPException(status_code=404, detail="cluster tree not found — re-ingest the repo")
    return tree