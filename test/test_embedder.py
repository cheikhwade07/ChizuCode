"""
test_embedder.py — verify each step of the embedder pipeline independently.

Run from project root:
    python -m test.test_embedder
"""

import asyncio
import sys
from pathlib import Path

# make sure backend is on the path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.services.embedder import (
    _summarize,
    _embed_summary,
    _embed_code,
    process_chunk,
)

# ---------------------------------------------------------------------------
# Sample chunk — a realistic small Python function
# ---------------------------------------------------------------------------

SAMPLE_CHUNK = {
    "file_path": "auth/jwt.py",
    "content": """\
import jwt
from datetime import datetime, timedelta

SECRET_KEY = "supersecret"
ALGORITHM  = "HS256"

def create_access_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": datetime.utcnow() + timedelta(hours=1),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def decode_access_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
""",
    "language": "python",
    "file_type": "code",
    "loc": 16,
    "is_split": False,
    "chunk_index": 0,
}


# ---------------------------------------------------------------------------
# Individual step tests
# ---------------------------------------------------------------------------

async def test_summarize():
    print("\n── Step 1: _summarize ──────────────────────────────")
    summary = await _summarize(SAMPLE_CHUNK)

    print(f"  summary length : {len(summary)} chars")
    print(f"  summary preview: {summary[:200]}")

    assert isinstance(summary, str), "summary must be a string"
    assert len(summary) > 20, "summary too short — likely a fallback"
    assert "unavailable" not in summary.lower(), "got fallback summary — Gemini call failed"

    print("  ✓ _summarize passed")
    return summary


async def test_embed_summary(summary: str):
    print("\n── Step 2: _embed_summary ──────────────────────────")
    vector = await _embed_summary(summary)

    assert vector is not None, "summary_vector is None — embedding call failed"
    assert isinstance(vector, list), "summary_vector must be a list"
    assert len(vector) == 3072, f"expected 3072 dims, got {len(vector)}"
    assert all(isinstance(v, float) for v in vector[:5]), "vector values must be floats"

    print(f"  dimensions : {len(vector)}")
    print(f"  first 5 values: {[round(v, 4) for v in vector[:5]]}")
    print("  ✓ _embed_summary passed")


async def test_embed_code():
    print("\n── Step 3: _embed_code ─────────────────────────────")
    vector = await _embed_code(SAMPLE_CHUNK["content"])

    assert vector is not None, "code_vector is None — Voyage call failed"
    assert isinstance(vector, list), "code_vector must be a list"
    assert len(vector) == 1536, f"expected 1024 dims, got {len(vector)}"
    assert all(isinstance(v, float) for v in vector[:5]), "vector values must be floats"

    print(f"  dimensions : {len(vector)}")
    print(f"  first 5 values: {[round(v, 4) for v in vector[:5]]}")
    print("  ✓ _embed_code passed")


async def test_process_chunk():
    print("\n── Full pipeline: process_chunk ────────────────────")
    result = await process_chunk(SAMPLE_CHUNK)

    # check all expected keys are present
    for key in ["summary", "summary_vector", "code_vector", "file_path", "content"]:
        assert key in result, f"missing key: {key}"

    assert isinstance(result["summary"], str)
    assert result["summary_vector"] is not None
    assert result["code_vector"] is not None
    assert len(result["summary_vector"]) == 1536
    assert len(result["code_vector"]) == 1536

    print(f"  file_path     : {result['file_path']}")
    print(f"  summary       : {result['summary'][:120]}...")
    print(f"  summary_vector: {len(result['summary_vector'])} dims")
    print(f"  code_vector   : {len(result['code_vector'])} dims")
    print("  ✓ process_chunk passed")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def main():
    print("=" * 55)
    print("embedder.py test suite")
    print("=" * 55)

    try:
        # run steps in order — each builds on the previous
        summary = await test_summarize()
        await test_embed_summary(summary)
        await test_embed_code()
        await test_process_chunk()

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
