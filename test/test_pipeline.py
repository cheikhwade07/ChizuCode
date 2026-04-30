"""
test_pipeline.py — end to end pipeline test against a real small repo.

Tests the full sequence:
    clone → walk → chunk → embed → store → cluster → store tree → persist domains

Run from project root:
    python -m test.test_pipeline

WARNING: This test costs API credits (Gemini + Voyage) and takes 2-5 minutes.
It only processes the first 5 chunks to keep costs low during testing.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

from backend.services.github import clone_repo, walk_files, cleanup_repo, parse_github_url
from backend.services.chunker import chunk_files
from backend.services.embedder import process_chunks
from backend.services.clusterer import build_cluster_tree
from backend.db.database import (
    create_repo,
    set_repo_status,
    get_repo,
    insert_chunks_batch,
    insert_vectors_batch,
    update_repo_chunk_count,
    store_cluster_tree,
    insert_domain,
    update_vector_domain,
    get_domain_tree,
)
from backend.services.pipeline import run_pipeline, _persist_domains, _collect_chunk_ids

# Small real repo — fast to clone
TEST_REPO_URL = "https://github.com/pallets/click"

# Limit chunks processed during test to control cost
MAX_CHUNKS_FOR_TEST = 5


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _validate_tree_node(node: dict, depth: int = 0):
    """Recursively validate tree structure."""
    assert "type" in node,   f"missing type at depth {depth}"
    assert "label" in node,  f"missing label at depth {depth}"
    assert "edges" in node,  f"missing edges at depth {depth}"
    assert node["type"] in ("cluster", "leaf")

    if node["type"] == "leaf":
        assert "file_path" in node, "leaf missing file_path"
        assert "nodes" in node,     "leaf missing nodes"
    else:
        assert "children" in node,        "cluster missing children"
        assert len(node["children"]) > 0, "cluster has no children"
        for child in node["children"]:
            _validate_tree_node(child, depth + 1)


# ---------------------------------------------------------------------------
# Step 1 — clone + walk + chunk (no API calls)
# ---------------------------------------------------------------------------

def test_clone_and_chunk() -> tuple[str, list[dict]]:
    print("\n── Step 1: clone + walk + chunk ────────────────────")
    owner, repo_name = parse_github_url(TEST_REPO_URL)
    name = f"{owner}/{repo_name}"
    print(f"  repo: {name}")

    clone_path = clone_repo(TEST_REPO_URL)
    files = list(walk_files(clone_path))
    chunks = chunk_files(files)

    assert len(files) > 0,  "no files found"
    assert len(chunks) > 0, "no chunks produced"

    print(f"  files  : {len(files)}")
    print(f"  chunks : {len(chunks)}")
    print("  ✓ clone + walk + chunk passed")
    return clone_path, chunks


# ---------------------------------------------------------------------------
# Step 2 — embed (limited to MAX_CHUNKS_FOR_TEST)
# ---------------------------------------------------------------------------

async def test_embed(chunks: list[dict]) -> list[dict]:
    print(f"\n── Step 2: embed (first {MAX_CHUNKS_FOR_TEST} chunks) ──────────────")
    sample = chunks[:MAX_CHUNKS_FOR_TEST]
    enriched = await process_chunks(sample)

    assert len(enriched) == len(sample)
    for e in enriched:
        assert e.get("summary_vector") is not None, f"missing summary_vector for {e['file_path']}"
        assert e.get("code_vector") is not None,    f"missing code_vector for {e['file_path']}"
        assert len(e["summary_vector"]) == 1536
        assert len(e["code_vector"]) == 1536

    print(f"  chunks embedded : {len(enriched)}")
    print("  ✓ embed passed")
    return enriched


# ---------------------------------------------------------------------------
# Step 3 — DB: create repo + insert chunks + vectors
# ---------------------------------------------------------------------------

async def test_db_insert(enriched: list[dict]) -> tuple[str, dict[str, list[str]]]:
    print("\n── Step 3: DB insert ───────────────────────────────")

    repo_id = create_repo(TEST_REPO_URL, "pallets/click")
    set_repo_status(repo_id, "ingesting")

    repo = get_repo(repo_id)
    assert repo["status"] == "ingesting"
    print(f"  repo_id : {repo_id}")

    chunk_ids = insert_chunks_batch(repo_id, enriched)
    assert len(chunk_ids) == len(enriched)
    print(f"  chunks inserted : {len(chunk_ids)}")

    vector_rows = [
        {
            "chunk_id": cid,
            "repo_id": repo_id,
            "summary_vector": chunk["summary_vector"],
            "code_vector": chunk["code_vector"],
        }
        for cid, chunk in zip(chunk_ids, enriched)
    ]
    insert_vectors_batch(vector_rows)
    print(f"  vectors inserted: {len(vector_rows)}")

    update_repo_chunk_count(repo_id, len(enriched))

    # build file_path → [chunk_ids] map
    chunk_id_map: dict[str, list[str]] = {}
    for cid, chunk in zip(chunk_ids, enriched):
        chunk_id_map.setdefault(chunk["file_path"], []).append(cid)

    print("  ✓ DB insert passed")
    return repo_id, chunk_id_map


# ---------------------------------------------------------------------------
# Step 4 — cluster tree
# ---------------------------------------------------------------------------

async def test_cluster(enriched: list[dict], repo_id: str) -> dict:
    print("\n── Step 4: build_cluster_tree ──────────────────────")
    tree = await build_cluster_tree(enriched, repo_id)

    assert isinstance(tree, dict)
    _validate_tree_node(tree)

    # must be JSON serializable
    json.dumps(tree)

    print(f"  root label : {tree['label']}")
    print(f"  root type  : {tree['type']}")
    print(f"  children   : {len(tree.get('children', []))}")
    print("  ✓ build_cluster_tree passed")
    return tree


# ---------------------------------------------------------------------------
# Step 5 — store tree + persist domains
# ---------------------------------------------------------------------------

async def test_store(tree: dict, repo_id: str, chunk_id_map: dict) -> None:
    print("\n── Step 5: store tree + persist domains ────────────")

    # Store JSONB
    store_cluster_tree(repo_id, tree)
    repo = get_repo(repo_id)
    assert repo["cluster_tree"] is not None, "cluster_tree not stored"
    print("  cluster_tree stored as JSONB ✓")

    # Persist domains
    await _persist_domains(tree, repo_id, chunk_id_map)
    domains = get_domain_tree(repo_id)
    assert len(domains) > 0, "no domain rows inserted"
    print(f"  domain rows inserted: {len(domains)}")
    for d in domains[:3]:
        print(f"    level {d['level']}: {d['label']}")

    # Mark ready
    set_repo_status(repo_id, "ready")
    repo = get_repo(repo_id)
    assert repo["status"] == "ready"
    print(f"  final status: {repo['status']}")
    print("  ✓ store + persist passed")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def main():
    print("=" * 55)
    print("pipeline.py test suite")
    print("=" * 55)
    print(f"repo  : {TEST_REPO_URL}")
    print(f"chunks: first {MAX_CHUNKS_FOR_TEST} only (cost control)")

    clone_path = None
    try:
        clone_path, chunks = test_clone_and_chunk()
        enriched             = await test_embed(chunks)
        repo_id, chunk_id_map = await test_db_insert(enriched)
        tree                 = await test_cluster(enriched, repo_id)
        await test_store(tree, repo_id, chunk_id_map)

        print("\n" + "=" * 55)
        print("all tests passed ✓")
        print("=" * 55)

    except AssertionError as e:
        print(f"\n✗ FAILED: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n✗ ERROR: {e}")
        raise
    finally:
        if clone_path:
            cleanup_repo(clone_path)
            print(f"\n  cleaned up: {clone_path}")


if __name__ == "__main__":
    asyncio.run(main())
