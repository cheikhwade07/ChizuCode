"""
pipeline.py — full ingestion pipeline orchestrator.

Owns the complete sequence from clone to cluster storage.
Called by ingest.py as a background task.

Sequence:
    clone_repo
        → walk_files
        → chunk_files
        → process_chunks (summarize + embed)
        → insert_chunks_batch + insert_vectors_batch
        → build_cluster_tree
        → store_cluster_tree (JSONB on repos)
        → persist_domains (flatten tree → domains table for scoped RAG)
        → update_vector_domains (link vectors to domain_ids)
        → set_repo_status → ready
"""

from __future__ import annotations

import asyncio
import logging

from backend.services.github import clone_repo, walk_files, cleanup_repo, parse_github_url
from backend.services.chunker import chunk_files
from backend.services.embedder import process_chunks
from backend.services.clusterer import build_cluster_tree
from backend.db.database import (
    set_repo_status,
    insert_chunks_batch,
    insert_vectors_batch,
    update_repo_chunk_count,
    store_cluster_tree,
    insert_domain,
    update_vector_domain,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Domain persistence — flatten tree into domains table for scoped RAG
# ---------------------------------------------------------------------------

async def _persist_domains(
        node: dict,
        repo_id: str,
        chunk_id_map: dict[str, list[str]],  # file_path → [chunk_ids]
        parent_id: str | None = None,
        level: int = 0,
) -> str:
    """
    Recursively insert domain nodes into the domains table.
    Returns the domain_id of the inserted node.
    Links vector rows to their domain_id via update_vector_domain.
    """
    # Collect chunk_ids for this node
    if node["type"] == "leaf":
        chunk_ids = chunk_id_map.get(node["file_path"], [])
    else:
        # Internal node owns all chunk_ids of its descendants
        chunk_ids = _collect_chunk_ids(node, chunk_id_map)

    domain_id = await asyncio.to_thread(
        insert_domain,
        repo_id,
        node["label"],
        node.get("summary", ""),
        level,
        chunk_ids,
        parent_id,
    )

    # Link vector rows to this domain
    if chunk_ids:
        await asyncio.to_thread(update_vector_domain, chunk_ids, domain_id)

    # Recurse into children
    for child in node.get("children", []):
        await _persist_domains(child, repo_id, chunk_id_map, domain_id, level + 1)

    return domain_id


def _collect_chunk_ids(node: dict, chunk_id_map: dict[str, list[str]]) -> list[str]:
    """Recursively collect all chunk_ids under a node."""
    ids = []
    if node["type"] == "leaf":
        ids.extend(chunk_id_map.get(node["file_path"], []))
    for child in node.get("children", []):
        ids.extend(_collect_chunk_ids(child, chunk_id_map))
    return ids


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

async def run_pipeline(repo_id: str, github_url: str) -> None:
    """
    Full ingestion pipeline. Called as a FastAPI background task.
    Handles its own error reporting and cleanup.
    """
    clone_path = None
    try:
        # ── 1. Status: ingesting ─────────────────────────────────────────
        await asyncio.to_thread(set_repo_status, repo_id, "ingesting")
        logger.info("[%s] starting pipeline for %s", repo_id, github_url)

        # ── 2. Clone ─────────────────────────────────────────────────────
        logger.info("[%s] cloning repo", repo_id)
        clone_path = await asyncio.to_thread(clone_repo, github_url)

        # ── 3. Walk files ────────────────────────────────────────────────
        logger.info("[%s] walking files", repo_id)
        files = list(await asyncio.to_thread(walk_files, clone_path))
        logger.info("[%s] found %d files", repo_id, len(files))

        if not files:
            raise ValueError("no supported files found in repository")

        # ── 4. Chunk ─────────────────────────────────────────────────────
        logger.info("[%s] chunking files", repo_id)
        chunks = await asyncio.to_thread(chunk_files, files)
        logger.info("[%s] produced %d chunks", repo_id, len(chunks))

        # ── 5. Summarize + embed ─────────────────────────────────────────
        logger.info("[%s] summarizing and embedding chunks", repo_id)
        enriched = await process_chunks(chunks)
        logger.info("[%s] embedding complete", repo_id)

        # ── 6. Store chunks ──────────────────────────────────────────────
        logger.info("[%s] inserting chunks into DB", repo_id)
        chunk_ids = await asyncio.to_thread(insert_chunks_batch, repo_id, enriched)

        # Build file_path → [chunk_ids] map for domain linking
        chunk_id_map: dict[str, list[str]] = {}
        for chunk_id, chunk in zip(chunk_ids, enriched):
            chunk_id_map.setdefault(chunk["file_path"], []).append(chunk_id)

        # ── 7. Store vectors ─────────────────────────────────────────────
        logger.info("[%s] inserting vectors into DB", repo_id)
        vector_rows = [
            {
                "chunk_id": chunk_id,
                "repo_id": repo_id,
                "summary_vector": chunk["summary_vector"],
                "code_vector": chunk["code_vector"],
            }
            for chunk_id, chunk in zip(chunk_ids, enriched)
        ]
        await asyncio.to_thread(insert_vectors_batch, vector_rows)

        # ── 8. Update chunk count ────────────────────────────────────────
        await asyncio.to_thread(update_repo_chunk_count, repo_id, len(enriched))

        # ── 9. Build cluster tree ────────────────────────────────────────
        logger.info("[%s] building cluster tree", repo_id)
        tree = await build_cluster_tree(enriched, repo_id)

        # ── 10. Store tree as JSONB (for fast graph endpoint) ────────────
        logger.info("[%s] storing cluster tree", repo_id)
        await asyncio.to_thread(store_cluster_tree, repo_id, tree)

        # ── 11. Flatten tree → domains table (for scoped RAG) ────────────
        logger.info("[%s] persisting domains", repo_id)
        await _persist_domains(tree, repo_id, chunk_id_map)

        # ── 12. Mark ready ───────────────────────────────────────────────
        await asyncio.to_thread(set_repo_status, repo_id, "ready")
        logger.info("[%s] pipeline complete", repo_id)

    except Exception as e:
        logger.exception("[%s] pipeline failed: %s", repo_id, e)
        await asyncio.to_thread(set_repo_status, repo_id, "failed", str(e))

    finally:
        if clone_path:
            await asyncio.to_thread(cleanup_repo, clone_path)
            logger.info("[%s] clone dir cleaned up", repo_id)