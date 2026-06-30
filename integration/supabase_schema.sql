-- Схема CRM «Центр окон и дверей» для Supabase (PostgreSQL)
-- Реляционная модель под текущие данные CRM.

drop table if exists transactions cascade;
drop table if exists order_items cascade;
drop table if exists orders cascade;
drop table if exists clients cascade;
drop table if exists suppliers cascade;

create table clients (
    id          bigint primary key,
    name        text not null,
    phone       text default '',
    email       text default '',
    address     text default '',
    created_at  date
);

create table suppliers (
    id             bigint primary key,
    name           text not null,
    contact_person text default '',
    phone          text default '',
    email          text default ''
);

create table orders (
    id                bigint primary key,
    order_number      text,
    client_id         bigint references clients(id),
    status            text default 'new',
    delivery_status   text,
    created_at        date,
    delivery_date     date,
    notes             text default '',
    settled           boolean default false,
    production_number text,
    production_status text,
    production_ship_date date
);

create table order_items (
    id             bigserial primary key,
    order_id       bigint references orders(id) on delete cascade,
    product_name   text,
    dimensions     text default '',
    supplier_id    bigint references suppliers(id),
    quantity       numeric default 1,
    purchase_price numeric default 0,
    sale_price     numeric default 0
);

create table transactions (
    id          bigint primary key,
    date        date,
    type        text,         -- income | expense
    entity_type text,         -- client | supplier
    entity_id   bigint,
    order_id    bigint references orders(id),
    amount      numeric default 0,
    description text default ''
);

create index idx_orders_client     on orders(client_id);
create index idx_orders_created     on orders(created_at);
create index idx_order_items_order  on order_items(order_id);
create index idx_tx_order           on transactions(order_id);
create index idx_tx_entity          on transactions(entity_type, entity_id);
