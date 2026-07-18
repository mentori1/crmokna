#!/usr/bin/env python3
"""Create the standalone SQLite database from a JSON backup."""
import argparse
import hashlib
import json
import os
import secrets
import sqlite3
from pathlib import Path


SCHEMA = """
pragma journal_mode=WAL;
pragma synchronous=FULL;
pragma foreign_keys=ON;
create table clients(id integer primary key,name text not null,phone text default '',email text default '',address text default '',address_data text,created_at text,version integer not null default 1,updated_at text,deleted_at text,created_by text,updated_by text);
create table suppliers(id integer primary key,name text not null,contact_person text default '',phone text default '',email text default '',version integer not null default 1,updated_at text,deleted_at text,created_by text,updated_by text);
create table orders(id integer primary key,order_number text,client_id integer references clients(id),status text default 'new',delivery_status text,created_at text,delivery_date text,notes text default '',settled integer default 0,production_number text,production_status text,production_ship_date text,idempotency_key text unique,version integer not null default 1,updated_at text,deleted_at text,created_by text,updated_by text);
create table order_items(id integer primary key autoincrement,order_id integer references orders(id) on delete cascade,product_name text,dimensions text default '',supplier_id integer references suppliers(id),quantity real default 1,purchase_price real default 0,sale_price real default 0,version integer not null default 1,updated_at text,deleted_at text,created_by text,updated_by text);
create table transactions(id integer primary key,date text,type text,entity_type text,entity_id integer,order_id integer not null references orders(id) on delete cascade,amount real default 0,description text default '',idempotency_key text unique,version integer not null default 1,updated_at text,deleted_at text,created_by text,updated_by text);
create table salary_payments(id integer primary key,employee_key text not null,employee_name text not null default 'Оля',salary_month text not null,date text not null,amount real not null,note text default '',idempotency_key text unique,created_at text,version integer not null default 1,updated_at text,deleted_at text,created_by text,updated_by text);
create table product_custom(name text primary key,category text);
create table product_hidden(name text primary key);
create table app_settings(id text primary key,value text not null,version integer not null default 1,updated_at text,deleted_at text,created_by text,updated_by text);
create table audit_log(id integer primary key autoincrement,table_name text,row_id text,action text,old_value text,new_value text,actor text,at text);
create table users(id text primary key,email text unique,password_hash text not null);
create table sessions(token text primary key,user_id text references users(id),expires_at integer not null);
create table app_meta(key text primary key,value text not null);
insert into app_meta(key,value) values('revision','1');
create index idx_orders_client on orders(client_id);
create index idx_orders_created on orders(created_at);
create index idx_items_order on order_items(order_id);
create index idx_tx_order on transactions(order_id);
create unique index uq_transactions_idempotency on transactions(idempotency_key) where idempotency_key is not null;
create index idx_salary_payments_month on salary_payments(employee_key,salary_month,date);
create unique index uq_salary_payments_idempotency on salary_payments(idempotency_key) where idempotency_key is not null;
"""

TRIGGERS = """
create trigger guard_active_transaction_insert before insert on transactions
when new.order_id is null or not exists (select 1 from orders where id=new.order_id and deleted_at is null)
begin select raise(abort, 'transaction requires an active order'); end;
create trigger guard_active_transaction_update before update of order_id,deleted_at on transactions
when new.deleted_at is null and (new.order_id is null or not exists (select 1 from orders where id=new.order_id and deleted_at is null))
begin select raise(abort, 'transaction requires an active order'); end;
create trigger cascade_order_soft_delete after update of deleted_at on orders
when old.deleted_at is null and new.deleted_at is not null
begin
  update transactions set deleted_at=new.deleted_at,updated_at=new.updated_at,updated_by=new.updated_by,version=version+1 where order_id=new.id and deleted_at is null;
  update order_items set deleted_at=new.deleted_at,updated_at=new.updated_at,updated_by=new.updated_by,version=version+1 where order_id=new.id and deleted_at is null;
end;
"""


def encode_password(password):
    salt = secrets.token_bytes(16)
    iterations = 260000
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, iterations).hex()
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest}"


def load(path):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else []


def insert_rows(conn, table, rows):
    columns = {r[1] for r in conn.execute(f'pragma table_info({table})')}
    for row in rows:
        clean = {k: v for k, v in row.items() if k in columns}
        for key in ('address_data', 'value', 'old_value', 'new_value'):
            if key in clean and clean[key] is not None and not isinstance(clean[key], str):
                clean[key] = json.dumps(clean[key], ensure_ascii=False)
        cols = list(clean)
        conn.execute(f"insert into {table} ({','.join(cols)}) values ({','.join('?' for _ in cols)})", [clean[c] for c in cols])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backup', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--email', required=True)
    parser.add_argument('--password-file', required=True)
    args = parser.parse_args()
    backup, output = Path(args.backup), Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    conn = sqlite3.connect(output)
    conn.executescript(SCHEMA)
    for table in ('clients','suppliers','orders','order_items','transactions','salary_payments','product_custom','product_hidden','app_settings','audit_log'):
        insert_rows(conn, table, load(backup / f'{table}.json'))
    conn.execute("insert or ignore into app_settings(id,value) values(?,?)", (
        'ola_salary_rates', json.dumps({'default_rate': 9, 'months': {}}, ensure_ascii=False)))
    conn.execute("insert or ignore into app_settings(id,value) values(?,?)", (
        'orders_columns', json.dumps({
            'order': ['date','number','supplier','purchase','sale','received','remaining','delivery','client','phone','actions'],
            'hidden': [],
        }, ensure_ascii=False)))
    conn.execute("""update transactions set deleted_at=(select o.deleted_at from orders o where o.id=transactions.order_id)
                    where deleted_at is null and exists(select 1 from orders o where o.id=transactions.order_id and o.deleted_at is not null)""")
    conn.execute("""update order_items set deleted_at=(select o.deleted_at from orders o where o.id=order_items.order_id)
                    where deleted_at is null and exists(select 1 from orders o where o.id=order_items.order_id and o.deleted_at is not null)""")
    conn.executescript(TRIGGERS)
    password = Path(args.password_file).read_text().strip()
    conn.execute('insert into users(id,email,password_hash) values(?,?,?)', (secrets.token_hex(16), args.email.lower(), encode_password(password)))
    conn.commit()
    for table in ('clients','suppliers','orders','order_items','transactions','salary_payments','product_custom','product_hidden','app_settings','audit_log'):
        print(f'{table}: {conn.execute(f"select count(*) from {table}").fetchone()[0]}')
    print('integrity:', conn.execute('pragma integrity_check').fetchone()[0])
    conn.close()
    os.chmod(output, 0o600)


if __name__ == '__main__':
    main()
