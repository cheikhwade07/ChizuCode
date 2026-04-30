# test_github.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.services.github import cleanup_repo, clone_repo, walk_files

url = "https://github.com/tiangolo/fastapi"  # or any small public repo

repo_path = None
try:
    print("Cloning...")
    repo_path = clone_repo(url)
    print(f"Cloned to {repo_path}")

    files = list(walk_files(repo_path))
    print(f"\nFound {len(files)} files\n")

    for f in files[:10]:  # print first 10
        print(f"  {f['file_type']:6} | {f['loc']:4} LOC | split={f['needs_splitting']} | {f['file_path']}")

    # summary by file type
    code  = [f for f in files if f['file_type'] == 'code']
    doc   = [f for f in files if f['file_type'] == 'doc']
    conf  = [f for f in files if f['file_type'] == 'config']
    split = [f for f in files if f['needs_splitting']]

    print(f"\ncode: {len(code)} | doc: {len(doc)} | config: {len(conf)}")
    print(f"flagged for splitting: {len(split)}")
    for f in split:
        print(f"  {f['file_path']} ({f['loc']} LOC, {f['language']})")

finally:
    if repo_path:
        cleanup_repo(repo_path)
        print("\nCleaned up.")
