const http = require('http');
const pool = require('./db');
const { importSalesFromUrl } = require('./importer');

const PORT = process.env.PORT || 3000;
const STORE_CODE = process.env.STORE_CODE || 'agulhas_negras';
const IMPORT_FILE_URL = process.env.IMPORT_FILE_URL || 'https://docs.google.com/spreadsheets/d/1v0km7F5QSUKuRI_wY2X55_92iv--ufdN/export?format=xlsx';

const initSql = `
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
`;

function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
}

function formatNumber(value) {
  return new Intl.NumberFormat('pt-BR').format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(date);
}

async function initializeDatabase() {
  await pool.query(initSql);
}

async function resetStoreData() {
  await pool.query(
    `DELETE FROM sales_aggregated WHERE store_id = (SELECT id FROM stores WHERE code = $1)`,
    [STORE_CODE]
  );
  await pool.query(
    `DELETE FROM import_batches WHERE store_id = (SELECT id FROM stores WHERE code = $1)`,
    [STORE_CODE]
  );
}

async function fetchStats() {
  const [storesRes, batchesRes, salesRes, totalsRes, topProductsRes, latestBatchRes, detailedRowsRes, categoryRes, manufacturerRes, hourRes] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS total FROM stores'),
    pool.query('SELECT COUNT(*)::int AS total FROM import_batches'),
    pool.query('SELECT COUNT(*)::int AS total FROM sales_aggregated'),
    pool.query(`
      SELECT
        COALESCE(SUM(quantity), 0) AS total_quantity,
        COALESCE(SUM(gross_value), 0) AS total_value
      FROM sales_aggregated
    `),
    pool.query(`
      SELECT product_name, SUM(gross_value) AS total_value
      FROM sales_aggregated
      GROUP BY product_name
      ORDER BY total_value DESC
      LIMIT 5
    `),
    pool.query(`
      SELECT report_name, report_period_start, report_period_end, source_file_name, raw_total_quantity, raw_total_value
      FROM import_batches
      ORDER BY created_at DESC
      LIMIT 1
    `),
    pool.query(`
      SELECT sale_day, sale_hour, product_name, category_name, client_name, location_name,
             internal_location, machine_name, machine_type, manufacturer, product_code,
             channel_slot, quantity, gross_value
      FROM sales_aggregated
      ORDER BY sale_day DESC NULLS LAST, sale_hour DESC NULLS LAST, product_name ASC
      LIMIT 70
    `),
    pool.query(`
      SELECT COALESCE(category_name, 'Sem categoria') AS category_name,
             SUM(quantity) AS total_quantity,
             SUM(gross_value) AS total_value
      FROM sales_aggregated
      GROUP BY COALESCE(category_name, 'Sem categoria')
      ORDER BY total_value DESC
      LIMIT 10
    `),
    pool.query(`
      SELECT COALESCE(manufacturer, 'Sem fabricante') AS manufacturer,
             SUM(quantity) AS total_quantity,
             SUM(gross_value) AS total_value
      FROM sales_aggregated
      GROUP BY COALESCE(manufacturer, 'Sem fabricante')
      ORDER BY total_value DESC
      LIMIT 10
    `),
    pool.query(`
      SELECT sale_hour,
             SUM(quantity) AS total_quantity,
             SUM(gross_value) AS total_value
      FROM sales_aggregated
      GROUP BY sale_hour
      ORDER BY sale_hour ASC NULLS LAST
    `)
  ]);

  return {
    stores: storesRes.rows[0].total,
    batches: batchesRes.rows[0].total,
    sales: salesRes.rows[0].total,
    totalQuantity: Number(totalsRes.rows[0].total_quantity || 0),
    totalValue: Number(totalsRes.rows[0].total_value || 0),
    topProducts: topProductsRes.rows.map((row) => ({
      product_name: row.product_name,
      total_value: Number(row.total_value || 0)
    })),
    latestBatch: latestBatchRes.rowCount > 0 ? {
      report_name: latestBatchRes.rows[0].report_name,
      report_period_start: latestBatchRes.rows[0].report_period_start,
      report_period_end: latestBatchRes.rows[0].report_period_end,
      source_file_name: latestBatchRes.rows[0].source_file_name,
      raw_total_quantity: Number(latestBatchRes.rows[0].raw_total_quantity || 0),
      raw_total_value: Number(latestBatchRes.rows[0].raw_total_value || 0)
    } : null,
    detailedRows: detailedRowsRes.rows.map((row) => ({
      sale_day: row.sale_day,
      sale_hour: row.sale_hour,
      product_name: row.product_name,
      category_name: row.category_name,
      client_name: row.client_name,
      location_name: row.location_name,
      internal_location: row.internal_location,
      machine_name: row.machine_name,
      machine_type: row.machine_type,
      manufacturer: row.manufacturer,
      product_code: row.product_code,
      channel_slot: row.channel_slot,
      quantity: Number(row.quantity || 0),
      gross_value: Number(row.gross_value || 0)
    })),
    categories: categoryRes.rows.map((row) => ({
      category_name: row.category_name,
      total_quantity: Number(row.total_quantity || 0),
      total_value: Number(row.total_value || 0)
    })),
    manufacturers: manufacturerRes.rows.map((row) => ({
      manufacturer: row.manufacturer,
      total_quantity: Number(row.total_quantity || 0),
      total_value: Number(row.total_value || 0)
    })),
    hours: hourRes.rows.map((row) => ({
      sale_hour: row.sale_hour,
      total_quantity: Number(row.total_quantity || 0),
      total_value: Number(row.total_value || 0)
    }))
  };
}

