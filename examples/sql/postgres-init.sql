CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  country CHAR(2) NOT NULL
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  total NUMERIC(10, 2) NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL
);

INSERT INTO customers (name, email, country) VALUES
  ('Ada Lovelace', 'ada@example.com', 'GB'),
  ('Grace Hopper', 'grace@example.com', 'US'),
  ('Alan Turing', 'alan@example.com', 'GB');

INSERT INTO orders (customer_id, total, status, created_at) VALUES
  (1, 120.50, 'shipped', '2026-01-10 10:00:00'),
  (1, 35.00, 'pending', '2026-02-02 14:30:00'),
  (2, 990.00, 'shipped', '2026-01-21 09:15:00'),
  (3, 15.75, 'cancelled', '2026-03-05 18:45:00');

-- Least-privilege, read-only user for the MCP server.
CREATE USER mcp WITH PASSWORD 'mcp_password';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp;
