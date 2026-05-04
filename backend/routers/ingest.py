"""
routers/ingest.py — ingestion endpoints

POST /repo   — submit a GitHub URL, returns repo_id immediately, ingests in background
GET  /repo/{repo_id} — poll ingestion status
"""

from __future__ import annotations
from backend.services.pipeline import run_pipeline
from backend.services.github import RepoIngestionError
import asyncio
from ipaddress import ip_address
import logging
from urllib.parse import urlparse
from pydantic import BaseModel

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from backend.db.database import (
    count_ingests_today,
    create_repo,
    get_repo,
    get_repo_by_github_url,
    has_recent_ingest_for_repo,
    log_ingest,
    reset_repo_for_reingest,
)
from backend.services.clusterer import (
    CLUSTER_TREE_SCHEMA_VERSION,
    MAX_CHILDREN_PER_CLUSTER,
    _validate_tree_limits,
)

logger = logging.getLogger(__name__)
router = APIRouter()
DAILY_INGEST_LIMIT = 3
LOCAL_DEV_IPS = {"127.0.0.1", "::1", "localhost"}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class IngestRequest(BaseModel):
    github_url: str


class IngestResponse(BaseModel):
    repo_id: str
    status: str


def _normalize_github_url(raw_url: str) -> tuple[str, str, str]:
    """
    Canonicalize GitHub repo URLs so cached ready repos are reused.
    Keeps owner/repo casing for display/clone safety while removing .git/trailing slash.
    """
    cleaned = raw_url.strip().rstrip("/")
    if "://" not in cleaned:
        cleaned = f"https://{cleaned}"

    parsed = urlparse(cleaned)
    if parsed.netloc.lower() not in {"github.com", "www.github.com"}:
        raise RepoIngestionError(f"Invalid GitHub URL: {raw_url}")

    parts = [part for part in parsed.path.strip("/").split("/") if part]
    if len(parts) < 2:
        raise RepoIngestionError(f"Invalid GitHub URL: {raw_url}")

    owner = parts[0]
    repo_name = parts[1].removesuffix(".git")
    return f"https://github.com/{owner}/{repo_name}", owner, repo_name


def _is_current_cluster_tree(tree: object) -> bool:
    if not isinstance(tree, dict):
        return False
    if tree.get("schema_version") != CLUSTER_TREE_SCHEMA_VERSION:
        return False
    if tree.get("max_children_per_cluster") != MAX_CHILDREN_PER_CLUSTER:
        return False
    return len(_validate_tree_limits(tree)) == 0


def _client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _is_local_dev_ip(ip: str) -> bool:
    if ip in LOCAL_DEV_IPS:
        return True
    try:
        return ip_address(ip).is_loopback
    except ValueError:
        return False


async def _quota_for_ip(ip: str) -> dict:
    if _is_local_dev_ip(ip):
        used = 0
    else:
        used = await asyncio.to_thread(count_ingests_today, ip)
    return {
        "limit": DAILY_INGEST_LIMIT,
        "used": used,
        "remaining": max(0, DAILY_INGEST_LIMIT - used),
        "resets_in_hours": 24,
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/repo/quota")
async def get_quota(request: Request):
    """
    Return the caller's rolling 24-hour ingestion quota.
    Must stay above /repo/{repo_id} so FastAPI does not treat "quota" as an ID.
    """
    return await _quota_for_ip(_client_ip(request))


@router.post("/repo", response_model=IngestResponse, status_code=202)
async def ingest_repo(body: IngestRequest, background_tasks: BackgroundTasks, request: Request):
    """
    Submit a GitHub repo for ingestion.
    Returns immediately with repo_id and status='ingesting'.
    """
    raw_github_url = str(body.github_url).strip()

    # parse_github_url raises ValueError if the URL is not a valid GitHub repo URL
    try:
        github_url, owner, repo_name = _normalize_github_url(raw_github_url)
        name = f"{owner}/{repo_name}" # returns "owner/repo"

    except RepoIngestionError as e:
        raise HTTPException(status_code=422, detail=str(e))

    client_ip = _client_ip(request)

    existing_repo = await asyncio.to_thread(get_repo_by_github_url, github_url)
    if existing_repo is None and raw_github_url.rstrip("/") != github_url:
        existing_repo = await asyncio.to_thread(get_repo_by_github_url, raw_github_url.rstrip("/"))

    if (
        existing_repo
        and existing_repo["status"] == "ready"
        and _is_current_cluster_tree(existing_repo.get("cluster_tree"))
    ):
        return IngestResponse(repo_id=str(existing_repo["id"]), status="ready")

    existing_repo_id = str(existing_repo["id"]) if existing_repo else None
    should_log_ingest = not _is_local_dev_ip(client_ip)
    if existing_repo_id and should_log_ingest:
        should_log_ingest = not await asyncio.to_thread(
            has_recent_ingest_for_repo,
            client_ip,
            existing_repo_id,
        )

    if should_log_ingest:
        used = await asyncio.to_thread(count_ingests_today, client_ip)
        if used >= DAILY_INGEST_LIMIT:
            raise HTTPException(
                status_code=429,
                detail={
                    "error": "rate_limited",
                    "message": (
                        f"You have reached the limit of {DAILY_INGEST_LIMIT} repository "
                        "ingestions per day. Try again tomorrow."
                    ),
                    "limit": DAILY_INGEST_LIMIT,
                    "used": used,
                },
            )

    if existing_repo:
        repo_id = str(existing_repo["id"])
        await asyncio.to_thread(reset_repo_for_reingest, repo_id)
    else:
        repo_id = await asyncio.to_thread(create_repo, github_url, name)

    if should_log_ingest:
        await asyncio.to_thread(log_ingest, client_ip, repo_id)

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
    if not _is_current_cluster_tree(tree):
        raise HTTPException(status_code=409, detail="cluster tree is stale - re-ingest the repo")
    return tree
