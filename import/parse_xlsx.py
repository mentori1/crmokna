#!/usr/bin/env python3
"""
Парсер Excel-книги Овсянникова (Baza_Ovsyannikov.xlsx) в формат CRM (JSON).
Преимущество перед CSV: реальные даты с годами (datetime), суммы как числа.
Лист «Заказы» → orders.json, clients.json, suppliers.json, transactions.json.
"""
import json
import re
from datetime import datetime
from pathlib import Path

import openpyxl

XLSX_PATH = Path("/Users/mentori/Downloads/Baza_Ovsyannikov.xlsx")
OUT_DIR   = Path(__file__).parent.parent / "data"
OUT_DIR.mkdir(exist_ok=True)

SUPPLIER_ALIASES = {
    'топ хауз': 'топхауз', 'топ хаус': 'топхауз', 'топхауз ': 'топхауз', 'тхут': 'топхауз',
    'века рус': 'века', 'элит-дизайн': 'элит дизайн', 'элитдизайн': 'элит дизайн',
    'цсд ': 'цсд', 'браво ': 'браво',
}

def to_money(v):
    """Значение ячейки -> float. Числа как есть, строки чистим."""
    if v is None:
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
    """datetime/строка -> 'YYYY-MM-DD'."""
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d')
    return None

def normalize_phone(v):
    if v is None:
        return ''
    digits = re.sub(r'\D', '', str(v))
    if len(digits) == 11 and digits.startswith('8'):
        digits = '7' + digits[1:]
    if len(digits) == 10:
        digits = '7' + digits
    if len(digits) != 11:
        return ''  # мусор ("НЕ ЗАКАЗАН" и т.п.) отбрасываем
    return f"+7 ({digits[1:4]}) {digits[4:7]}-{digits[7:9]}-{digits[9:11]}"

def normalize_supplier(v):
    if not v:
        return ''
    s = str(v).strip().lower().replace('  ', ' ')
    return SUPPLIER_ALIASES.get(s, s)

def main():
    wb = openpyxl.load_workbook(XLSX_PATH, data_only=True, read_only=True)
    ws = wb['Заказы']

    orders, transactions = [], []
    suppliers_set, clients_map = {}, {}
    next_order_id = next_supplier_id = next_client_id = next_tx_id = 1
    skipped = 0

    for row in ws.iter_rows(min_row=3, values_only=True):
        if not row or len(row) < 11:
            continue
        num = row[0]
        if num is None:
            continue
        # №  B-дата  C-номер  D-поставщик  E-закупка  F-опл  G-продажа
        # H-получено  I-осталось  J-доставлено  K-имя  L-телефон  M-дост.  N-доход
        order_date = to_date(row[1])
        if not order_date:
            continue

        # Номер заказа: целые float (4124.0) → "4124", остальное как есть
        if isinstance(row[2], float) and row[2].is_integer():
            order_num = str(int(row[2]))
        elif row[2] is not None:
            order_num = str(row[2]).strip()
        else:
            order_num = ''
        supplier_raw= normalize_supplier(row[3])
        purchase    = to_money(row[4])
        paid_sup    = str(row[5]).strip().lower() == 'опл' if row[5] else False
        sale        = to_money(row[6])
        received    = to_money(row[7])
        delivered   = 'да' in str(row[9]).strip().lower() if row[9] else False
        client_name = str(row[10]).strip() if row[10] is not None else ''
        client_phone= normalize_phone(row[11] if len(row) > 11 else None)
        notes       = str(row[14]).strip() if len(row) > 14 and row[14] else ''

        if not client_name and sale == 0 and purchase == 0:
            skipped += 1
            continue
        if not client_name:
            client_name = 'Без имени'

        # Клиент
        ckey = (client_name.lower(), client_phone)
        if ckey not in clients_map:
            clients_map[ckey] = {
                'id': next_client_id, 'name': client_name, 'phone': client_phone,
                'email': '', 'address': '', 'created_at': order_date,
            }
            next_client_id += 1
        client_id = clients_map[ckey]['id']

        # Поставщик
        supplier_id = None
        if supplier_raw:
            if supplier_raw not in suppliers_set:
                suppliers_set[supplier_raw] = {
                    'id': next_supplier_id, 'name': supplier_raw,
                    'contact_person': '', 'phone': '', 'email': '',
                }
                next_supplier_id += 1
            supplier_id = suppliers_set[supplier_raw]['id']

        # Статус заказа
        if delivered:
            status = 'closed' if (sale - received) <= 0.01 else 'delivered'
        else:
            status = 'in_progress' if received > 0 else 'new'

        orders.append({
            'id': next_order_id,
            'order_number': order_num or f'ЗК-{next_order_id:05d}',
            'client_id': client_id,
            'status': status,
            'delivery_status': None,   # для раздела «Доставка» (заполняется вручную / с почты)
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

    for name, data in [('orders', orders), ('clients', clients),
                       ('suppliers', suppliers), ('transactions', transactions)]:
        (OUT_DIR / f'{name}.json').write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

    print("✓ Импортировано из XLSX (реальные даты):")
    print(f"  Заказов:     {len(orders):>5}")
    print(f"  Клиентов:    {len(clients):>5}")
    print(f"  Поставщиков: {len(suppliers):>5}")
    print(f"  Транзакций:  {len(transactions):>5}")
    print(f"  Пропущено:   {skipped:>5}")
    rev = sum(o['items'][0]['sale_price'] for o in orders)
    prof = sum(o['items'][0]['sale_price'] - o['items'][0]['purchase_price'] for o in orders)
    print(f"  Выручка:     {rev:>12,.0f} ₽".replace(',', ' '))
    print(f"  Прибыль:     {prof:>12,.0f} ₽".replace(',', ' '))

    from collections import Counter
    years = Counter(o['created_at'][:4] for o in orders)
    print("\nПо годам:")
    for y in sorted(years):
        print(f"  {y}: {years[y]}")

if __name__ == '__main__':
    main()
