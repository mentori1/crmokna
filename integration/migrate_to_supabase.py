#!/usr/bin/env python3
"""
Перенос данных CRM в Supabase.
- создаёт схему (Management API),
- применяет те же правила, что и фронт (архив старых заказов, удаление мусорных клиентов),
- заливает данные через PostgREST (service_role).

Запуск: python3 integration/migrate_to_supabase.py
Источники секретов (вне git): integration/.supabase_token, integration/.sr_key
"""
import json
import sys
import urllib.request
from pathlib import Path

BASE = Path(__file__).parent
ROOT = BASE.parent
REF = "piokomyxclpjscddhemr"
TOKEN = (BASE / ".supabase_token").read_text().strip()
SR_KEY = (BASE / ".sr_key").read_text().strip()
PROJECT_URL = f"https://{REF}.supabase.co"
ARCHIVE_BEFORE = "2026-04-01"
JUNK_NAMES = {"", "без имени", "в офис", "офис", "продажа", "продажа офис", "склад", "-", "—"}
DATA = ROOT / "data_real_backup"

def mgmt_query(sql):
    """Выполнить SQL через Supabase Management API."""
    body = json.dumps({"query": sql}).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=body, method="POST",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", "User-Agent": "crm-migrator/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or "[]")

def rest_insert(table, rows):
    """Bulk insert в таблицу через PostgREST (service_role обходит RLS)."""
    if not rows:
        return
    body = json.dumps(rows, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{PROJECT_URL}/rest/v1/{table}",
        data=body, method="POST",
        headers={
            "apikey": SR_KEY,
            "Authorization": f"Bearer {SR_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
            "User-Agent": "crm-migrator/1.0",
        })
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status
    except urllib.error.HTTPError as e:
        print(f"  ✗ {table}: HTTP {e.code} — {e.read().decode()[:300]}", file=sys.stderr)
        raise

def batched(rows, n=500):
    for i in range(0, len(rows), n):
        yield rows[i:i + n]

def load(name):
    return json.loads((DATA / f"{name}.json").read_text(encoding="utf-8"))

def main():
    print("→ Создаю схему…")
    schema = (BASE / "supabase_schema.sql").read_text(encoding="utf-8")
    mgmt_query(schema)
    tables = mgmt_query(
        "select table_name from information_schema.tables "
        "where table_schema='public' order by table_name")
    print("  таблицы:", [t["table_name"] for t in tables])

    print("→ Готовлю данные (правила архива/чистки)…")
    clients = load("clients")
    suppliers = load("suppliers")
    orders = load("orders")
    transactions = load("transactions")

    # Правило: удалить мусорных клиентов (без телефона и имени)
    def junk(c):
        if (c.get("phone") or "").strip():
            return False
        n = (c.get("name") or "").strip().lower()
        return n in JUNK_NAMES or len(n) < 3
    clients = [c for c in clients if not junk(c)]
    client_ids = {c["id"] for c in clients}

    # Правило: заказы до апреля → closed + settled
    for o in orders:
        if o.get("created_at") and o["created_at"] < ARCHIVE_BEFORE:
            o["status"] = "closed"
            o["settled"] = True

    # Разворачиваем items в отдельную таблицу order_items
    order_rows, item_rows = [], []
    for o in orders:
        cid = o.get("client_id")
        order_rows.append({
            "id": o["id"], "order_number": o.get("order_number"),
            "client_id": cid if cid in client_ids else None,
            "status": o.get("status", "new"),
            "delivery_status": o.get("delivery_status"),
            "created_at": o.get("created_at"),
            "delivery_date": o.get("delivery_date"),
            "notes": o.get("notes", ""), "settled": bool(o.get("settled")),
            "production_number": o.get("production_number"),
            "production_status": o.get("production_status"),
            "production_ship_date": o.get("production_ship_date"),
        })
        for it in o.get("items", []):
            item_rows.append({
                "order_id": o["id"], "product_name": it.get("product_name"),
                "dimensions": it.get("dimensions", ""),
                "supplier_id": it.get("supplier_id"),
                "quantity": it.get("quantity", 1),
                "purchase_price": it.get("purchase_price", 0),
                "sale_price": it.get("sale_price", 0),
            })

    # Транзакции — только по существующим заказам
    order_ids = {o["id"] for o in orders}
    tx_rows = [{
        "id": t["id"], "date": t.get("date"), "type": t.get("type"),
        "entity_type": t.get("entity_type"), "entity_id": t.get("entity_id"),
        "order_id": t.get("order_id") if t.get("order_id") in order_ids else None,
        "amount": t.get("amount", 0), "description": t.get("description", ""),
    } for t in transactions]

    client_rows = [{
        "id": c["id"], "name": c["name"], "phone": c.get("phone", ""),
        "email": c.get("email", ""), "address": c.get("address", ""),
        "created_at": c.get("created_at"),
    } for c in clients]
    supplier_rows = [{
        "id": s["id"], "name": s["name"], "contact_person": s.get("contact_person", ""),
        "phone": s.get("phone", ""), "email": s.get("email", ""),
    } for s in suppliers]

    print(f"  клиентов: {len(client_rows)}, поставщиков: {len(supplier_rows)}, "
          f"заказов: {len(order_rows)}, позиций: {len(item_rows)}, транзакций: {len(tx_rows)}")

    print("→ Заливаю (порядок: clients, suppliers, orders, order_items, transactions)…")
    for table, rows in [("clients", client_rows), ("suppliers", supplier_rows),
                        ("orders", order_rows), ("order_items", item_rows),
                        ("transactions", tx_rows)]:
        done = 0
        for chunk in batched(rows):
            rest_insert(table, chunk)
            done += len(chunk)
            print(f"  {table}: {done}/{len(rows)}", end="\r")
        print(f"  ✓ {table}: {len(rows)} строк            ")

    # Проверка
    print("→ Проверка количества строк в Supabase:")
    for t in ["clients", "suppliers", "orders", "order_items", "transactions"]:
        r = mgmt_query(f"select count(*) as n from {t}")
        print(f"  {t}: {r[0]['n']}")
    print("✓ Перенос завершён.")

if __name__ == "__main__":
    main()
