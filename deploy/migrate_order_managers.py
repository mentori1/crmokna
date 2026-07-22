#!/usr/bin/env python3
"""Add business attribution of orders to Sasha or Olya."""
import argparse
import sqlite3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/var/lib/ovsyannikov-crm/crm.db")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db, timeout=30)
    conn.execute("pragma foreign_keys=on")
    conn.execute("begin immediate")
    columns = {row[1] for row in conn.execute("pragma table_info(orders)")}
    if "manager_key" not in columns:
        conn.execute("alter table orders add column manager_key text")
    conn.execute("create index if not exists idx_orders_manager on orders(manager_key)")
    conn.execute("update app_meta set value=cast(value as integer)+1 where key='revision'")
    conn.commit()
    assigned = conn.execute("select count(*) from orders where manager_key in ('sasha','olya')").fetchone()[0]
    unassigned = conn.execute("select count(*) from orders where manager_key is null").fetchone()[0]
    print("manager_key=ready")
    print(f"assigned={assigned}")
    print(f"unassigned={unassigned}")
    print(f"integrity={conn.execute('pragma integrity_check').fetchone()[0]}")
    conn.close()


if __name__ == "__main__":
    main()
