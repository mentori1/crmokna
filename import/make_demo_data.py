#!/usr/bin/env python3
"""
Генерирует ДЕМО-данные для публичной демо-версии CRM.
Заменяет реальные имена/телефоны клиентов на выдуманные.
Поставщики и структура (заказы, оплаты, маржа) остаются —
для убедительности демо.

Запуск:  python3 import/make_demo_data.py
Результат: data/orders.json, clients.json, suppliers.json,
           transactions.json — с обфусцированными ПДн.
"""
import json
import random
import re
from pathlib import Path

DATA = Path(__file__).parent.parent / 'data'

# Простые русские ФИО (выдуманные)
FIRST_NAMES_M = ['Александр', 'Андрей', 'Артём', 'Алексей', 'Борис', 'Вадим', 'Виктор',
                 'Владимир', 'Григорий', 'Денис', 'Дмитрий', 'Евгений', 'Игорь', 'Иван',
                 'Илья', 'Кирилл', 'Константин', 'Максим', 'Михаил', 'Никита', 'Николай',
                 'Олег', 'Павел', 'Пётр', 'Роман', 'Сергей', 'Степан', 'Юрий']
FIRST_NAMES_F = ['Александра', 'Анна', 'Анастасия', 'Валентина', 'Виктория', 'Галина',
                 'Дарья', 'Екатерина', 'Елена', 'Ирина', 'Карина', 'Ксения', 'Людмила',
                 'Маргарита', 'Мария', 'Надежда', 'Наталья', 'Оксана', 'Ольга', 'Светлана',
                 'Татьяна', 'Юлия']
LAST_NAMES_M = ['Иванов', 'Смирнов', 'Кузнецов', 'Попов', 'Васильев', 'Петров', 'Соколов',
                'Михайлов', 'Новиков', 'Фёдоров', 'Морозов', 'Волков', 'Алексеев', 'Лебедев',
                'Семёнов', 'Егоров', 'Павлов', 'Козлов', 'Степанов', 'Николаев', 'Орлов',
                'Андреев', 'Макаров', 'Никитин', 'Захаров', 'Зайцев', 'Соловьёв', 'Борисов']
PATRONYMICS_M = ['Александрович', 'Андреевич', 'Алексеевич', 'Викторович', 'Владимирович',
                 'Дмитриевич', 'Иванович', 'Михайлович', 'Николаевич', 'Олегович',
                 'Павлович', 'Петрович', 'Сергеевич', 'Юрьевич']
PATRONYMICS_F = ['Александровна', 'Андреевна', 'Алексеевна', 'Викторовна', 'Владимировна',
                 'Дмитриевна', 'Ивановна', 'Михайловна', 'Николаевна', 'Олеговна',
                 'Павловна', 'Петровна', 'Сергеевна', 'Юрьевна']
COMPANIES = ['ООО «Стройсервис»', 'ИП Кузнецов А.В.', 'ООО «РемСтройГрупп»',
             'ООО «Северстрой»', 'ИП Орлова Н.С.', 'ООО «Атлант»', 'ООО «Прометей-Строй»',
             'ИП Морозов В.К.', 'ООО «Капитал»', 'ИП Соколов А.Н.']

def rand_phone(seed):
    random.seed(seed)
    codes = ['903', '905', '906', '910', '911', '915', '916', '921', '925', '926', '929', '968', '977']
    code = random.choice(codes)
    n = ''.join(str(random.randint(0, 9)) for _ in range(7))
    return f"+7 ({code}) {n[:3]}-{n[3:5]}-{n[5:7]}"

def gen_client_name(seed):
    random.seed(seed)
    if random.random() < 0.08:
        return random.choice(COMPANIES)
    is_female = random.random() < 0.4
    if is_female:
        return f"{random.choice(LAST_NAMES_M)}а {random.choice(FIRST_NAMES_F)} {random.choice(PATRONYMICS_F)}"
    return f"{random.choice(LAST_NAMES_M)} {random.choice(FIRST_NAMES_M)} {random.choice(PATRONYMICS_M)}"

def main():
    print('→ Читаю текущие данные…')
    orders      = json.loads((DATA / 'orders.json').read_text(encoding='utf-8'))
    clients     = json.loads((DATA / 'clients.json').read_text(encoding='utf-8'))
    suppliers   = json.loads((DATA / 'suppliers.json').read_text(encoding='utf-8'))
    transactions = json.loads((DATA / 'transactions.json').read_text(encoding='utf-8'))
    print(f'  заказов: {len(orders)}, клиентов: {len(clients)}, поставщиков: {len(suppliers)}, транзакций: {len(transactions)}')

    # 1. Подменяем клиентов
    print('→ Генерирую демо-клиентов…')
    for c in clients:
        seed = c['id'] * 31 + 7
        c['name'] = gen_client_name(seed)
        if c.get('phone'):
            c['phone'] = rand_phone(seed + 1)
        c['email'] = ''
        c['address'] = ''
    print(f'  ✓ {len(clients)} клиентов обновлены')

    # 2. Поставщики оставляем — это публичные бренды (Века, Топхауз, Феррони и т.д.)
    print('  ✓ Поставщики — публичные бренды, оставлены как есть')

    # 3. Заказы — обновляем примечания (там могли быть личные данные)
    print('→ Чищу примечания заказов…')
    for o in orders:
        # Примечания (notes) могли содержать имена/адреса — обнуляем
        o['notes'] = ''

    # 4. Транзакции — описания оставляем (типа «Оплата клиента»), они безличные
    print('  ✓ Транзакции — безличные описания, не трогаем')

    # 5. Сохраняем
    print('→ Сохраняю demo-данные…')
    for name, data in [('orders', orders), ('clients', clients),
                       ('suppliers', suppliers), ('transactions', transactions)]:
        (DATA / f'{name}.json').write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

    print('✓ Готово. Текущие data/*.json — теперь ДЕМО.')
    print('  Чтобы вернуть реальные — запустите: python3 import/sync_sheets.py')
    print()
    print('  Пример демо-клиентов:')
    for c in clients[:5]:
        print(f'    {c["name"]:<45} {c.get("phone","")}')

if __name__ == '__main__':
    main()
