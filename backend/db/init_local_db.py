from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path
from urllib.parse import quote

import psycopg2
from psycopg2 import sql

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


def build_database_url(
    *,
    user: str,
    password: str | None,
    host: str,
    port: int,
    database: str,
) -> str:
    auth = quote(user)
    if password:
        auth += f":{quote(password)}"
    return f"postgresql://{auth}@{host}:{port}/{database}"


def masked_url(url: str) -> str:
    if "@" not in url or ":" not in url.split("@", 1)[0]:
        return url
    scheme, rest = url.split("://", 1)
    auth, host = rest.split("@", 1)
    user = auth.split(":", 1)[0]
    return f"{scheme}://{user}:***@{host}"


def connect_admin(args: argparse.Namespace):
    return psycopg2.connect(
        dbname=args.maintenance_db,
        user=args.user,
        password=args.password,
        host=args.host,
        port=args.port,
    )


def ensure_database(args: argparse.Namespace) -> None:
    conn = connect_admin(args)
    conn.set_session(autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (args.database,))
            exists = cur.fetchone() is not None
            if exists:
                logger.info("database %s already exists", args.database)
                return

            cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(args.database)))
            logger.info("created database %s", args.database)
    finally:
        conn.close()


def reset_app_tables() -> None:
    from backend.db.database import get_db

    with get_db(register_vectors=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DROP TABLE IF EXISTS
                    repo_ingest_log,
                    domains,
                    vectors,
                    chunks,
                    repos
                CASCADE
                """
            )
    logger.info("dropped existing app tables")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create and initialize a local ChizuCode Postgres database.")
    parser.add_argument("--host", default=os.getenv("PGHOST", "localhost"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PGPORT", "5432")))
    parser.add_argument("--user", default=os.getenv("PGUSER", "postgres"))
    parser.add_argument("--password", default=os.getenv("PGPASSWORD"))
    parser.add_argument("--database", default=os.getenv("LOCAL_DATABASE_NAME", "codex"))
    parser.add_argument("--maintenance-db", default=os.getenv("PGDATABASE", "postgres"))
    parser.add_argument("--reset", action="store_true", help="Drop app tables before recreating schema.")
    args = parser.parse_args()

    ensure_database(args)

    local_url = build_database_url(
        user=args.user,
        password=args.password,
        host=args.host,
        port=args.port,
        database=args.database,
    )
    os.environ["DATABASE_URL"] = local_url

    from backend.db.database import create_schema

    if args.reset:
        reset_app_tables()

    create_schema()
    logger.info("local database schema ready")
    logger.info("DATABASE_URL=%s", masked_url(local_url))


if __name__ == "__main__":
    main()
