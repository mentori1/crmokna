#!/usr/bin/env python3
"""End-to-end smoke test for the standalone CRM API."""
import argparse
import json
import urllib.request
import uuid
from http.cookiejar import CookieJar
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--email', default='admin@crm.local')
    parser.add_argument('--password-file', required=True)
    args = parser.parse_args()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def call(path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            args.url.rstrip('/') + path, data=data,
            headers={'Content-Type': 'application/json'},
            method='POST' if body is not None else 'GET',
        )
        with opener.open(request, timeout=60) as response:
            return json.loads(response.read())

    password = Path(args.password_file).read_text().strip()
    session = call('/api/login', {'email': args.email, 'password': password})
    assert session['session']['user']['email'] == args.email
    print('login: ok')

    counts = {}
    first_client = None
    for table in ('clients','suppliers','orders','order_items','transactions','product_custom','product_hidden','audit_log'):
        result = call('/api/query', {'table': table, 'action': 'select', 'limit': 5000})['data']
        counts[table] = len(result)
        if table == 'clients':
            first_client = result[0]['id']
    print('counts:', json.dumps(counts, ensure_ascii=False))

    test_id = 900000000002
    order = {
        'id': test_id, 'order_number': 'SERVER-SMOKE-TEST', 'client_id': first_client,
        'status': 'new', 'created_at': '2026-07-12', 'notes': 'temporary smoke test',
        'settled': False, 'idempotency_key': str(uuid.uuid4()),
    }
    created = call('/api/rpc/create_order', {'order': order, 'items': [{
        'product_name': 'Тестовая позиция', 'quantity': 1,
        'purchase_price': 10, 'sale_price': 20,
    }]})['data']
    assert created == test_id
    print('create_order: ok')

    first = call('/api/query', {'table': 'orders', 'action': 'update',
        'filters': [{'column':'id','op':'eq','value':test_id},{'column':'version','op':'eq','value':1}],
        'values': {'notes':'writer one'}})['data']
    assert first['version'] == 2
    stale = call('/api/query', {'table': 'orders', 'action': 'update',
        'filters': [{'column':'id','op':'eq','value':test_id},{'column':'version','op':'eq','value':1}],
        'values': {'notes':'stale writer two'}})['data']
    assert stale is None
    print('optimistic_lock: ok')

    call('/api/query', {'table':'orders','action':'delete','filters':[{'column':'id','op':'eq','value':test_id}]})
    remaining = call('/api/query', {'table':'orders','action':'select','filters':[{'column':'id','op':'eq','value':test_id}]})['data']
    assert not remaining
    print('cleanup: ok')


if __name__ == '__main__':
    main()
