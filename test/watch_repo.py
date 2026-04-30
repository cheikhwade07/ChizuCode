import time
import sys
from backend.db.database import get_repo

REPO_ID = "aead0599-dfc5-430c-89c6-cb7b9af08c38"
INTERVAL = 10  # seconds

print(f"Watching repo: {REPO_ID}")
print(f"Polling every {INTERVAL}s — Ctrl+C to stop\n")

prev_chunks = None

while True:
    try:
        repo = get_repo(REPO_ID)
        status = repo["status"]
        chunks = repo["chunk_count"]
        delta = f" (+{chunks - prev_chunks})" if prev_chunks is not None else ""
        prev_chunks = chunks

        timestamp = time.strftime("%H:%M:%S")
        print(f"[{timestamp}] status: {status} | chunks: {chunks}{delta}")

        if status == "ready":
            print("\n✅ Done! Repo is ready.")
            sys.exit(0)
        if status == "failed":
            print(f"\n❌ Failed: {repo.get('error')}")
            sys.exit(1)

    except Exception as e:
        print(f"Error: {e}")

    time.sleep(INTERVAL)
