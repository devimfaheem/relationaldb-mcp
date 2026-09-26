CREATE DATABASE IF NOT EXISTS shop;
USE shop;

CREATE TABLE customers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) NOT NULL,
  country VARCHAR(2) NOT NULL
);

CREATE TABLE orders (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL REFERENCES customers(id),
  total DECIMAL(10, 2) NOT NULL,
  status VARCHAR(20) NOT NULL,
  created_at DATETIME NOT NULL
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

CREATE USER IF NOT EXISTS 'mcp'@'%' IDENTIFIED BY 'mcp_password';
GRANT SELECT, INSERT, UPDATE ON shop.* TO 'mcp'@'%';
