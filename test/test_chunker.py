import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.github import clone_repo, walk_files, cleanup_repo
from backend.chunker import chunk_files

url = "https://github.com/tiangolo/fastapi"
repo_path = None
try:
    repo_path = clone_repo(url)
    files = list(walk_files(repo_path))
    chunks = chunk_files(files)

    print(f"Files: {len(files)} → Chunks: {len(chunks)}")

    split = [c for c in chunks if c["is_split"]]
    single = [c for c in chunks if not c["is_split"]]
    print(f"Split chunks: {len(split)} | Single chunks: {len(single)}")

    # files that needed splitting
    large_files = [f for f in files if f["needs_splitting"]]
    print(f"\nFiles needing splitting: {len(large_files)}")
    for f in large_files[:5]:
        print(f"  {f['file_path']} ({f['loc']} LOC, {f['language']})")

    # sample split chunk
    if split:
        s = split[0]
        print(f"\nSample split chunk:")
        print(f"  file:    {s['file_path']}")
        print(f"  lines:   {s['start_line']}–{s['end_line']} ({s['loc']} LOC)")
        print(f"  index:   {s['chunk_index']}")
        print(f"  preview: {s['content'][:100].strip()}")
    else:
        print("\nNo split chunks — check needs_splitting flags above")

    # verify no chunk has zero or negative LOC
    bad = [c for c in chunks if c["loc"] <= 0]
    print(f"\nMalformed chunks (loc <= 0): {len(bad)}")

finally:
    if repo_path:
        cleanup_repo(repo_path)