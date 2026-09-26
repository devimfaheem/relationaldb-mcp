IF DB_ID('shop') IS NULL CREATE DATABASE shop;
GO
USE shop;
GO
CREATE TABLE customers (
  id INT IDENTITY PRIMARY KEY,
  name NVARCHAR(100) NOT NULL,
  email NVARCHAR(200) NOT NULL,
  country CHAR(2) NOT NULL
);
CREATE TABLE orders (
  id INT IDENTITY PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  total DECIMAL(10, 2) NOT NULL,
  status NVARCHAR(20) NOT NULL,
  created_at DATETIME2 NOT NULL
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
GO
-- Least-privilege, read-only login for the MCP server.
CREATE LOGIN mcp WITH PASSWORD = 'Mcp_password1', CHECK_POLICY = OFF;
CREATE USER mcp FOR LOGIN mcp;
ALTER ROLE db_datareader ADD MEMBER mcp;
GO
