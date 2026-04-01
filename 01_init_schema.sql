-- Pocket Market Dashboard
-- Schema inicial para múltiplas lojas usando relatórios agregados de vendas

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drive_folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    root_folder_id VARCHAR(255) NOT NULL,
    input_folder_id VARCHAR(255) NOT NULL,
    processed_folder_id VARCHAR(255) NOT NULL,
    error_folder_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (store_id),
    UNIQUE (root_folder_id),
    UNIQUE (input_folder_id),
    UNIQUE (processed_folder_id),
    UNIQUE (error_folder_id)
);

CREATE TABLE IF NOT EXISTS import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    source_file_id VARCHAR(255) NOT NULL,
    source_file_name VARCHAR(500) NOT NULL,
    report_name VARCHAR(255),
    report_period_start TIMESTAMPTZ,
    report_period_end TIMESTAMPTZ,
    imported_at TIMESTAMPTZ,
    processing_started_at TIMESTAMPTZ,
    processing_finished_at TIMESTAMPTZ,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    total_rows_read INTEGER NOT NULL DEFAULT 0,
    total_rows_valid INTEGER NOT NULL DEFAULT 0,
    total_rows_error INTEGER NOT NULL DEFAULT 0,
    raw_total_quantity NUMERIC(18,4),
    raw_total_value NUMERIC(18,2),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (store_id, source_file_id)
);

CREATE TABLE IF NOT EXISTS sales_aggregated (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_batch_id UUID NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    report_month VARCHAR(20),
    sale_day DATE,
    sale_hour INTEGER,
    client_name VARCHAR(255),
    location_name VARCHAR(255),
    internal_location VARCHAR(255),
    machine_name VARCHAR(255),
    machine_type VARCHAR(255),
    manufacturer VARCHAR(255),
    product_code VARCHAR(255),
    channel_slot VARCHAR(255),
    product_name VARCHAR(500) NOT NULL,
    category_name VARCHAR(255),
    quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
    quantity_share_percent NUMERIC(10,4),
    gross_value NUMERIC(18,2) NOT NULL DEFAULT 0,
    value_share_percent NUMERIC(10,4),
    source_row_number INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stores_code ON stores(code);
CREATE INDEX IF NOT EXISTS idx_import_batches_store_id ON import_batches(store_id);
CREATE INDEX IF NOT EXISTS idx_import_batches_status ON import_batches(status);
CREATE INDEX IF NOT EXISTS idx_sales_aggregated_store_id ON sales_aggregated(store_id);
CREATE INDEX IF NOT EXISTS idx_sales_aggregated_import_batch_id ON sales_aggregated(import_batch_id);
CREATE INDEX IF NOT EXISTS idx_sales_aggregated_sale_day ON sales_aggregated(sale_day);
CREATE INDEX IF NOT EXISTS idx_sales_aggregated_product_code ON sales_aggregated(product_code);
CREATE INDEX IF NOT EXISTS idx_sales_aggregated_category_name ON sales_aggregated(category_name);

INSERT INTO stores (code, name)
VALUES ('agulhas_negras', 'Agulhas Negras')
ON CONFLICT (code) DO NOTHING;
