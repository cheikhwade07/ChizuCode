from backend.db.database import get_db
import psycopg2.extras

with get_db() as conn:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
                    SELECT table_name FROM information_schema.tables
                    WHERE table_schema = 'public'
                    """)
        print([r['table_name'] for r in cur.fetchall()])