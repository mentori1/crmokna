-- ============================================================
-- CRM «СтройОкна» — Схема базы данных (PostgreSQL)
-- ============================================================

-- ─── Справочники ──────────────────────────────────────────────

CREATE TABLE clients (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    phone           TEXT NOT NULL,
    email           TEXT,
    address         TEXT,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE suppliers (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    contact_person  TEXT,
    phone           TEXT,
    email           TEXT,
    address         TEXT,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE product_categories (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    parent_id       INT REFERENCES product_categories(id)
);

CREATE TABLE products (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    sku             TEXT UNIQUE,
    category_id     INT REFERENCES product_categories(id),
    unit            TEXT DEFAULT 'шт',
    purchase_price  NUMERIC(12,2) DEFAULT 0,
    sale_price      NUMERIC(12,2) DEFAULT 0,
    description     TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── Заказы ───────────────────────────────────────────────────

CREATE TYPE order_status AS ENUM (
    'new',
    'in_progress',
    'ordered_from_supplier',
    'received_at_warehouse',
    'delivering',
    'delivered',
    'closed'
);

CREATE TABLE orders (
    id                  SERIAL PRIMARY KEY,
    order_number        TEXT UNIQUE NOT NULL,
    client_id           INT NOT NULL REFERENCES clients(id),
    status              order_status DEFAULT 'new',
    delivery_date       DATE,
    delivery_address    TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE order_items (
    id              SERIAL PRIMARY KEY,
    order_id        INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id      INT REFERENCES products(id),
    supplier_id     INT REFERENCES suppliers(id),
    product_name    TEXT NOT NULL,
    quantity        NUMERIC(10,2) DEFAULT 1,
    purchase_price  NUMERIC(12,2) DEFAULT 0,
    sale_price      NUMERIC(12,2) DEFAULT 0
);

-- ─── Склад ────────────────────────────────────────────────────

CREATE TABLE warehouse_stock (
    id              SERIAL PRIMARY KEY,
    product_id      INT UNIQUE NOT NULL REFERENCES products(id),
    quantity        NUMERIC(10,2) DEFAULT 0,
    reserved        NUMERIC(10,2) DEFAULT 0,
    min_quantity    NUMERIC(10,2) DEFAULT 0
);

CREATE TYPE movement_type AS ENUM (
    'incoming',
    'outgoing',
    'reserve',
    'unreserve'
);

CREATE TABLE warehouse_movements (
    id              SERIAL PRIMARY KEY,
    product_id      INT NOT NULL REFERENCES products(id),
    type            movement_type NOT NULL,
    quantity        NUMERIC(10,2) NOT NULL,
    order_id        INT REFERENCES orders(id),
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── Финансы ──────────────────────────────────────────────────

CREATE TYPE transaction_type AS ENUM ('income', 'expense');
CREATE TYPE entity_type     AS ENUM ('client', 'supplier');

CREATE TABLE financial_transactions (
    id              SERIAL PRIMARY KEY,
    date            DATE NOT NULL DEFAULT CURRENT_DATE,
    type            transaction_type NOT NULL,
    entity_type     entity_type NOT NULL,
    entity_id       INT NOT NULL,
    order_id        INT REFERENCES orders(id),
    amount          NUMERIC(12,2) NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── Индексы ──────────────────────────────────────────────────

CREATE INDEX idx_orders_client        ON orders(client_id);
CREATE INDEX idx_orders_status        ON orders(status);
CREATE INDEX idx_orders_created       ON orders(created_at DESC);
CREATE INDEX idx_order_items_order    ON order_items(order_id);
CREATE INDEX idx_order_items_supplier ON order_items(supplier_id);
CREATE INDEX idx_wh_movements_product ON warehouse_movements(product_id);
CREATE INDEX idx_fin_tx_entity        ON financial_transactions(entity_type, entity_id);
CREATE INDEX idx_fin_tx_order         ON financial_transactions(order_id);
CREATE INDEX idx_fin_tx_date          ON financial_transactions(date DESC);
CREATE INDEX idx_products_sku         ON products(sku);
CREATE INDEX idx_clients_phone        ON clients(phone);

-- ─── Вьюхи для аналитики ─────────────────────────────────────

-- Сводка по заказу (суммы, маржа, оплаты)
CREATE VIEW v_order_summary AS
SELECT
    o.id,
    o.order_number,
    o.status,
    o.created_at,
    o.delivery_date,
    c.name                                          AS client_name,
    c.phone                                         AS client_phone,
    COALESCE(SUM(oi.purchase_price * oi.quantity), 0)  AS total_purchase,
    COALESCE(SUM(oi.sale_price     * oi.quantity), 0)  AS total_sale,
    COALESCE(SUM(oi.sale_price * oi.quantity), 0)
      - COALESCE(SUM(oi.purchase_price * oi.quantity), 0) AS margin,
    COALESCE(inc.paid, 0)                           AS paid_by_client,
    COALESCE(SUM(oi.sale_price * oi.quantity), 0)
      - COALESCE(inc.paid, 0)                       AS client_debt,
    COALESCE(exp.paid, 0)                           AS paid_to_supplier,
    COALESCE(SUM(oi.purchase_price * oi.quantity), 0)
      - COALESCE(exp.paid, 0)                       AS supplier_debt
FROM orders o
JOIN clients c ON c.id = o.client_id
LEFT JOIN order_items oi ON oi.order_id = o.id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(amount), 0) AS paid
    FROM financial_transactions
    WHERE order_id = o.id AND type = 'income'
) inc ON TRUE
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(amount), 0) AS paid
    FROM financial_transactions
    WHERE order_id = o.id AND type = 'expense'
) exp ON TRUE
GROUP BY o.id, o.order_number, o.status, o.created_at, o.delivery_date,
         c.name, c.phone, inc.paid, exp.paid;

-- Карточка клиента (агрегат)
CREATE VIEW v_client_summary AS
SELECT
    c.id,
    c.name,
    c.phone,
    COUNT(o.id)                               AS total_orders,
    COALESCE(SUM(vs.total_sale), 0)           AS total_purchases,
    COALESCE(SUM(vs.client_debt), 0)          AS current_debt
FROM clients c
LEFT JOIN orders o ON o.client_id = c.id
LEFT JOIN v_order_summary vs ON vs.id = o.id
GROUP BY c.id, c.name, c.phone;

-- Карточка поставщика (агрегат)
CREATE VIEW v_supplier_summary AS
SELECT
    s.id,
    s.name,
    s.phone,
    COUNT(DISTINCT oi.order_id)                        AS total_orders,
    COALESCE(SUM(oi.purchase_price * oi.quantity), 0)  AS total_purchases,
    COALESCE(SUM(oi.purchase_price * oi.quantity), 0)
      - COALESCE(paid.total, 0)                        AS current_debt
FROM suppliers s
LEFT JOIN order_items oi ON oi.supplier_id = s.id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM financial_transactions
    WHERE entity_type = 'supplier' AND entity_id = s.id
) paid ON TRUE
GROUP BY s.id, s.name, s.phone, paid.total;

-- Остатки на складе
CREATE VIEW v_warehouse_available AS
SELECT
    p.id,
    p.name,
    p.sku,
    pc.name                           AS category,
    ws.quantity,
    ws.reserved,
    ws.quantity - ws.reserved          AS available,
    ws.min_quantity,
    CASE WHEN (ws.quantity - ws.reserved) <= ws.min_quantity
         THEN TRUE ELSE FALSE END     AS low_stock,
    p.purchase_price,
    p.sale_price
FROM products p
JOIN warehouse_stock ws ON ws.product_id = p.id
LEFT JOIN product_categories pc ON pc.id = p.category_id;
