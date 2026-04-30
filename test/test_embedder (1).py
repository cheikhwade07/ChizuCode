"""
test_embedder.py — quick sanity check for the multi-key embedder.

Run from project root:
    python test/test_embedder.py
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.services.embedder import process_chunks, _GEMINI_KEYS

FAKE_CHUNKS = [
    {
        "file_path": f"src/module_{i}.ts",
        "language": "typescript",
        "file_type": "source",
        "content": f"export function handler_{i}() {{ return '{i}'; }}",
    }
    for i in range(6)  # 6 chunks → 2 per key if you have 3 keys
]

async def main():
    print(f"✓ Loaded {len(_GEMINI_KEYS)} Gemini key(s)\n")
    print(f"Processing {len(FAKE_CHUNKS)} test chunks...\n")

    print([k[:8] + "..." for k in _GEMINI_KEYS])  # print first 8 chars of each key
    results = await process_chunks(FAKE_CHUNKS, batch_size=6)

    for r in results:
        has_summary = bool(r.get("summary"))
        has_sum_vec = r.get("summary_vector") is not None
        has_code_vec = r.get("code_vector") is not None
        status = "✓" if all([has_summary, has_sum_vec, has_code_vec]) else "✗"
        print(
            f"{status} {r['file_path']}"
            f" | summary: {has_summary}"
            f" | summary_vec: {has_sum_vec}"
            f" | code_vec: {has_code_vec}"
        )
        if has_summary:
            print(f"   → {r['summary'][:80]}...")
        print()

    passed = sum(
        1 for r in results
        if r.get("summary") and r.get("summary_vector") and r.get("code_vector")
    )
    print(f"\n{passed}/{len(results)} chunks fully processed.")

if __name__ == "__main__":
    asyncio.run(main())
