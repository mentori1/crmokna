#!/usr/bin/env python3
"""
Парсер Google-таблицы Овсянникова в формат CRM (JSON).
Входной CSV → orders.json, clients.json, suppliers.json, transactions.json.
"""
import csv
import json
import re
import sys
from pathlib import Path
from datetime import date

CSV_PATH = Path("/Users/mentori/Downloads/Baza_Ovsyannikov - Заказы.csv")
OUT_DIR  = Path(__file__).parent.parent / "data"
OUT_DIR.mkdir(exist_ok=True)

# Месяцы для парсинга русских дат
MONTHS = {
    'янв': 1, 'фев': 2, 'мар': 3, 'апр': 4, 'мая': 5, 'май': 5,
    'июн': 6, 'июл': 7, 'авг': 8, 'сен': 9, 'окт': 10, 'ноя': 11, 'дек': 12
}

def parse_money(s):
    """'  1 378,00 ₽ ' -> 1378.0 ; '-' / '' -> 0"""
    if not s:
        return 0.0
    s = s.replace('\xa0', ' ').replace('₽', '').strip()
    if s in ('-', '—', ''):
        return 0.0
    # Убираем пробелы (разделители тысяч) и заменяем запятую на точку
    s = s.replace(' ', '').replace(',', '.')
    # На случай если после уборки остался только '-'
    if s in ('-', ''):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0

def parse_date(s, current_year):
    """'4 мая' -> '2024-05-04' (год берётся из контекста)"""
    if not s:
        return None
    s = s.strip().lower().replace('.', '')
    m = re.match(r'(\d+)\s+([а-яё]+)', s)
    if not m:
        return None
    day = int(m.group(1))
    month_name = m.group(2)[:3]
    month = MONTHS.get(month_name)
    if not month:
        return None
    try:
        return f"{current_year}-{month:02d}-{day:02d}"
    except ValueError:
        return None

def normalize_phone(s):
    """Нормализация телефона до +7XXXXXXXXXX"""
    if not s:
        return ''
    digits = re.sub(r'\D', '', s)
    if len(digits) == 11 and digits.startswith('8'):
        digits = '7' + digits[1:]
    if len(digits) == 10:
        digits = '7' + digits
    if len(digits) != 11:
        return ''  # мусор в поле телефона (напр. "НЕ ЗАКАЗАН") — отбрасываем
    return f"+7 ({digits[1:4]}) {digits[4:7]}-{digits[7:9]}-{digits[9:11]}"

SUPPLIER_ALIASES = {
    'топ хауз': 'топхауз',
    'топхауз ': 'топхауз',
    'века рус': 'века',
    'элит-дизайн': 'элит дизайн',
    'элитдизайн': 'элит дизайн',
    'тхут': 'топхауз',
    'цсд ': 'цсд',
    'браво ': 'браво',
}

def normalize_supplier(s):
    if not s:
        return ''
    s = s.strip().lower().replace('  ', ' ')
    return SUPPLIER_ALIASES.get(s, s)

def normalize_client(s):
    if not s:
        return ''
    return s.strip()

