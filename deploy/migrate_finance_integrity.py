#!/usr/bin/env python3
"""One-time idempotent migration for finance/order integrity."""
import argparse
import json
import sqlite3
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', default='/var/lib/ovsyannikov-crm/crm.db')
    args = parser.parse_args()
    conn = sqlite3.connect(args.db, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute('pragma foreign_keys=on')
    conn.execute('begin immediate')

    columns = {row[1] for row in conn.execute('pragma table_info(transactions)')}
    if 'idempotency_key' not in columns:
        conn.execute('alter table transactions add column idempotency_key text')
    conn.execute('create unique index if not exists uq_transactions_idempotency on transactions(idempotency_key) where idempotency_key is not null')

    conn.executescript("""
    create trigger if not exists guard_active_transaction_insert
    before insert on transactions
    when new.order_id is null or not exists (
        select 1 from orders where id=new.order_id and deleted_at is null
    )
    begin
        select raise(abort, 'transaction requires an active order');
    end;

    create trigger if not exists guard_active_transaction_update
    before update of order_id,deleted_at on transactions
    when new.deleted_at is null and (
        new.order_id is null or not exists (
            select 1 from orders where id=new.order_id and deleted_at is null
        )
    )
    begin
        select raise(abort, 'transaction requires an active order');
    end;

    create trigger if not exists cascade_order_soft_delete
    after update of deleted_at on orders
    when old.deleted_at is null and new.deleted_at is not null
    begin
        update transactions
        set deleted_at=new.deleted_at, updated_at=new.updated_at,
            updated_by=new.updated_by, version=version+1
        where order_id=new.id and deleted_at is null;
        update order_items
        set deleted_at=new.deleted_at, updated_at=new.updated_at,
            updated_by=new.updated_by, version=version+1
        where order_id=new.id and deleted_at is null;
    end;
    """)

    stamp = now()
    ghost_tx = [dict(row) for row in conn.execute("""
        select t.* from transactions t join orders o on o.id=t.order_id
        where t.deleted_at is null and o.deleted_at is not null
    """)]
    ghost_items = [dict(row) for row in conn.execute("""
        select i.* from order_items i join orders o on o.id=i.order_id
        where i.deleted_at is null and o.deleted_at is not null
    """)]
    for row in ghost_tx:
        deleted_at = conn.execute('select deleted_at from orders where id=?', (row['order_id'],)).fetchone()[0] or stamp
        new = dict(row, deleted_at=deleted_at, updated_at=deleted_at,
                   updated_by='system:integrity-repair', version=(row.get('version') or 1) + 1)
        conn.execute("""insert into audit_log(table_name,row_id,action,old_value,new_value,actor,at)
                        values('transactions',?,'INTEGRITY_DELETE',?,?,?,?)""",
                     (str(row['id']), json.dumps(row, ensure_ascii=False), json.dumps(new, ensure_ascii=False),
                      'system:integrity-repair', stamp))
    conn.execute("""
        update transactions set
          deleted_at=(select o.deleted_at from orders o where o.id=transactions.order_id),
          updated_at=(select o.deleted_at from orders o where o.id=transactions.order_id),
          updated_by='system:integrity-repair', version=version+1
        where deleted_at is null and exists (
          select 1 from orders o where o.id=transactions.order_id and o.deleted_at is not null
        )
    """)
    conn.execute("""
        update order_items set
          deleted_at=(select o.deleted_at from orders o where o.id=order_items.order_id),
          updated_at=(select o.deleted_at from orders o where o.id=order_items.order_id),
          updated_by='system:integrity-repair', version=version+1
        where deleted_at is null and exists (
          select 1 from orders o where o.id=order_items.order_id and o.deleted_at is not null
        )
    """)
    if ghost_tx or ghost_items:
        conn.execute("update app_meta set value=cast(value as integer)+1 where key='revision'")
    conn.commit()

    orphan_count = conn.execute("""
      select count(*) from transactions t left join orders o on o.id=t.order_id
      where t.deleted_at is null and (t.order_id is null or o.id is null or o.deleted_at is not null)
    """).fetchone()[0]
    print(f'cleaned_transactions={len(ghost_tx)}')
    print(f'cleaned_items={len(ghost_items)}')
    print(f'active_orphans={orphan_count}')
    print(f'integrity={conn.execute("pragma integrity_check").fetchone()[0]}')
    conn.close()


if __name__ == '__main__':
    main()
