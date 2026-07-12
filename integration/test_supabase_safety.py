#!/usr/bin/env python3
"""Безопасная проверка RPC создания заказа и optimistic locking.

Все тестовые изменения выполняются внутри транзакции и откатываются.
"""
import json
import urllib.request
from pathlib import Path

BASE = Path(__file__).parent
REF = "piokomyxclpjscddhemr"
TOKEN = (BASE / ".supabase_token").read_text().strip()


def query(sql):
    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=json.dumps({"query": sql}).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": "crm-safety-test/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read() or "[]")


def main():
    rows = query("""
begin;

select create_order(
  jsonb_build_object(
    'id', 900000000001,
    'order_number', 'CODEX-SAFETY-TEST',
    'client_id', (select id from clients order by id limit 1),
    'status', 'new',
    'created_at', current_date,
    'notes', 'rollback safety test',
    'settled', false,
    'idempotency_key', '4ad7e32c-50e4-49ab-8846-92849f680001'
  ),
  jsonb_build_array(jsonb_build_object(
    'product_name', 'Тестовая позиция',
    'quantity', 1,
    'purchase_price', 10,
    'sale_price', 20
  ))
) as created_id;

update orders
set notes = 'writer one'
where id = 900000000001 and version = 1;

with stale_write as (
  update orders
  set notes = 'stale writer two'
  where id = 900000000001 and version = 1
  returning id
)
select
  (select count(*) from orders where id = 900000000001) as order_rows,
  (select count(*) from order_items where order_id = 900000000001) as item_rows,
  (select version from orders where id = 900000000001) as version_after_first_write,
  (select count(*) from stale_write) as stale_writes_accepted;

rollback;
""")
    result = next((row for row in rows if "stale_writes_accepted" in row), None)
    if not result:
        raise SystemExit("✗ База не вернула результат проверки")
    ok = (
        result["order_rows"] == 1
        and result["item_rows"] == 1
        and result["version_after_first_write"] == 2
        and result["stale_writes_accepted"] == 0
    )
    print(json.dumps(result, ensure_ascii=False))
    if not ok:
        raise SystemExit("✗ Проверка конкурентной записи не пройдена")
    print("✓ Заказ и позиция создаются атомарно")
    print("✓ Устаревшая параллельная запись отклоняется")
    print("✓ Тестовые данные откачены транзакцией")


if __name__ == "__main__":
    main()
