-- Раздел «Продукция»: товары, добавленные владельцем вручную (кнопка «+ Добавить
-- товар»). Появляются в подсказках при создании заказа, даже если ещё не были ни
-- в одном заказе.
create table if not exists product_custom (
    name      text primary key,
    added_at  timestamptz not null default now(),
    added_by  uuid
);
alter table product_custom enable row level security;
drop policy if exists pc_read on product_custom;
create policy pc_read  on product_custom for select to authenticated using (true);
drop policy if exists pc_write on product_custom;
create policy pc_write on product_custom for all    to authenticated using (true) with check (true);
