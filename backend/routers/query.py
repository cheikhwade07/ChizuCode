"""
routers/query.py — RAG query endpoint

POST /repo/{repo_id}/query — ask a question about a repo
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import get_repo
from backend.services.rag import query_repo

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class QueryRequest(BaseModel):
    question: str
    domain_id: str | None = None   # optional — scope to a specific cluster
    top_k: int = 5                 # how many chunks to use as context


class SourceItem(BaseModel):
    chunk_id: str
    file_path: str
    domain_id: str | None
    score: float
    summary: str


class QueryResponse(BaseModel):
    answer: str
    confidence: str                # high | medium | low
    sources: list[SourceItem]


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/repo/{repo_id}/query", response_model=QueryResponse)
async def query_repo_endpoint(repo_id: str, body: QueryRequest):
    """
    Ask a natural language question about an ingested repo.

    Optionally scope to a domain cluster via domain_id for more precise answers.
    Returns answer, confidence level, and source chunks with metadata
    for future graph highlighting.
    """
    if not body.question.strip():
        raise HTTPException(status_code=422, detail="question cannot be empty")

    # Verify repo exists and is ready
    repo = get_repo(repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repo not found")
    if repo["status"] != "ready":
        raise HTTPException(
            status_code=409,
            detail=f"repo is not ready — current status: {repo['status']}",
        )

    logger.info(
        "query repo=%s domain=%s question=%s",
        repo_id, body.domain_id, body.question[:80],
    )

    result = await query_repo(
        question=body.question,
        repo_id=repo_id,
        domain_id=body.domain_id,
        top_k=body.top_k,
    )

    return QueryResponse(**result)
