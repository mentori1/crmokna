-- Приоритет 1 из CRM-LESSONS: служебные поля, оптимистичная блокировка,
-- soft-delete, audit-log, idempotency. Идемпотентный скрипт (можно повторять).

-- 1) Служебные поля на всех таблицах
do $$
declare t text;
begin
  foreach t in array array['clients','suppliers','orders','order_items','transactions'] loop
    execute format('alter table %I add column if not exists version int not null default 1', t);
    execute format('alter table %I add column if not exists updated_at timestamptz not null default now()', t);
    execute format('alter table %I add column if not exists deleted_at timestamptz', t);
    execute format('alter table %I add column if not exists created_by uuid', t);
    execute format('alter table %I add column if not exists updated_by uuid', t);
  end loop;
end $$;

-- 2) Триггер: при UPDATE инкрементит version, обновляет updated_at/updated_by.
--    Приложение НЕ трогает version в payload — только в WHERE (оптим. блокировка).
create or replace function bump_row() returns trigger as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$ language plpgsql;

-- 3) Триггер: проставить создателя при INSERT
create or replace function set_creator() returns trigger as $$
begin
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end $$ language plpgsql;

-- 4) Audit-log (кто/когда/что)
create table if not exists audit_log (
  id          bigserial primary key,
  table_name  text,
  row_id      text,
  action      text,
  old_value   jsonb,
  new_value   jsonb,
  actor       uuid,
  at          timestamptz default now()
);
alter table audit_log enable row level security;
drop policy if exists audit_read on audit_log;
create policy audit_read on audit_log for select to authenticated using (true);

create or replace function audit_row() returns trigger as $$
begin
  insert into audit_log(table_name, row_id, action, old_value, new_value, actor)
  values (
    tg_table_name,
    coalesce(new.id, old.id)::text,
    tg_op,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
    auth.uid()
  );
  return coalesce(new, old);
end $$ language plpgsql;

-- 5) Вешаем триггеры на все таблицы
do $$
declare t text;
begin
  foreach t in array array['clients','suppliers','orders','order_items','transactions'] loop
    execute format('drop trigger if exists t_bump on %I', t);
    execute format('create trigger t_bump before update on %I for each row execute function bump_row()', t);
    execute format('drop trigger if exists t_creator on %I', t);
    execute format('create trigger t_creator before insert on %I for each row execute function set_creator()', t);
    execute format('drop trigger if exists t_audit on %I', t);
    execute format('create trigger t_audit after insert or update or delete on %I for each row execute function audit_row()', t);
  end loop;
end $$;

-- 6) Idempotency-key на создание заказа (защита от дабл-клика)
alter table orders add column if not exists idempotency_key uuid;
create unique index if not exists uq_orders_idemp on orders(idempotency_key) where idempotency_key is not null;

-- 7) Сброс кэша схемы PostgREST (после DDL — иначе новые колонки не видны)
notify pgrst, 'reload schema';
