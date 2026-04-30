"""
test_rag.py — verify the RAG query pipeline.

Uses the already-ingested repo from the pipeline test.
Run from project root:
    python -m test.test_rag
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.services.rag import query_repo, _embed_query, _rrf_merge

# Repo from pipeline test — must be status=ready in DB
REPO_ID = "2a0ebd63-74af-477a-a18a-5ea1a71489f3"

RELEVANT_QUESTION   = "How does Click handle command line documentation?"
IRRELEVANT_QUESTION = "How do I process a payment with Stripe?"


# ---------------------------------------------------------------------------
# Step 1 — embed query
# ---------------------------------------------------------------------------

async def test_embed_query():
    print("\n── Step 1: _embed_query ────────────────────────────")
    summary_vector, code_vector = await _embed_query(RELEVANT_QUESTION)

    assert summary_vector is not None, "summary_vector is None"
    assert code_vector is not None,    "code_vector is None"
    assert len(summary_vector) == 1536, f"wrong summary dims: {len(summary_vector)}"
    assert len(code_vector) == 1536,    f"wrong code dims: {len(code_vector)}"

    print(f"  question               : {RELEVANT_QUESTION}")
    print(f"  summary_vector         : {len(summary_vector)} dims")
    print(f"  code_vector            : {len(code_vector)} dims")
    print(f"  first 5 summary values : {[round(v, 4) for v in summary_vector[:5]]}")
    print(f"  first 5 code values    : {[round(v, 4) for v in code_vector[:5]]}")
    print("  ✓ _embed_query passed")
    return summary_vector, code_vector


# ---------------------------------------------------------------------------
# Step 2 — RRF merge logic
# ---------------------------------------------------------------------------

def test_rrf_merge():
    print("\n── Step 2: _rrf_merge ──────────────────────────────")

    summary_results = [
        {"chunk_id": "aaa", "file_path": "a.py", "summary": "A", "score": 0.9},
        {"chunk_id": "bbb", "file_path": "b.py", "summary": "B", "score": 0.8},
        {"chunk_id": "ccc", "file_path": "c.py", "summary": "C", "score": 0.7},
    ]
    code_results = [
        {"chunk_id": "bbb", "file_path": "b.py", "summary": "B", "score": 0.95},
        {"chunk_id": "aaa", "file_path": "a.py", "summary": "A", "score": 0.85},
        {"chunk_id": "ddd", "file_path": "d.py", "summary": "D", "score": 0.6},
    ]

    merged = _rrf_merge(summary_results, code_results, k=50)

    assert len(merged) == 4, f"expected 4 unique chunks, got {len(merged)}"
    chunk_ids = [str(r["chunk_id"]) for r in merged]
    assert chunk_ids[0] in ("aaa", "bbb"), "top result should be aaa or bbb"
    ddd_idx = chunk_ids.index("ddd")
    assert ddd_idx > chunk_ids.index("aaa"), "ddd should rank lower than aaa"
    scores = [r["score"] for r in merged]
    assert scores == sorted(scores, reverse=True), "results not sorted by score"

    print(f"  merged chunks : {len(merged)}")
    print(f"  ranked order  : {chunk_ids}")
    print(f"  RRF scores    : {scores}")
    print(f"  note: aaa=1st+2nd, bbb=2nd+1st → tied at top")
    print(f"        ccc only in summary list → lower score")
    print(f"        ddd only in code list    → lower score")
    print("  ✓ _rrf_merge passed")


# ---------------------------------------------------------------------------
# Step 3 — relevant question
# ---------------------------------------------------------------------------

async def test_relevant_query():
    print("\n── Step 3: relevant query ──────────────────────────")
    print(f"  question: {RELEVANT_QUESTION}")

    result = await query_repo(
        question=RELEVANT_QUESTION,
        repo_id=REPO_ID,
    )

    assert "answer" in result,     "missing answer"
    assert "confidence" in result, "missing confidence"
    assert "sources" in result,    "missing sources"
    assert isinstance(result["answer"], str) and result["answer"], "answer is empty"
    assert result["confidence"] in ("high", "medium", "low"), \
        f"invalid confidence: {result['confidence']}"
    assert len(result["sources"]) > 0, "no sources returned"

    for source in result["sources"]:
        assert "chunk_id"  in source
        assert "file_path" in source
        assert "score"     in source
        assert "summary"   in source
        assert "domain_id" in source

    print(f"\n  ANSWER (confidence={result['confidence']}):")
    print(f"  {result['answer']}")

    print(f"\n  SOURCES ({len(result['sources'])} chunks):")
    for i, s in enumerate(result["sources"], 1):
        print(f"    [{i}] {s['file_path']}")
        print(f"         score     : {s['score']}")
        print(f"         domain_id : {s['domain_id']}")
        print(f"         summary   : {s['summary'][:120]}")

    print("\n  FULL JSON RESPONSE:")
    print(json.dumps(result, indent=2))
    print("  ✓ relevant query passed")
    return result


# ---------------------------------------------------------------------------
# Step 4 — irrelevant question (should be rejected)
# ---------------------------------------------------------------------------

async def test_irrelevant_query():
    print("\n── Step 4: irrelevant query (rejection check) ──────")
    print(f"  question: {IRRELEVANT_QUESTION}")

    result = await query_repo(
        question=IRRELEVANT_QUESTION,
        repo_id=REPO_ID,
    )

    assert "answer" in result
    assert "sources" in result

    print(f"\n  ANSWER (confidence={result['confidence']}):")
    print(f"  {result['answer']}")
    print(f"\n  SOURCES: {len(result['sources'])}")

    if len(result["sources"]) == 0:
        print("  → correctly rejected — no sources returned")
    else:
        assert result["confidence"] == "low", \
            f"irrelevant query should return low confidence, got {result['confidence']}"
        print("  → low confidence answer returned (acceptable)")
        for i, s in enumerate(result["sources"], 1):
            print(f"    [{i}] {s['file_path']} score={s['score']}")

    print("\n  FULL JSON RESPONSE:")
    print(json.dumps(result, indent=2))
    print("  ✓ irrelevant query passed")


# ---------------------------------------------------------------------------
# Step 5 — domain scoped query
# ---------------------------------------------------------------------------

async def test_scoped_query():
    print("\n── Step 5: domain scoped query ─────────────────────")

    from backend.db.database import get_domain_tree
    domains = get_domain_tree(REPO_ID)

    if not domains:
        print("  skipped — no domains in DB for this repo")
        return

    domain = domains[0]
    domain_id = str(domain["id"])
    print(f"  domain label : {domain['label']}")
    print(f"  domain id    : {domain_id}")
    print(f"  domain level : {domain['level']}")
    print(f"  question     : {RELEVANT_QUESTION}")

    result = await query_repo(
        question=RELEVANT_QUESTION,
        repo_id=REPO_ID,
        domain_id=domain_id,
    )

    assert "answer" in result
    assert "sources" in result

    print(f"\n  ANSWER (confidence={result['confidence']}):")
    print(f"  {result['answer']}")
    print(f"\n  SOURCES: {len(result['sources'])}")
    for i, s in enumerate(result["sources"], 1):
        print(f"    [{i}] {s['file_path']} score={s['score']}")

    print("\n  FULL JSON RESPONSE:")
    print(json.dumps(result, indent=2))
    print("  ✓ scoped query passed")


# ---------------------------------------------------------------------------
# Step 6 — JSON serializable
# ---------------------------------------------------------------------------

async def test_json_serializable(result: dict):
    print("\n── Step 6: JSON serializable ───────────────────────")
    try:
        serialized = json.dumps(result, indent=2)
        print(f"  response size : {len(serialized)} chars")
        print("  ✓ response is JSON serializable")
    except Exception as e:
        raise AssertionError(f"response not JSON serializable: {e}")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def main():
    print("=" * 55)
    print("rag.py test suite")
    print("=" * 55)
    print(f"repo_id: {REPO_ID}")

    try:
        await test_embed_query()
        test_rrf_merge()
        result = await test_relevant_query()
        await test_irrelevant_query()
        await test_scoped_query()
        await test_json_serializable(result)

        print("\n" + "=" * 55)
        print("all tests passed ✓")
        print("=" * 55)

    except AssertionError as e:
        print(f"\n✗ FAILED: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n✗ ERROR: {e}")
        raise


if __name__ == "__main__":
    asyncio.run(main())