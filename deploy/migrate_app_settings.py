#!/usr/bin/env python3
"""Create shared CRM settings without overwriting existing values."""
import argparse
import json
import sqlite3
from datetime import datetime, timezone


DEFAULT_COLUMNS = [
    "date", "number", "supplier", "purchase", "sale", "received",
    "remaining", "delivery", "client", "phone", "actions",
]


def now():
    return datetime.now(timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/var/lib/ovsyannikov-crm/crm.db")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db, timeout=30)
    conn.execute("pragma foreign_keys=on")
    conn.execute("begin immediate")
    conn.execute("""
        create table if not exists app_settings(
            id text primary key,
            value text not null,
            version integer not null default 1,
            updated_at text,
            deleted_at text,
            created_by text,
            updated_by text
        )
    """)
    columns = {row[1] for row in conn.execute("pragma table_info(app_settings)")}
    if "deleted_at" not in columns:
        conn.execute("alter table app_settings add column deleted_at text")
    stamp = now()
    defaults = {
        "ola_salary_rates": {"default_rate": 9, "months": {}},
        "orders_columns": {"order": DEFAULT_COLUMNS, "hidden": []},
    }
    for key, value in defaults.items():
        conn.execute(
            "insert or ignore into app_settings(id,value,updated_at,created_by) values(?,?,?,?)",
            (key, json.dumps(value, ensure_ascii=False), stamp, "system:migration"),
        )
    conn.execute("update app_meta set value=cast(value as integer)+1 where key='revision'")
    conn.commit()
    rows = conn.execute("select id,value,version from app_settings order by id").fetchall()
    print(f"settings={len(rows)}")
    print(f"integrity={conn.execute('pragma integrity_check').fetchone()[0]}")
    conn.close()


if __name__ == "__main__":
    main()
