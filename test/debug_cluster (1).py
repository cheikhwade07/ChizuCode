import asyncio
from backend.db.database import get_db
import psycopg2.extras

REPO_ID = "19d8265a-7c38-4bd2-a652-c38d46a62ab1"

def get_chunks(repo_id):
    with get_db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT c.file_path, c.raw_code as content, c.summary,
                       c.language, c.file_type, c.is_split, c.chunk_index,
                       v.summary_vector, v.code_vector
                FROM chunks c
                JOIN vectors v ON v.chunk_id = c.id
                WHERE c.repo_id = %s
            """, (repo_id,))
            return [dict(r) for r in cur.fetchall()]

async def main():
    chunks = get_chunks(REPO_ID)
    print(f"chunks found: {len(chunks)}")
    if chunks:
        print(f"first chunk file_path: {chunks[0]['file_path']}")
        print(f"has summary_vector: {chunks[0]['summary_vector'] is not None}")
        print(f"has code_vector: {chunks[0]['code_vector'] is not None}")
        print(f"summary preview: {chunks[0]['summary'][:100] if chunks[0]['summary'] else 'None'}")

    # now try clustering
    from backend.services.clusterer import build_cluster_tree
    print("\nrunning build_cluster_tree...")
    try:
        tree = await build_cluster_tree(chunks, REPO_ID)
        print(f"tree label: {tree['label']}")
        print(f"tree type: {tree['type']}")
        print(f"children: {len(tree.get('children', []))}")
    except Exception as e:
        print(f"clustering failed: {e}")
        raise

asyncio.run(main())
