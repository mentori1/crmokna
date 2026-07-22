#!/usr/bin/env python3
"""Add hidden exact order creation time used for same-day ordering."""
import argparse
import sqlite3
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/var/lib/ovsyannikov-crm/crm.db")
    args = parser.parse_args()
    path = Path(args.db)
    conn = sqlite3.connect(path, timeout=30)
    try:
        conn.execute("pragma foreign_keys=on")
        columns = {row[1] for row in conn.execute("pragma table_info(orders)")}
        if "created_at_time" not in columns:
            conn.execute("alter table orders add column created_at_time text")
        conn.execute(
            "create index if not exists idx_orders_created_time "
            "on orders(created_at,created_at_time,id)"
        )
        conn.commit()
        result = conn.execute("pragma integrity_check").fetchone()[0]
        if result != "ok":
            raise RuntimeError(f"integrity_check: {result}")
        print("created_at_time: ready")
        print("integrity: ok")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
