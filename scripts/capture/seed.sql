CREATE TYPE order_status AS ENUM ('pending', 'shipped', 'delivered');
CREATE TYPE sync_type AS ENUM ('full', 'incremental');
CREATE TABLE customers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email varchar(120) NOT NULL UNIQUE,
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  status order_status NOT NULL DEFAULT 'pending',
  total numeric(10,2) NOT NULL DEFAULT 0,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE order_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id),
  sku varchar(40) NOT NULL,
  quantity int NOT NULL DEFAULT 1,
  price numeric(10,2) NOT NULL
);
CREATE INDEX idx_orders_status ON orders (status);
CREATE VIEW shipped_orders AS SELECT * FROM orders WHERE status = 'shipped';
INSERT INTO customers (email, name)
SELECT 'user' || g || '@example.com',
       (ARRAY['Ada Lovelace','Grace Hopper','Edsger Dijkstra','Barbara Liskov','Alan Turing','Margaret Hamilton'])[1 + g % 6] || ' ' || g
FROM generate_series(1, 120) g;
INSERT INTO orders (customer_id, status, total, note, created_at)
SELECT 1 + g % 120,
       (ARRAY['pending','shipped','delivered'])[1 + g % 3]::order_status,
       round((random() * 400 + 5)::numeric, 2),
       CASE WHEN g % 7 = 0 THEN 'gift wrap' END,
       now() - (g || ' hours')::interval
FROM generate_series(1, 1200) g;
INSERT INTO order_items (order_id, sku, quantity, price)
SELECT 1 + g % 1200, 'SKU-' || (100 + g % 500), 1 + g % 4, round((random() * 90 + 3)::numeric, 2)
FROM generate_series(1, 2400) g;
