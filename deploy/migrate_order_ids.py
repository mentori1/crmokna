#!/usr/bin/env python3
"""Remap active orders polluted by historical high test IDs."""
import argparse
import sqlite3


MAX_CRM_ORDER_ID = 99_999_999


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/var/lib/ovsyannikov-crm/crm.db")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("pragma foreign_keys=on")
    conn.execute("begin immediate")
    conn.execute("pragma defer_foreign_keys=on")

    rows = conn.execute(
        "select id from orders where deleted_at is null and id>? order by created_at,id",
        (MAX_CRM_ORDER_ID,),
    ).fetchall()
    next_id = conn.execute(
        "select coalesce(max(id),0)+1 from orders where id between 1 and ?",
        (MAX_CRM_ORDER_ID,),
    ).fetchone()[0]
    mappings = []

    for row in rows:
        old_id = row["id"]
        while conn.execute("select 1 from orders where id=?", (next_id,)).fetchone():
            next_id += 1
        if next_id > MAX_CRM_ORDER_ID:
            raise RuntimeError("No normal CRM order IDs remain")
        # Сначала переносим родительский заказ. Проверка внешних ключей отложена
        # до commit, а триггер платежей уже видит активный заказ с новым ID.
        conn.execute("update orders set id=? where id=?", (next_id, old_id))
        conn.execute("update order_items set order_id=? where order_id=?", (next_id, old_id))
        conn.execute("update transactions set order_id=? where order_id=?", (next_id, old_id))
        conn.execute(
            "update audit_log set row_id=? where table_name='orders' and row_id=?",
            (str(next_id), str(old_id)),
        )
        mappings.append((old_id, next_id))
        next_id += 1

    if mappings:
        conn.execute("update app_meta set value=cast(value as integer)+1 where key='revision'")
    conn.commit()

    foreign_key_errors = conn.execute("pragma foreign_key_check").fetchall()
    integrity = conn.execute("pragma integrity_check").fetchone()[0]
    if foreign_key_errors or integrity != "ok":
        raise RuntimeError(f"database verification failed: fk={foreign_key_errors}, integrity={integrity}")
    if mappings:
        for old_id, new_id in mappings:
            print(f"remapped={old_id}->CRM-{new_id:05d}")
    else:
        print("remapped=none")
    print("foreign_keys=ok")
    print(f"integrity={integrity}")
    conn.close()


if __name__ == "__main__":
    main()
