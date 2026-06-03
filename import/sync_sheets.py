#!/usr/bin/env python3
"""
Синхронизация CRM Овсянникова с Google-таблицей через Sheets API.
Тянет лист «Заказы» напрямую (service account), парсит ВСЕ строки с датой
(номер заказа НЕ обязателен — иначе теряются заказы 2023–2026), пишет
data/{orders,clients,suppliers,transactions}.json.

Запуск:  python3 import/sync_sheets.py
"""
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import gspread
from gspread.utils import ValueRenderOption

BASE_DIR = Path(__file__).parent.parent
KEY_FILE = BASE_DIR / 'sanya-498120-cee43b3a5917.json'
SHEET_ID = '1bF10abp_5KjKoE5B2MxmriIrI6zVfqwAyNR7S2Nt1uc'
OUT_DIR  = BASE_DIR / 'data'
OUT_DIR.mkdir(exist_ok=True)

# Excel/Sheets serial date base (lotus 1900 bug => 1899-12-30)
SERIAL_BASE = datetime(1899, 12, 30)

SUPPLIER_ALIASES = {
    'топ хауз': 'топхауз', 'топ хаус': 'топхауз', 'топхауз ': 'топхауз', 'тхут': 'топхауз',
    'века рус': 'века', 'элит-дизайн': 'элит дизайн', 'элитдизайн': 'элит дизайн',
    'цсд ': 'цсд', 'браво ': 'браво',
}

def to_money(v):
    if v is None or v == '':
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace('\xa0', ' ').replace('₽', '').strip()
    if s in ('-', '—', ''):
        return 0.0
    s = s.replace(' ', '').replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return 0.0

def to_date(v):
    """serial number или строка-дата -> 'YYYY-MM-DD'."""
    # 43831 = 2020-01-01; меньше — битые serial-числа (год 1900 и т.п.)
    if isinstance(v, (int, float)) and v >= 43831:
        return (SERIAL_BASE + timedelta(days=int(v))).strftime('%Y-%m-%d')
    if isinstance(v, str):
        m = re.match(r'(\d{4})-(\d{2})-(\d{2})', v.strip())
        if m:
            return v.strip()[:10]
    return None

