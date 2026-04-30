from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.db.database import create_schema, get_db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


def reset_schema() -> None:
    """Drop app tables. Destructive: use only when you want an empty database."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DROP TABLE IF EXISTS
                    domains,
                    vectors,
                    chunks,
                    repos
                CASCADE
                """
            )
    logger.info("dropped existing app tables")


def main() -> None:
    parser = argparse.ArgumentParser(description="Initialize the ChizuCode Postgres schema.")
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Drop existing app tables before recreating them.",
    )
    args = parser.parse_args()

    if args.reset:
        reset_schema()

    create_schema()
    logger.info("database schema ready")


if __name__ == "__main__":
    main()
