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
create table transactions(id integer primary key,date text,type text,entity_type text,entity_id integer,order_id integer references orders(id),amount real default 0,description text default '',version integer not null default 1,updated_at text,deleted_at text,created_by text,updated_by text);
create table product_custom(name text primary key,category text);
create table product_hidden(name text primary key);
create table audit_log(id integer primary key autoincrement,table_name text,row_id text,action text,old_value text,new_value text,actor text,at text);
create table users(id text primary key,email text unique,password_hash text not null);
create table sessions(token text primary key,user_id text references users(id),expires_at integer not null);
create table app_meta(key text primary key,value text not null);
insert into app_meta(key,value) values('revision','1');
create index idx_orders_client on orders(client_id);
create index idx_orders_created on orders(created_at);
create index idx_items_order on order_items(order_id);
create index idx_tx_order on transactions(order_id);
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
        for key in ('address_data', 'old_value', 'new_value'):
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
    for table in ('clients','suppliers','orders','order_items','transactions','product_custom','product_hidden','audit_log'):
        insert_rows(conn, table, load(backup / f'{table}.json'))
    password = Path(args.password_file).read_text().strip()
    conn.execute('insert into users(id,email,password_hash) values(?,?,?)', (secrets.token_hex(16), args.email.lower(), encode_password(password)))
    conn.commit()
    for table in ('clients','suppliers','orders','order_items','transactions','product_custom','product_hidden','audit_log'):
        print(f'{table}: {conn.execute(f"select count(*) from {table}").fetchone()[0]}')
    print('integrity:', conn.execute('pragma integrity_check').fetchone()[0])
    conn.close()
    os.chmod(output, 0o600)


if __name__ == '__main__':
    main()
