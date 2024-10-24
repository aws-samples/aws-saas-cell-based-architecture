CREATE SCHEMA app;
CREATE TABLE app.products (
  product_id INTEGER PRIMARY KEY,
  product_name TEXT NOT NULL,
  product_description text NOT NULL,
  product_price NUMERIC NOT NULL,
  tenant_id TEXT NOT NULL    
);
CREATE USER <tenant_id> WITH PASSWORD '<tenant_pwd>';  
GRANT CONNECT ON DATABASE <tenant_id> TO <tenant_id>;
GRANT USAGE ON SCHEMA app TO <tenant_id>;
GRANT ALL PRIVILEGES ON table app.products TO <tenant_id>;