def fmt_num(v):
    """Номер заказа: целое число -> без .0, иначе строка."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, int):
        return str(v)
    return str(v).strip() if v not in (None, '') else ''

def normalize_phone(v):
    if v is None or v == '':
        return ''
    digits = re.sub(r'\D', '', str(v))
    if len(digits) == 11 and digits.startswith('8'):
        digits = '7' + digits[1:]
    if len(digits) == 10:
        digits = '7' + digits
    if len(digits) != 11:
        return ''
    return f"+7 ({digits[1:4]}) {digits[4:7]}-{digits[7:9]}-{digits[9:11]}"

def normalize_supplier(v):
    if not v:
        return ''
    s = str(v).strip().lower().replace('  ', ' ')
    return SUPPLIER_ALIASES.get(s, s)

def cell(row, i):
    return row[i] if i < len(row) else None

def main():
    if not KEY_FILE.exists():
        sys.exit(f'❌ Нет ключа: {KEY_FILE}')

    print('→ Подключение к Google Sheets…')
    gc = gspread.service_account(filename=str(KEY_FILE))
    sh = gc.open_by_key(SHEET_ID)
    ws = sh.worksheet('Заказы')
    rows = ws.get_values(value_render_option=ValueRenderOption.unformatted)
    print(f'  получено строк: {len(rows)}')

    orders, transactions = [], []
    suppliers_set, clients_map = {}, {}
    next_order_id = next_supplier_id = next_client_id = next_tx_id = 1
    skipped = 0

    # Колонки: 0=№ 1=Дата 2=Номер 3=Поставщик 4=Закупка 5=опл 6=Продажа
    #          7=Получено 8=Осталось 9=Доставлено 10=Имя 11=Телефон 12=Дост 13=Доход
    for row in rows[2:]:
        order_date = to_date(cell(row, 1))
        purchase = to_money(cell(row, 4))
        sale     = to_money(cell(row, 6))
        received = to_money(cell(row, 7))
        client_name = str(cell(row, 10) or '').strip()

        # Берём строку, если есть дата ИЛИ есть содержательные данные
        if not order_date and sale == 0 and purchase == 0 and not client_name:
            skipped += 1
            continue
        if not order_date:
            skipped += 1
            continue

        order_num    = fmt_num(cell(row, 2))
        supplier_raw = normalize_supplier(cell(row, 3))
        paid_sup     = str(cell(row, 5) or '').strip().lower() == 'опл'
        delivered    = 'да' in str(cell(row, 9) or '').strip().lower()
        client_phone = normalize_phone(cell(row, 11))
        notes        = str(cell(row, 14) or '').strip() if len(row) > 14 else ''

        if not client_name:
            client_name = 'Без имени'

        ckey = (client_name.lower(), client_phone)
        if ckey not in clients_map:
            clients_map[ckey] = {
                'id': next_client_id, 'name': client_name, 'phone': client_phone,
                'email': '', 'address': '', 'created_at': order_date,
            }
            next_client_id += 1
        client_id = clients_map[ckey]['id']

        supplier_id = None
        if supplier_raw:
            if supplier_raw not in suppliers_set:
                suppliers_set[supplier_raw] = {
                    'id': next_supplier_id, 'name': supplier_raw,
                    'contact_person': '', 'phone': '', 'email': '',
                }
                next_supplier_id += 1
            supplier_id = suppliers_set[supplier_raw]['id']

        if delivered:
            status = 'closed' if (sale - received) <= 0.01 else 'delivered'
        else:
            status = 'in_progress' if received > 0 else 'new'

        orders.append({
            'id': next_order_id,
            'order_number': order_num or f'ЗК-{next_order_id:05d}',
            'client_id': client_id,
            'status': status,
            'delivery_status': None,
            'created_at': order_date,
            'delivery_date': order_date if delivered else None,
            'notes': notes,
            'items': [{
                'product_name': notes or (f'Заказ у {supplier_raw}' if supplier_raw else 'Материалы'),
                'supplier_id': supplier_id,
                'quantity': 1,
                'purchase_price': purchase,
                'sale_price': sale,
            }],
        })

        if received > 0:
            transactions.append({
                'id': next_tx_id, 'date': order_date, 'type': 'income',
                'entity_type': 'client', 'entity_id': client_id,
                'order_id': next_order_id, 'amount': received,
                'description': 'Оплата клиента',
            })
            next_tx_id += 1
        if paid_sup and purchase > 0 and supplier_id:
            transactions.append({
                'id': next_tx_id, 'date': order_date, 'type': 'expense',
                'entity_type': 'supplier', 'entity_id': supplier_id,
                'order_id': next_order_id, 'amount': purchase,
                'description': f'Оплата поставщику {supplier_raw}',
            })
            next_tx_id += 1

        next_order_id += 1

    suppliers = list(suppliers_set.values())
    clients = list(clients_map.values())
    for s in suppliers:
        s['name'] = s['name'].title()

    meta = {
        'synced_at': datetime.now().isoformat(timespec='seconds'),
        'source': 'Google Sheets API (Baza_Ovsyannikov / Заказы)',
        'orders': len(orders), 'clients': len(clients),
        'suppliers': len(suppliers), 'transactions': len(transactions),
    }
    for name, data in [('orders', orders), ('clients', clients),
                       ('suppliers', suppliers), ('transactions', transactions)]:
        (OUT_DIR / f'{name}.json').write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    (OUT_DIR / 'meta.json').write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')

    print("✓ Синхронизировано:")
    print(f"  Заказов:     {len(orders):>5}")
    print(f"  Клиентов:    {len(clients):>5}")
    print(f"  Поставщиков: {len(suppliers):>5}")
    print(f"  Транзакций:  {len(transactions):>5}")
    print(f"  Пропущено:   {skipped:>5}")
    rev = sum(o['items'][0]['sale_price'] for o in orders)
    prof = sum(o['items'][0]['sale_price'] - o['items'][0]['purchase_price'] for o in orders)
    print(f"  Выручка:     {rev:>13,.0f} ₽".replace(',', ' '))
    print(f"  Прибыль:     {prof:>13,.0f} ₽".replace(',', ' '))

    from collections import Counter
    years = Counter(o['created_at'][:4] for o in orders)
    print("\nПо годам:")
    for y in sorted(years):
        print(f"  {y}: {years[y]}")

if __name__ == '__main__':
    main()
