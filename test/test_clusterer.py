"""
test_clusterer.py — verify the clustering pipeline independently.

Uses a small synthetic set of enriched chunks (no real repo needed).
Run from project root:
    python -m test.test_clusterer
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from backend.services.clusterer import (
    collapse_to_files,
    build_cluster_tree,
)


# ---------------------------------------------------------------------------
# Synthetic enriched chunks
# Simulates output of process_chunks() — 6 files, some split into 2 chunks
# Files are grouped into 3 semantic areas:
#   auth   → jwt.py, session.py
#   db     → models.py, migrations.py
#   api    → routes.py, middleware.py
# ---------------------------------------------------------------------------

def _make_vector(seed: int, dim: int = 1536) -> list[float]:
    """Deterministic unit vector seeded for reproducibility."""
    rng = np.random.default_rng(seed)
    v = rng.standard_normal(dim).astype(np.float32)
    return (v / np.linalg.norm(v)).tolist()


# Auth cluster — seeds 0,1,2,3 (close to each other)
# DB cluster    — seeds 20,21,22,23
# API cluster   — seeds 40,41,42,43

SYNTHETIC_CHUNKS = [
    # jwt.py — split into 2 chunks
    {
        "file_path": "auth/jwt.py", "language": "python", "file_type": "code",
        "is_split": True, "chunk_index": 0,
        "summary": "Handles JWT token creation and signing for user authentication.",
        "summary_vector": _make_vector(0), "code_vector": _make_vector(1),
    },
    {
        "file_path": "auth/jwt.py", "language": "python", "file_type": "code",
        "is_split": True, "chunk_index": 1,
        "summary": "Handles JWT token validation and decoding for authentication checks.",
        "summary_vector": _make_vector(1), "code_vector": _make_vector(2),
    },
    # session.py — single chunk
    {
        "file_path": "auth/session.py", "language": "python", "file_type": "code",
        "is_split": False, "chunk_index": 0,
        "summary": "Manages user session state and cookie-based authentication.",
        "summary_vector": _make_vector(2), "code_vector": _make_vector(3),
    },
    # models.py — split into 2 chunks
    {
        "file_path": "db/models.py", "language": "python", "file_type": "code",
        "is_split": True, "chunk_index": 0,
        "summary": "Defines ORM models for users, roles, and permissions in the database.",
        "summary_vector": _make_vector(20), "code_vector": _make_vector(21),
    },
    {
        "file_path": "db/models.py", "language": "python", "file_type": "code",
        "is_split": True, "chunk_index": 1,
        "summary": "Defines ORM models for sessions and audit logs in the database.",
        "summary_vector": _make_vector(21), "code_vector": _make_vector(22),
    },
    # migrations.py — single chunk
    {
        "file_path": "db/migrations.py", "language": "python", "file_type": "code",
        "is_split": False, "chunk_index": 0,
        "summary": "Manages database schema migrations and version control for the data layer.",
        "summary_vector": _make_vector(22), "code_vector": _make_vector(23),
    },
    # routes.py — single chunk
    {
        "file_path": "api/routes.py", "language": "python", "file_type": "code",
        "is_split": False, "chunk_index": 0,
        "summary": "Defines FastAPI route handlers for user authentication and profile endpoints.",
        "summary_vector": _make_vector(40), "code_vector": _make_vector(41),
    },
    # middleware.py — single chunk
    {
        "file_path": "api/middleware.py", "language": "python", "file_type": "code",
        "is_split": False, "chunk_index": 0,
        "summary": "Implements request middleware for rate limiting and CORS handling.",
        "summary_vector": _make_vector(42), "code_vector": _make_vector(43),
    },
]


# ---------------------------------------------------------------------------
# Step 1 — collapse_to_files
# ---------------------------------------------------------------------------

def test_collapse_to_files():
    print("\n── Step 1: collapse_to_files ───────────────────────")
    files = collapse_to_files(SYNTHETIC_CHUNKS)

    # 8 chunks → 6 unique files
    assert len(files) == 6, f"expected 6 files, got {len(files)}"

    file_paths = {f["file_path"] for f in files}
    assert "auth/jwt.py" in file_paths
    assert "auth/session.py" in file_paths
    assert "db/models.py" in file_paths
    assert "db/migrations.py" in file_paths
    assert "api/routes.py" in file_paths
    assert "api/middleware.py" in file_paths

    # jwt.py should have averaged vector (not None)
    jwt = next(f for f in files if f["file_path"] == "auth/jwt.py")
    assert jwt["summary_vector"] is not None
    assert len(jwt["summary_vector"]) == 1536

    print(f"  files collapsed : {len(files)}")
    print(f"  file paths      : {sorted(file_paths)}")
    print(f"  jwt.py vector   : {len(jwt['summary_vector'])} dims (averaged)")
    print("  ✓ collapse_to_files passed")
    return files


# ---------------------------------------------------------------------------
# Step 2 — build_cluster_tree
# ---------------------------------------------------------------------------

def _validate_node(node: dict, depth: int = 0):
    indent = "  " * depth
    assert "type" in node,    f"missing 'type' at depth {depth}"
    assert "label" in node,   f"missing 'label' at depth {depth}"
    assert "edges" in node,   f"missing 'edges' at depth {depth}"
    assert node["type"] in ("cluster", "leaf"), f"unknown type: {node['type']}"

    if node["type"] == "leaf":
        assert "file_path" in node, "leaf missing file_path"
        assert "nodes" in node,     "leaf missing nodes"
        print(f"{indent}[leaf]    {node['label']} ({node['file_path']})")
        print(f"{indent}          nodes: {[n['label'] for n in node.get('nodes', [])]}")
        print(f"{indent}          edges: {len(node.get('edges', []))}")
    else:
        assert "children" in node,         "cluster missing children"
        assert len(node["children"]) >= 1, "cluster has no children"
        print(f"{indent}[cluster] {node['label']}")
        print(f"{indent}          summary: {node.get('summary', '')[:80]}")
        print(f"{indent}          edges: {len(node.get('edges', []))}")
        for child in node["children"]:
            _validate_node(child, depth + 1)


async def test_build_cluster_tree():
    print("\n── Step 2: build_cluster_tree ──────────────────────")
    tree = await build_cluster_tree(SYNTHETIC_CHUNKS, repo_id="test-repo-id")

    assert isinstance(tree, dict), "tree must be a dict"
    assert tree["type"] in ("cluster", "leaf")
    assert tree["label"], "root label is empty"

    print(f"\n  Tree structure:")
    _validate_node(tree, depth=1)

    # Validate JSON serializable
    try:
        json.dumps(tree)
        print("\n  ✓ tree is JSON serializable")
    except Exception as e:
        raise AssertionError(f"tree not JSON serializable: {e}")

    print("  ✓ build_cluster_tree passed")
    return tree


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def main():
    print("=" * 55)
    print("clusterer.py test suite")
    print("=" * 55)

    try:
        test_collapse_to_files()
        tree = await test_build_cluster_tree()

        print("\n" + "=" * 55)
        print("all tests passed ✓")
        print("=" * 55)

        print("\nFull tree JSON:")
        print(json.dumps(tree, indent=2))

    except AssertionError as e:
        print(f"\n✗ FAILED: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n✗ ERROR: {e}")
        raise


if __name__ == "__main__":
    asyncio.run(main())
