"""
routers/workflow.py - workflow showcase endpoint.

POST /repo/{repo_id}/workflow - build a graph animation payload from the stored
cluster tree. This is intentionally separate from RAG so demos can switch modes
without changing normal question answering behavior.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import get_repo
from backend.services.workflow import build_workflow_response

logger = logging.getLogger(__name__)
router = APIRouter()


class WorkflowRequest(BaseModel):
    question: str
    domain_id: str | None = None


class WorkflowSourceItem(BaseModel):
    chunk_id: str
    file_path: str
    domain_id: str | None
    score: float
    summary: str


class InternalFlow(BaseModel):
    node_label: str
    steps: list[str]


class WorkflowFlow(BaseModel):
    navigate_to_submap: str | None = None
    zoom_to_node: str | None = None
    paths: list[list[str]]
    internal_flow: InternalFlow | None = None
    loop: bool = False
    step_duration_ms: int = 1000


class WorkflowResponse(BaseModel):
    type: str = "workflow_animation"
    answer: str
    confidence: str
    sources: list[WorkflowSourceItem]
    flow: WorkflowFlow


@router.post("/repo/{repo_id}/workflow", response_model=WorkflowResponse)
async def workflow_repo_endpoint(repo_id: str, body: WorkflowRequest):
    repo_id = repo_id.strip('"')
    if not body.question.strip():
        raise HTTPException(status_code=422, detail="question cannot be empty")

    repo = get_repo(repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repo not found")
    if repo["status"] != "ready":
        raise HTTPException(status_code=409, detail=f"repo is not ready - current status: {repo['status']}")

    logger.info("workflow repo=%s domain=%s question=%s", repo_id, body.domain_id, body.question[:80])
    result = build_workflow_response(
        question=body.question,
        repo=repo,
        domain_id=body.domain_id,
    )
    return WorkflowResponse(**result)
