"""
db/init_db.py — database initialization and reset utilities.

Usage:
    # Initialize schema (safe to run multiple times)
    python -m backend.db.init_db

    # Clear all data and recreate schema
    python -m backend.db.init_db --reset
"""

from __future__ import annotations

import argparse
import logging

from backend.db.database import create_schema, get_db

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Drop all tables
# ---------------------------------------------------------------------------

DROP_SQL = """
DROP TABLE IF EXISTS vectors  CASCADE;
DROP TABLE IF EXISTS chunks   CASCADE;
DROP TABLE IF EXISTS domains  CASCADE;
DROP TABLE IF EXISTS repos    CASCADE;
"""


def drop_schema() -> None:
    """Drop all tables. Irreversible — use only during development."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(DROP_SQL)
    logger.info("all tables dropped")


def reset_schema() -> None:
    """Drop all tables then recreate them. Wipes all data."""
    drop_schema()
    create_schema()
    logger.info("schema reset complete")


def clear_data() -> None:
    """
    Delete all rows from all tables without dropping the schema.
    Faster than reset when you just want to re-ingest.
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM vectors")
            cur.execute("DELETE FROM chunks")
            cur.execute("DELETE FROM domains")
            cur.execute("DELETE FROM repos")
    logger.info("all data cleared — schema intact")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Database management utility")
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Drop all tables and recreate schema (wipes all data)",
    )
    parser.add_argument(
        "--clear",
        action="store_true",
        help="Delete all rows but keep schema intact",
    )
    args = parser.parse_args()

    if args.reset:
        confirm = input("This will wipe all data. Type 'yes' to confirm: ")
        if confirm.strip().lower() == "yes":
            reset_schema()
        else:
            print("aborted")
    elif args.clear:
        confirm = input("This will delete all rows. Type 'yes' to confirm: ")
        if confirm.strip().lower() == "yes":
            clear_data()
        else:
            print("aborted")
    else:
        create_schema()
        logger.info("schema ready")
