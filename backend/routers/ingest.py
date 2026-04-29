"""
routers/ingest.py — ingestion endpoints

POST /repo   — submit a GitHub URL, returns repo_id immediately, ingests in background
GET  /repo/{repo_id} — poll ingestion status
"""

from __future__ import annotations

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
# Background pipeline
# ---------------------------------------------------------------------------

async def _run_ingestion(repo_id: str, github_url: str) -> None:
    clone_path = None
    try:
        set_repo_status(repo_id, "ingesting")

        # 1. Clone
        logger.info("[%s] cloning %s", repo_id, github_url)
        clone_path = await asyncio.to_thread(clone_repo, github_url)

        # 2. Walk files
        logger.info("[%s] walking files", repo_id)
        files = await asyncio.to_thread(walk_files, clone_path)

        # 3. Chunk
        logger.info("[%s] chunking %d files", repo_id, len(files))
        chunks = await asyncio.to_thread(chunk_files, files)
        logger.info("[%s] produced %d chunks", repo_id, len(chunks))

        # 4. Summarize + embed (async, batched internally)
        logger.info("[%s] embedding chunks", repo_id)
        enriched = await process_chunks(chunks)

        # 5. Insert chunks → get back chunk UUIDs
        logger.info("[%s] inserting chunks into DB", repo_id)
        chunk_ids = await asyncio.to_thread(insert_chunks_batch, repo_id, enriched)

        # 6. Build vector rows and insert
        vector_rows = [
            {
                "chunk_id": chunk_id,
                "repo_id": repo_id,
                "summary_vector": chunk["summary_vector"],
                "code_vector": chunk["code_vector"],
            }
            for chunk_id, chunk in zip(chunk_ids, enriched)
        ]
        logger.info("[%s] inserting vectors into DB", repo_id)
        await asyncio.to_thread(insert_vectors_batch, vector_rows)

        # 7. Update chunk count and mark ready
        await asyncio.to_thread(update_repo_chunk_count, repo_id, len(enriched))
        set_repo_status(repo_id, "ready")
        logger.info("[%s] ingestion complete — %d chunks", repo_id, len(enriched))

    except Exception as e:
        logger.exception("[%s] ingestion failed: %s", repo_id, e)
        set_repo_status(repo_id, "failed", error=str(e))

    finally:
        if clone_path:
            await asyncio.to_thread(cleanup_repo, clone_path)
            logger.info("[%s] cleaned up clone dir", repo_id)


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
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    repo_id = create_repo(github_url, name)
    background_tasks.add_task(_run_ingestion, repo_id, github_url)

    return IngestResponse(repo_id=repo_id, status="ingesting")


@router.get("/repo/{repo_id}", response_model=dict)
async def get_repo_status(repo_id: str):
    """
    Poll ingestion status for a repo.
    Returns the full repo row: id, status, chunk_count, error, created_at, updated_at.
    """
    repo = await asyncio.to_thread(get_repo, repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repo not found")

    # psycopg2 RealDictRow may contain non-JSON-serialisable types (UUID, datetime)
    # convert to plain strings so FastAPI can serialise without extra config
    return {k: str(v) if v is not None else None for k, v in repo.items()}
