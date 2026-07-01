-- Атомарное создание заказа + позиций (в одной транзакции).
-- idempotency_key защищает от дабл-клика: повтор вернёт существующий id.
create or replace function create_order(p_order jsonb, p_items jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare oid bigint;
begin
  insert into orders (id, order_number, client_id, status, delivery_status,
                      created_at, delivery_date, notes, settled, idempotency_key)
  values (
    (p_order->>'id')::bigint,
    p_order->>'order_number',
    (p_order->>'client_id')::bigint,
    coalesce(p_order->>'status','new'),
    p_order->>'delivery_status',
    (p_order->>'created_at')::date,
    nullif(p_order->>'delivery_date','')::date,
    coalesce(p_order->>'notes',''),
    coalesce((p_order->>'settled')::boolean, false),
    nullif(p_order->>'idempotency_key','')::uuid
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into oid;

  if oid is null then      -- дубль по idempotency_key → вернуть существующий
    select id into oid from orders
      where idempotency_key = nullif(p_order->>'idempotency_key','')::uuid;
    return oid;
  end if;

  insert into order_items (order_id, product_name, dimensions, supplier_id,
                           quantity, purchase_price, sale_price)
  select oid, i->>'product_name', coalesce(i->>'dimensions',''),
         nullif(i->>'supplier_id','')::bigint,
         coalesce((i->>'quantity')::numeric, 1),
         coalesce((i->>'purchase_price')::numeric, 0),
         coalesce((i->>'sale_price')::numeric, 0)
  from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) i;

  return oid;
end $$;

notify pgrst, 'reload schema';
