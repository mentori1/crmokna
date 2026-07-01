-- Раздел «Продукция»: названия товаров, вручную скрытые владельцем из подсказок
-- при создании заказа (мусор, который не поймал авто-фильтр isJunkProductName).
-- Скрытие НЕ трогает исторические заказы — только список автодополнения.
create table if not exists product_hidden (
    name       text primary key,
    hidden_at  timestamptz not null default now(),
    hidden_by  uuid
);
alter table product_hidden enable row level security;
drop policy if exists ph_read on product_hidden;
create policy ph_read  on product_hidden for select to authenticated using (true);
drop policy if exists ph_write on product_hidden;
create policy ph_write on product_hidden for all    to authenticated using (true) with check (true);