function renderHome(stats, message = '') {
  const topProductsHtml = stats.topProducts.length
    ? stats.topProducts
        .map(
          (item) => `
            <tr>
              <td>${item.product_name}</td>
              <td style="text-align:right">${formatCurrency(item.total_value)}</td>
            </tr>
          `
        )
        .join('')
    : '<tr><td colspan="2">Nenhum dado importado ainda.</td></tr>';

  const detailedRowsHtml = stats.detailedRows.length
    ? stats.detailedRows
        .map(
          (item) => `
            <tr>
              <td>${formatDate(item.sale_day)}</td>
              <td>${item.sale_hour ?? '-'}</td>
              <td>${item.product_name || '-'}</td>
              <td>${item.category_name || '-'}</td>
              <td>${item.client_name || '-'}</td>
              <td>${item.location_name || '-'}</td>
              <td>${item.internal_location || '-'}</td>
              <td>${item.machine_name || '-'}</td>
              <td>${item.machine_type || '-'}</td>
              <td>${item.manufacturer || '-'}</td>
              <td>${item.product_code || '-'}</td>
              <td>${item.channel_slot || '-'}</td>
              <td style="text-align:right">${formatNumber(item.quantity)}</td>
              <td style="text-align:right">${formatCurrency(item.gross_value)}</td>
            </tr>
          `
        )
        .join('')
    : '<tr><td colspan="14">Nenhuma linha detalhada disponível.</td></tr>';

  const categoryRowsHtml = stats.categories.length
    ? stats.categories
        .map(
          (item) => `
            <tr>
              <td>${item.category_name}</td>
              <td style="text-align:right">${formatNumber(item.total_quantity)}</td>
              <td style="text-align:right">${formatCurrency(item.total_value)}</td>
            </tr>
          `
        )
        .join('')
    : '<tr><td colspan="3">Sem dados por categoria.</td></tr>';

  const manufacturerRowsHtml = stats.manufacturers.length
    ? stats.manufacturers
        .map(
          (item) => `
            <tr>
              <td>${item.manufacturer}</td>
              <td style="text-align:right">${formatNumber(item.total_quantity)}</td>
              <td style="text-align:right">${formatCurrency(item.total_value)}</td>
            </tr>
          `
        )
        .join('')
    : '<tr><td colspan="3">Sem dados por fabricante.</td></tr>';

  const hourRowsHtml = stats.hours.length
    ? stats.hours
        .map(
          (item) => `
            <tr>
              <td>${item.sale_hour ?? '-'}</td>
              <td style="text-align:right">${formatNumber(item.total_quantity)}</td>
              <td style="text-align:right">${formatCurrency(item.total_value)}</td>
            </tr>
          `
        )
        .join('')
    : '<tr><td colspan="3">Sem dados por hora.</td></tr>';

  const batchSummaryHtml = stats.latestBatch
    ? `
      <div class="grid grid-3" style="margin-top: 24px;">
        <div class="box"><div class="label">Relatório</div><div class="mini-value">${stats.latestBatch.report_name || '-'}</div></div>
        <div class="box"><div class="label">Período</div><div class="mini-value">${formatDate(stats.latestBatch.report_period_start)} até ${formatDate(stats.latestBatch.report_period_end)}</div></div>
        <div class="box"><div class="label">Arquivo</div><div class="mini-value">${stats.latestBatch.source_file_name || '-'}</div></div>
      </div>
    `
    : '';

  const importButton = IMPORT_FILE_URL
    ? '<a class="button" href="/import-current">Importar planilha atual</a>'
    : '<span class="button disabled">Configure IMPORT_FILE_URL para importar</span>';
  const resetButton = '<a class="button button-secondary" href="/reset-store-data">Limpar importação atual</a>';

  return `
    <html>
      <head>
        <title>Pocket Market Dashboard</title>
        <meta charset="utf-8" />
        <style>
          body { font-family: Arial, sans-serif; background: #0f172a; color: #e2e8f0; padding: 32px; }
          .card { background: #1e293b; border-radius: 16px; padding: 24px; max-width: 1100px; margin: 0 auto; }
          .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; margin-top: 24px; }
          .grid.grid-3 { grid-template-columns: repeat(3, 1fr); }
          .box { background: #334155; border-radius: 12px; padding: 20px; }
          .label { font-size: 14px; color: #94a3b8; }
          .value { font-size: 30px; font-weight: bold; margin-top: 8px; }
          .mini-value { font-size: 16px; font-weight: bold; margin-top: 8px; line-height: 1.4; }
          h1, h2 { margin-top: 0; }
          p { color: #cbd5e1; }
          .actions { margin: 20px 0 8px; display: flex; gap: 12px; align-items: center; }
          .button { background: #7c3aed; color: white; padding: 12px 16px; border-radius: 10px; text-decoration: none; font-weight: bold; display: inline-block; }
          .button.button-secondary { background: #b91c1c; }
          .button.disabled { background: #475569; color: #cbd5e1; }
          .message { background: #0f766e; color: white; padding: 12px 16px; border-radius: 10px; }
          table { width: 100%; border-collapse: collapse; margin-top: 16px; }
          th, td { padding: 12px; border-bottom: 1px solid #334155; font-size: 14px; }
          th { text-align: left; color: #94a3b8; position: sticky; top: 0; background: #1e293b; }
          .table-wrap { overflow-x: auto; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Pocket Market Dashboard</h1>
          <p>Sistema online e conectado ao banco.</p>
          <p>Loja inicial cadastrada: <strong>${STORE_CODE}</strong></p>
          <div class="actions">
            ${importButton}
            ${resetButton}
            ${message ? `<div class="message">${message}</div>` : ''}
          </div>
          <div class="grid">
            <div class="box"><div class="label">Lojas cadastradas</div><div class="value">${formatNumber(stats.stores)}</div></div>
            <div class="box"><div class="label">Lotes de importação</div><div class="value">${formatNumber(stats.batches)}</div></div>
            <div class="box"><div class="label">Linhas de vendas</div><div class="value">${formatNumber(stats.sales)}</div></div>
            <div class="box"><div class="label">Quantidade total</div><div class="value">${formatNumber(stats.totalQuantity)}</div></div>
            <div class="box"><div class="label">Faturamento total</div><div class="value">${formatCurrency(stats.totalValue)}</div></div>
          </div>

          ${batchSummaryHtml}

          <div style="margin-top: 32px;">
            <h2>Top 5 produtos por faturamento</h2>
            <table>
              <thead>
                <tr>
                  <th>Produto</th>
                  <th style="text-align:right">Valor</th>
                </tr>
              </thead>
              <tbody>
                ${topProductsHtml}
              </tbody>
            </table>
          </div>

          <div class="grid grid-3" style="margin-top: 32px; align-items:start;">
            <div class="box">
              <h2 style="font-size:22px;">Categorias</h2>
              <table>
                <thead>
                  <tr>
                    <th>Categoria</th>
                    <th style="text-align:right">Qtd.</th>
                    <th style="text-align:right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  ${categoryRowsHtml}
                </tbody>
              </table>
            </div>
            <div class="box">
              <h2 style="font-size:22px;">Fabricantes</h2>
              <table>
                <thead>
                  <tr>
                    <th>Fabricante</th>
                    <th style="text-align:right">Qtd.</th>
                    <th style="text-align:right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  ${manufacturerRowsHtml}
                </tbody>
              </table>
            </div>
            <div class="box">
              <h2 style="font-size:22px;">Vendas por hora</h2>
              <table>
                <thead>
                  <tr>
                    <th>Hora</th>
                    <th style="text-align:right">Qtd.</th>
                    <th style="text-align:right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  ${hourRowsHtml}
                </tbody>
              </table>
            </div>
          </div>

          <div style="margin-top: 32px;">
            <h2>Detalhamento das linhas importadas</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Dia</th>
                    <th>Hora</th>
                    <th>Produto</th>
                    <th>Categoria</th>
                    <th>Cliente</th>
                    <th>Local</th>
                    <th>Local interno</th>
                    <th>Máquina</th>
                    <th>Tipo máquina</th>
                    <th>Fabricante</th>
                    <th>Cód. produto</th>
                    <th>Canaleta</th>
                    <th style="text-align:right">Qtd.</th>
                    <th style="text-align:right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  ${detailedRowsHtml}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/import-current') {
      const result = await importSalesFromUrl({
        pool,
        storeCode: STORE_CODE,
        fileUrl: IMPORT_FILE_URL
      });

      const message = result.alreadyImported
        ? 'A planilha atual já havia sido importada anteriormente.'
        : `Importação concluída com sucesso. ${result.importedRows} linhas importadas.`;

      res.writeHead(302, { Location: `/?message=${encodeURIComponent(message)}` });
      res.end();
      return;
    }

    if (url.pathname === '/reset-store-data') {
      await resetStoreData();
      res.writeHead(302, { Location: `/?message=${encodeURIComponent('Importação antiga removida com sucesso.')}` });
      res.end();
      return;
    }

    const stats = await fetchStats();
    const message = url.searchParams.get('message') || '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHome(stats, message));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Erro ao carregar dashboard: ${error.message}`);
  }
});

initializeDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Servidor rodando na porta ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Erro ao inicializar banco:', error);
    process.exit(1);
  });
