#!/usr/bin/env python3
"""
§3.2 — Логический бэкап Supabase в отдельное хранилище.
Выгружает все таблицы через PostgREST (service_role) в JSON-файлы
с ротацией. Можно ставить в cron (например, ежедневно).

Запуск:  python3 integration/backup_supabase.py
Куда:    ~/mentori-backups/ovsyannikov-crm/<дата>/  (вне репозитория)
Ротация: хранит последние 30 папок.
"""
import json
import shutil
import urllib.request
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).parent
REF = "piokomyxclpjscddhemr"
SR_KEY = (BASE / ".sr_key").read_text().strip()
PROJECT_URL = f"https://{REF}.supabase.co"
OUT_ROOT = Path.home() / "mentori-backups" / "ovsyannikov-crm"
KEEP = 30
TABLES = ["clients", "suppliers", "orders", "order_items", "transactions", "audit_log"]

def fetch_all(table):
    rows, frm, size = [], 0, 1000
    while True:
        url = f"{PROJECT_URL}/rest/v1/{table}?select=*&order=id.asc&offset={frm}&limit={size}"
        req = urllib.request.Request(url, headers={
            "apikey": SR_KEY, "Authorization": f"Bearer {SR_KEY}",
            "User-Agent": "crm-backup/1.0",
        })
        with urllib.request.urlopen(req, timeout=120) as r:
            batch = json.loads(r.read())
        rows += batch
        if len(batch) < size:
            break
        frm += size
    return rows

def main():
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    out = OUT_ROOT / stamp
    out.mkdir(parents=True, exist_ok=True)
    total = 0
    for t in TABLES:
        try:
            rows = fetch_all(t)
        except Exception as e:
            print(f"  ✗ {t}: {e}")
            continue
        (out / f"{t}.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        total += len(rows)
        print(f"  ✓ {t}: {len(rows)}")
    (out / "meta.json").write_text(json.dumps(
        {"at": stamp, "tables": TABLES, "total_rows": total}, ensure_ascii=False, indent=1))
    print(f"✓ Бэкап: {out}  ({total} строк)")

    # Ротация: оставляем последние KEEP папок
    dirs = sorted([d for d in OUT_ROOT.iterdir() if d.is_dir()])
    for old in dirs[:-KEEP]:
        shutil.rmtree(old, ignore_errors=True)
        print(f"  удалён старый бэкап: {old.name}")

if __name__ == "__main__":
    main()
