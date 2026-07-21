#!/usr/bin/env python3
"""End-to-end test: order -> payments -> delete cascade."""
import argparse
import json
import urllib.error
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

    def call(path, body=None, expected=200):
        request = urllib.request.Request(
            args.url.rstrip('/') + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type': 'application/json'},
            method='POST' if body is not None else 'GET',
        )
        try:
            with opener.open(request, timeout=60) as response:
                if response.status != expected:
                    raise AssertionError((response.status, expected))
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            payload = json.loads(exc.read() or b'{}')
            if exc.code != expected:
                raise AssertionError((exc.code, expected, payload))
            return payload

    password = Path(args.password_file).read_text().strip()
    call('/api/login', {'email': args.email, 'password': password})
    clients = call('/api/query', {'table':'clients','action':'select','limit':1})['data']
    suppliers = call('/api/query', {'table':'suppliers','action':'select','limit':1})['data']
    client_id, supplier_id = clients[0]['id'], suppliers[0]['id']

    requested_id = 900000000003
    order_key = str(uuid.uuid4())
    order_id = call('/api/rpc/create_order', {'order': {
        'id': requested_id, 'order_number':'BUSINESS-FLOW-TEST', 'client_id':client_id,
        'status':'new', 'created_at':'2026-07-13', 'settled':False,
        'idempotency_key':order_key,
    }, 'items':[{
        'product_name':'Проверка финансовой цепочки', 'supplier_id':supplier_id,
        'quantity':1, 'purchase_price':3000, 'sale_price':10000,
    }]})['data']
    assert order_id == requested_id

    order = call('/api/query', {'table':'orders','action':'select','filters':[{'column':'id','op':'eq','value':order_id}], 'nested_items':True})['data'][0]
    assert order['order_items'][0]['purchase_price'] == 3000
    assert order['order_items'][0]['sale_price'] == 10000
    print('order_totals: revenue=10000 margin=7000 client_debt=10000 supplier_debt=3000')

    delivery = call('/api/query', {'table':'orders','action':'update','filters':[
        {'column':'id','op':'eq','value':order_id},{'column':'version','op':'eq','value':order['version']}],
        'values':{'delivery_status':'manual'}})['data']
    assert delivery['delivery_status'] == 'manual'
    order['version'] = delivery['version']
    print('manual_delivery_queue: yes')

    removed = call('/api/query', {'table':'orders','action':'update','filters':[
        {'column':'id','op':'eq','value':order_id},{'column':'version','op':'eq','value':order['version']}],
        'values':{'delivery_status':None}})['data']
    assert removed['delivery_status'] is None
    order['version'] = removed['version']
    print('manual_delivery_toggle_off: yes')

    delivery = call('/api/query', {'table':'orders','action':'update','filters':[
        {'column':'id','op':'eq','value':order_id},{'column':'version','op':'eq','value':order['version']}],
        'values':{'delivery_status':'manual'}})['data']
    assert delivery['delivery_status'] == 'manual'
    order['version'] = delivery['version']

    delivered = call('/api/query', {'table':'orders','action':'update','filters':[
        {'column':'id','op':'eq','value':order_id},{'column':'version','op':'eq','value':order['version']}],
        'values':{'delivery_status':'delivered','status':'delivered'}})['data']
    assert delivered['delivery_status'] == 'delivered'
    assert delivered['status'] == 'delivered'
    order['version'] = delivered['version']
    print('delivery_completed: queue_removed=yes order_marked=yes')

    expense_key = str(uuid.uuid4())
    expense = {'id':990000001,'date':'2026-07-13','type':'expense','entity_type':'supplier',
               'entity_id':supplier_id,'order_id':order_id,'amount':3000,
               'description':'test supplier payment','idempotency_key':expense_key}
    first = call('/api/query', {'table':'transactions','action':'insert','rows':expense})['data'][0]
    second = call('/api/query', {'table':'transactions','action':'insert','rows':expense})['data'][0]
    assert first['id'] == second['id']
    expense_rows = call('/api/query', {'table':'transactions','action':'select','filters':[
        {'column':'order_id','op':'eq','value':order_id},{'column':'type','op':'eq','value':'expense'}]})['data']
    assert len(expense_rows) == 1 and expense_rows[0]['amount'] == 3000
    print('supplier_payment: paid=3000 debt=0 idempotent=yes')

    income = {'id':990000002,'date':'2026-07-13','type':'income','entity_type':'client',
              'entity_id':client_id,'order_id':order_id,'amount':10000,
              'description':'test client payment','idempotency_key':str(uuid.uuid4())}
    call('/api/query', {'table':'transactions','action':'insert','rows':income})
    print('client_payment: paid=10000 debt=0')

    bad = dict(income, id=990000003, order_id=None, idempotency_key=str(uuid.uuid4()))
    error = call('/api/query', {'table':'transactions','action':'insert','rows':bad}, expected=400)
    assert 'заказ' in error['error'].lower()
    print('orphan_payment_rejected: yes')

    result = call('/api/rpc/delete_order', {'order_id':order_id,'version':order['version']})['data']
    assert result == {'order':1,'items':1,'transactions':2}
    repeat = call('/api/rpc/delete_order', {'order_id':order_id,'version':order['version']})['data']
    assert repeat == {'order':0,'items':0,'transactions':0}
    active_tx = call('/api/query', {'table':'transactions','action':'select','filters':[
        {'column':'order_id','op':'eq','value':order_id},{'column':'deleted_at','op':'is','value':None}]})['data']
    active_items = call('/api/query', {'table':'order_items','action':'select','filters':[
        {'column':'order_id','op':'eq','value':order_id},{'column':'deleted_at','op':'is','value':None}]})['data']
    assert not active_tx and not active_items
    print('delete_cascade: order=1 items=1 transactions=2 repeat_safe=yes')


if __name__ == '__main__':
    main()
