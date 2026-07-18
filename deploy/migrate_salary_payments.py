#!/usr/bin/env python3
"""Create a durable history table for employee salary payouts."""
import argparse
import sqlite3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/var/lib/ovsyannikov-crm/crm.db")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db, timeout=30)
    conn.execute("pragma foreign_keys=on")
    conn.execute("begin immediate")
    conn.execute("""
        create table if not exists salary_payments(
            id integer primary key,
            employee_key text not null,
            employee_name text not null default 'Оля',
            salary_month text not null,
            date text not null,
            amount real not null,
            note text default '',
            idempotency_key text unique,
            created_at text,
            version integer not null default 1,
            updated_at text,
            deleted_at text,
            created_by text,
            updated_by text
        )
    """)
    conn.execute("create index if not exists idx_salary_payments_month on salary_payments(employee_key,salary_month,date)")
    conn.execute("create unique index if not exists uq_salary_payments_idempotency on salary_payments(idempotency_key) where idempotency_key is not null")
    conn.execute("update app_meta set value=cast(value as integer)+1 where key='revision'")
    conn.commit()
    print(f"salary_payments={conn.execute('select count(*) from salary_payments').fetchone()[0]}")
    print(f"integrity={conn.execute('pragma integrity_check').fetchone()[0]}")
    conn.close()


if __name__ == "__main__":
    main()
