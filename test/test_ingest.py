"""
test_ingest.py — verify the full ingestion pipeline end to end.

Tests each stage independently, then runs the full pipeline against
a real small public GitHub repo.

Run from project root:
    python -m test.test_ingest
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.services.github import (
    parse_github_url,
    clone_repo,
    walk_files,
    cleanup_repo,
    RepoIngestionError,
)
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

# Small real public repo — fast to clone (~10 files)
TEST_REPO_URL = "https://github.com/pallets/click"


# ---------------------------------------------------------------------------
# Step 1 — parse_github_url
# ---------------------------------------------------------------------------

def test_parse_github_url():
    print("\n── Step 1: parse_github_url ────────────────────────")

    owner, repo = parse_github_url("https://github.com/pallets/click")
    assert owner == "pallets", f"expected 'pallets', got '{owner}'"
    assert repo == "click", f"expected 'click', got '{repo}'"
    print(f"  owner: {owner}, repo: {repo}")

    owner2, repo2 = parse_github_url("https://github.com/pallets/click.git")
    assert owner2 == "pallets"
    assert repo2 == "click"
    print(f"  .git suffix handled correctly")

    try:
        parse_github_url("https://notgithub.com/something")
    except (RepoIngestionError, Exception):
        print(f"  invalid URL raises error correctly")

    print("  ✓ parse_github_url passed")


# ---------------------------------------------------------------------------
# Step 2 — clone_repo
# ---------------------------------------------------------------------------

def test_clone_repo() -> str:
    print("\n── Step 2: clone_repo ──────────────────────────────")
    clone_path = clone_repo(TEST_REPO_URL)

    assert Path(clone_path).exists(), "clone path does not exist"
    assert Path(clone_path).is_dir(), "clone path is not a directory"

    files = list(Path(clone_path).rglob("*.py"))
    assert len(files) > 0, "no Python files found in cloned repo"

    print(f"  clone path   : {clone_path}")
    print(f"  python files : {len(files)}")
    print("  ✓ clone_repo passed")
    return clone_path


# ---------------------------------------------------------------------------
# Step 3 — walk_files
# ---------------------------------------------------------------------------

def test_walk_files(clone_path: str) -> list[dict]:
    print("\n── Step 3: walk_files ──────────────────────────────")
    files = list(walk_files(clone_path))

    assert len(files) > 0, "walk_files returned no files"

    for f in files:
        assert "file_path" in f
        assert "content" in f
        assert "loc" in f
        assert "language" in f
        assert "needs_splitting" in f
        assert "file_type" in f
        assert f["file_type"] in ("code", "config", "doc")

    code_files   = [f for f in files if f["file_type"] == "code"]
    config_files = [f for f in files if f["file_type"] == "config"]
    doc_files    = [f for f in files if f["file_type"] == "doc"]

    print(f"  total files  : {len(files)}")
    print(f"  code         : {len(code_files)}")
    print(f"  config       : {len(config_files)}")
    print(f"  docs         : {len(doc_files)}")
    print(f"  sample paths : {[f['file_path'] for f in files[:3]]}")
    print("  ✓ walk_files passed")
    return files


# ---------------------------------------------------------------------------
# Step 4 — chunk_files
# ---------------------------------------------------------------------------

def test_chunk_files(files: list[dict]) -> list[dict]:
    print("\n── Step 4: chunk_files ─────────────────────────────")
    chunks = chunk_files(files)

    assert len(chunks) > 0, "chunk_files returned no chunks"

    for c in chunks:
        assert "file_path" in c
        assert "content" in c
        assert "file_type" in c
        assert "is_split" in c
        assert "chunk_index" in c

    split_chunks = [c for c in chunks if c["is_split"]]
    print(f"  input files  : {len(files)}")
    print(f"  output chunks: {len(chunks)}")
    print(f"  split chunks : {len(split_chunks)}")
    print("  ✓ chunk_files passed")
    return chunks


# ---------------------------------------------------------------------------
# Step 5 — process_chunks (summarize + embed) — runs on first 3 only
# ---------------------------------------------------------------------------

async def test_process_chunks(chunks: list[dict]) -> list[dict]:
    print("\n── Step 5: process_chunks (first 3 only) ───────────")
    sample = chunks[:3]
    enriched = await process_chunks(sample)

    assert len(enriched) == len(sample), "output length mismatch"

    for e in enriched:
        assert "summary" in e,        "missing summary"
        assert "summary_vector" in e, "missing summary_vector"
        assert "code_vector" in e,    "missing code_vector"
        assert e["summary_vector"] is not None, "summary_vector is None"
        assert e["code_vector"] is not None,    "code_vector is None"
        assert len(e["summary_vector"]) == 1536, f"wrong summary dims: {len(e['summary_vector'])}"
        assert len(e["code_vector"]) == 1536,    f"wrong code dims: {len(e['code_vector'])}"

    print(f"  chunks processed : {len(enriched)}")
    print(f"  summary preview  : {enriched[0]['summary'][:100]}...")
    print(f"  summary_vector   : {len(enriched[0]['summary_vector'])} dims")
    print(f"  code_vector      : {len(enriched[0]['code_vector'])} dims")
    print("  ✓ process_chunks passed")
    return enriched


# ---------------------------------------------------------------------------
# Step 6 — DB: create_repo, insert_chunks_batch, insert_vectors_batch
# ---------------------------------------------------------------------------

async def test_db_pipeline(enriched: list[dict]):
    print("\n── Step 6: DB insert pipeline ──────────────────────")

    # create repo row
    repo_id = create_repo(TEST_REPO_URL, "pallets/click")
    assert repo_id, "create_repo returned empty id"
    print(f"  repo_id      : {repo_id}")

    # set status ingesting
    set_repo_status(repo_id, "ingesting")
    repo = get_repo(repo_id)
    assert repo["status"] == "ingesting"
    print(f"  status       : {repo['status']}")

    # insert chunks
    chunk_ids = insert_chunks_batch(repo_id, enriched)
    assert len(chunk_ids) == len(enriched), "chunk_ids length mismatch"
    print(f"  chunk_ids    : {len(chunk_ids)} inserted")

    # insert vectors
    vector_rows = [
        {
            "chunk_id": chunk_id,
            "repo_id": repo_id,
            "summary_vector": chunk["summary_vector"],
            "code_vector": chunk["code_vector"],
        }
        for chunk_id, chunk in zip(chunk_ids, enriched)
    ]
    insert_vectors_batch(vector_rows)
    print(f"  vectors      : {len(vector_rows)} inserted")

    # update chunk count and mark ready
    update_repo_chunk_count(repo_id, len(enriched))
    set_repo_status(repo_id, "ready")
    repo = get_repo(repo_id)
    assert repo["status"] == "ready"
    assert repo["chunk_count"] == len(enriched)
    print(f"  final status : {repo['status']}")
    print(f"  chunk_count  : {repo['chunk_count']}")
    print("  ✓ DB pipeline passed")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def main():

    print("=" * 55)
    print("ingest pipeline test suite")
    print("=" * 55)

    clone_path = None
    try:
        test_parse_github_url()
        clone_path = test_clone_repo()
        files      = test_walk_files(clone_path)
        chunks     = test_chunk_files(files)
        enriched   = await test_process_chunks(chunks)
        await test_db_pipeline(enriched)

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
