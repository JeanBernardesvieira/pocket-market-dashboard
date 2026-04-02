const XLSX = require('xlsx');

function normalizeText(value) {
  return String(value ?? '').trim();
}

function parseBrazilianNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;

  const text = String(value).trim();
  if (!text) return null;

  const cleaned = text.replace(/[^0-9,.-]/g, '');
  let normalized = cleaned;

  if (cleaned.includes('.') && cleaned.includes(',')) {
    normalized = cleaned.replace(/\./g, '').replace(/,/g, '.');
  } else if (cleaned.includes(',')) {
    normalized = cleaned.replace(/,/g, '.');
  }

  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

function parseDay(value) {
  const text = normalizeText(value);
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseDateTimeBR(value) {
  const text = normalizeText(value);
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (!match) return null;
  const hh = match[4] ?? '00';
  const mm = match[5] ?? '00';
  return `${match[3]}-${match[2]}-${match[1]}T${hh}:${mm}:00Z`;
}

function makeUniqueHeader(headerRow) {
  const counts = new Map();
  return headerRow.map((column) => {
    const base = normalizeText(column);
    const current = counts.get(base) || 0;
    counts.set(base, current + 1);
    return current === 0 ? base : `${base}_${current}`;
  });
}

function findHeaderRow(rows) {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i].map((cell) => normalizeText(cell));
    if (row[0] === 'Produto' && row.includes('Categoria') && row.includes('Quantidade') && row.includes('Valor')) {
      return i;
    }
  }
  return -1;
}

function findMetaValue(rows, label) {
  for (const row of rows) {
    for (let i = 0; i < row.length; i += 1) {
      if (normalizeText(row[i]) === label) {
        return normalizeText(row[i + 1]);
      }
    }
  }
  return '';
}

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  const headerIndex = findHeaderRow(rows);
  if (headerIndex === -1) {
    throw new Error('Cabeçalho da tabela de vendas não encontrado na planilha.');
  }

  const header = makeUniqueHeader(rows[headerIndex]);
  const dataRows = [];

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i].map((cell) => normalizeText(cell));
    if (!row.some(Boolean)) continue;
    if (row[0] === 'Total') break;

    const item = {};
    header.forEach((column, index) => {
      item[column] = row[index] ?? '';
    });

    dataRows.push({ rowNumber: i + 1, raw: item });
  }

  const periodStart = parseDateTimeBR(findMetaValue(rows, 'Data inicial'));
  const periodEnd = parseDateTimeBR(findMetaValue(rows, 'Data final'));
  const clientName = findMetaValue(rows, 'Cliente');
  const reportName = normalizeText(rows[0]?.[0]) || 'Vendas';

  const normalizedRows = dataRows.map(({ rowNumber, raw }) => ({
    source_row_number: rowNumber,
    report_month: normalizeText(raw['Mês']),
    sale_day: parseDay(raw['Dia']),
    sale_hour: parseBrazilianNumber(raw['Hora']),
    client_name: normalizeText(raw['Cliente']) || clientName,
    location_name: normalizeText(raw['Local']),
    internal_location: normalizeText(raw['Local interno']),
    machine_name: normalizeText(raw['Máquina']),
    machine_type: normalizeText(raw['Tipo de máquina']),
    manufacturer: normalizeText(raw['Fabricante']),
    product_code: normalizeText(raw['Código do produto']),
    channel_slot: normalizeText(raw['Canaleta']),
    product_name: normalizeText(raw['Produto']),
    category_name: normalizeText(raw['Categoria']),
    quantity: parseBrazilianNumber(raw['Quantidade']) ?? 0,
    quantity_share_percent: parseBrazilianNumber(raw['%']) ?? null,
    gross_value: parseBrazilianNumber(raw['Valor']) ?? 0,
    value_share_percent: parseBrazilianNumber(raw['%_1']) ?? null
  }));

  return {
    reportName,
    periodStart,
    periodEnd,
    clientName,
    rows: normalizedRows
  };
}

async function downloadFile(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Falha ao baixar planilha: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function importSalesFromUrl({ pool, storeCode, fileUrl }) {
  if (!fileUrl) {
    throw new Error('IMPORT_FILE_URL não configurado.');
  }

  const sourceFileId = fileUrl;
  const existingBatch = await pool.query(
    `SELECT id FROM import_batches WHERE store_id = (SELECT id FROM stores WHERE code = $1) AND source_file_id = $2 LIMIT 1`,
    [storeCode, sourceFileId]
  );

  if (existingBatch.rowCount > 0) {
    return { alreadyImported: true, importedRows: 0 };
  }

  const fileBuffer = await downloadFile(fileUrl);
  const parsed = parseWorkbook(fileBuffer);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const storeRes = await client.query('SELECT id, name FROM stores WHERE code = $1 LIMIT 1', [storeCode]);
    if (storeRes.rowCount === 0) {
      throw new Error(`Loja não encontrada para o código ${storeCode}.`);
    }

    const storeId = storeRes.rows[0].id;
    const totalQuantity = parsed.rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    const totalValue = parsed.rows.reduce((sum, row) => sum + Number(row.gross_value || 0), 0);
    const sourceFileName = (() => {
      try {
        const parsedUrl = new URL(fileUrl);
        return parsedUrl.pathname.split('/').pop() || 'importacao_inicial.xlsx';
      } catch {
        return 'importacao_inicial.xlsx';
      }
    })();

    const batchRes = await client.query(
      `INSERT INTO import_batches (
        store_id, source_file_id, source_file_name, report_name,
        report_period_start, report_period_end, imported_at,
        processing_started_at, processing_finished_at, status,
        total_rows_read, total_rows_valid, total_rows_error,
        raw_total_quantity, raw_total_value
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, NOW(),
        NOW(), NOW(), 'success',
        $7, $8, 0,
        $9, $10
      ) RETURNING id`,
      [
        storeId,
        sourceFileId,
        sourceFileName,
        parsed.reportName,
        parsed.periodStart,
        parsed.periodEnd,
        parsed.rows.length,
        parsed.rows.length,
        totalQuantity,
        totalValue
      ]
    );

    const importBatchId = batchRes.rows[0].id;

    for (const row of parsed.rows) {
      await client.query(
        `INSERT INTO sales_aggregated (
          import_batch_id, store_id, report_month, sale_day, sale_hour,
          client_name, location_name, internal_location, machine_name, machine_type,
          manufacturer, product_code, channel_slot, product_name, category_name,
          quantity, quantity_share_percent, gross_value, value_share_percent, source_row_number
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20
        )`,
        [
          importBatchId,
          storeId,
          row.report_month || null,
          row.sale_day || null,
          row.sale_hour ?? null,
          row.client_name || null,
          row.location_name || null,
          row.internal_location || null,
          row.machine_name || null,
          row.machine_type || null,
          row.manufacturer || null,
          row.product_code || null,
          row.channel_slot || null,
          row.product_name,
          row.category_name || null,
          row.quantity,
          row.quantity_share_percent,
          row.gross_value,
          row.value_share_percent,
          row.source_row_number
        ]
      );
    }

    await client.query('COMMIT');
    return { alreadyImported: false, importedRows: parsed.rows.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { importSalesFromUrl };