def main():
    raw_rows = []
    with CSV_PATH.open(encoding='utf-8') as f:
        reader = csv.reader(f)
        for i, row in enumerate(reader):
            raw_rows.append(row)

    # Структура CSV:
    # row[0]=№, row[1]=Дата, row[2]=Номер, row[3]=Поставщик, row[4]=Закупка,
    # row[5]=опл, row[6]=Продажа, row[7]=Получено, row[8]=Осталось,
    # row[9]=Доставлено, row[10]=Имя, row[11]=Телефон, row[12]=Стоимость доставки,
    # row[13]=Доход, row[14]=Примечание

    # Определяем текущий год — нумерация даты идёт по нарастающей,
    # при переходе через декабрь -> январь увеличиваем год.
    # Начальный год — 2021 (по контексту таблицы).
    current_year = 2021
    last_month = 0

    orders = []
    suppliers_set = {}     # name -> id
    clients_map = {}       # (name_lower, phone) -> id
    next_order_id = 1
    next_supplier_id = 1
    next_client_id = 1
    transactions = []
    next_tx_id = 1

    skipped = 0

    for row in raw_rows[2:]:  # пропускаем шапку
        # фильтр пустых строк
        if len(row) < 11:
            continue
        num = row[0].strip()
        if not num or not num.isdigit():
            continue
        date_str = row[1].strip()
        if not date_str:
            continue

        # Парсим дату с отслеживанием года
        parsed = parse_date(date_str, current_year)
        if parsed:
            month = int(parsed[5:7])
            # Если месяц меньше предыдущего — наступил новый год
            if last_month and month < last_month - 6:  # переход через год
                current_year += 1
                parsed = parse_date(date_str, current_year)
            last_month = month
        if not parsed:
            skipped += 1
            continue

        order_num = row[2].strip()
        supplier_raw = normalize_supplier(row[3])
        purchase = parse_money(row[4])
        paid_supplier_flag = row[5].strip().lower() == 'опл'
        sale = parse_money(row[6])
        received = parse_money(row[7])
        delivered_flag = 'да' in row[9].strip().lower() if len(row) > 9 else False
        client_name = normalize_client(row[10]) if len(row) > 10 else ''
        client_phone = normalize_phone(row[11]) if len(row) > 11 else ''
        income = parse_money(row[13]) if len(row) > 13 else 0
        notes = row[14].strip() if len(row) > 14 else ''

        # Пропускаем строки, где нет ни клиента, ни сумм
        if not client_name and sale == 0 and purchase == 0:
            skipped += 1
            continue

        # Регистрируем клиента
        if not client_name:
            client_name = 'Без имени'
        client_key = (client_name.lower(), client_phone)
        if client_key not in clients_map:
            clients_map[client_key] = {
                'id': next_client_id,
                'name': client_name,
                'phone': client_phone,
                'email': '',
                'address': '',
                'created_at': parsed,
            }
            next_client_id += 1
        client_id = clients_map[client_key]['id']

        # Регистрируем поставщика
        supplier_id = None
        if supplier_raw:
            if supplier_raw not in suppliers_set:
                suppliers_set[supplier_raw] = {
                    'id': next_supplier_id,
                    'name': supplier_raw,
                    'contact_person': '',
                    'phone': '',
                    'email': '',
                }
                next_supplier_id += 1
            supplier_id = suppliers_set[supplier_raw]['id']

        # Определяем статус заказа
        if delivered_flag:
            debt_client = sale - received
            if debt_client <= 0.01:
                status = 'closed'
            else:
                status = 'delivered'
        else:
            if received > 0:
                status = 'in_progress'
            else:
                status = 'new'

        order = {
            'id': next_order_id,
            'order_number': order_num or f'ЗК-{next_order_id:05d}',
            'client_id': client_id,
            'status': status,
            'created_at': parsed,
            'delivery_date': parsed if delivered_flag else None,
            'notes': notes,
            'items': [{
                'product_name': f'Заказ у {supplier_raw}' if supplier_raw else 'Прочие материалы',
                'supplier_id': supplier_id,
                'quantity': 1,
                'purchase_price': purchase,
                'sale_price': sale,
            }],
        }
        orders.append(order)

        # Транзакции
        if received > 0:
            transactions.append({
                'id': next_tx_id,
                'date': parsed,
                'type': 'income',
                'entity_type': 'client',
                'entity_id': client_id,
                'order_id': next_order_id,
                'amount': received,
                'description': 'Оплата клиента',
            })
            next_tx_id += 1
        if paid_supplier_flag and purchase > 0 and supplier_id:
            transactions.append({
                'id': next_tx_id,
                'date': parsed,
                'type': 'expense',
                'entity_type': 'supplier',
                'entity_id': supplier_id,
                'order_id': next_order_id,
                'amount': purchase,
                'description': f'Оплата поставщику {supplier_raw}',
            })
            next_tx_id += 1

        next_order_id += 1

    # Финализируем коллекции
    suppliers = list(suppliers_set.values())
    clients = list(clients_map.values())

    # Аккуратные названия поставщиков
    for s in suppliers:
        s['name'] = s['name'].title()

    # Сохраняем JSON
    (OUT_DIR / 'orders.json').write_text(
        json.dumps(orders, ensure_ascii=False, indent=2), encoding='utf-8')
    (OUT_DIR / 'clients.json').write_text(
        json.dumps(clients, ensure_ascii=False, indent=2), encoding='utf-8')
    (OUT_DIR / 'suppliers.json').write_text(
        json.dumps(suppliers, ensure_ascii=False, indent=2), encoding='utf-8')
    (OUT_DIR / 'transactions.json').write_text(
        json.dumps(transactions, ensure_ascii=False, indent=2), encoding='utf-8')

    # Статистика
    print(f"✓ Импортировано:")
    print(f"  Заказов:     {len(orders):>5}")
    print(f"  Клиентов:    {len(clients):>5}")
    print(f"  Поставщиков: {len(suppliers):>5}")
    print(f"  Транзакций:  {len(transactions):>5}")
    print(f"  Пропущено:   {skipped:>5}")

    total_revenue = sum(o['items'][0]['sale_price'] for o in orders)
    total_profit  = sum(o['items'][0]['sale_price'] - o['items'][0]['purchase_price'] for o in orders)
    print(f"  Выручка:     {total_revenue:>12,.0f} ₽".replace(',', ' '))
    print(f"  Прибыль:     {total_profit:>12,.0f} ₽".replace(',', ' '))

    # Топ-5 поставщиков по заказам
    sup_count = {}
    for o in orders:
        sid = o['items'][0]['supplier_id']
        if sid:
            sup_count[sid] = sup_count.get(sid, 0) + 1
    print(f"\nТоп-10 поставщиков:")
    sup_by_id = {s['id']: s for s in suppliers}
    for sid, cnt in sorted(sup_count.items(), key=lambda x: -x[1])[:10]:
        print(f"  {sup_by_id[sid]['name']:<25} {cnt} заказов")

if __name__ == '__main__':
    main()
