import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';

const ICO_HEADERS = new Set(['ico', 'ičo', 'ic', 'ič', 'company_ico']);

export type ParsedRow = {
  rowNumber: number;
  rawValue: string;
  normalizedIco: string | null;
  status: 'imported' | 'skipped' | 'invalid' | 'duplicate';
  message?: string;
};

export type ImportSummary = {
  rows: ParsedRow[];
  importedCount: number;
  invalidCount: number;
  duplicateCount: number;
  errors: string[];
  uniqueIcos: string[];
};

type Row = Record<string, unknown>;

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

function normalizeIco(value: string): { normalized: string | null; error?: string } {
  const clean = value.replace(/\s+/g, '');

  if (!clean) {
    return { normalized: null, error: 'Prázdná hodnota IČO' };
  }

  if (!/^\d+$/.test(clean)) {
    return { normalized: null, error: 'IČO obsahuje nepovolené znaky' };
  }

  if (clean.length > 8) {
    return { normalized: null, error: 'IČO má více než 8 číslic' };
  }

  return { normalized: clean.padStart(8, '0') };
}

function parseCsv(buffer: Buffer): Row[] {
  return parse(buffer, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true
  }) as Row[];
}

function parseXlsx(buffer: Buffer): Row[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const firstSheet = wb.SheetNames[0];

  if (!firstSheet) {
    return [];
  }

  return XLSX.utils.sheet_to_json<Row>(wb.Sheets[firstSheet], { defval: '' });
}

export function parseFile(filename: string, mimetype: string, buffer: Buffer): Row[] {
  const lower = filename.toLowerCase();
  const isCsv = lower.endsWith('.csv') || mimetype.includes('csv');
  const isXlsx = lower.endsWith('.xlsx') || mimetype.includes('spreadsheetml');

  if (isCsv) {
    return parseCsv(buffer);
  }

  if (isXlsx) {
    return parseXlsx(buffer);
  }

  throw new Error('Nepodporovaný formát souboru. Povolené jsou pouze CSV a XLSX.');
}

export function buildImportSummary(rows: Row[]): ImportSummary {
  const headers = rows.length ? Object.keys(rows[0] ?? {}) : [];
  const icoHeader = headers.find((h) => ICO_HEADERS.has(normalizeHeader(h)));

  if (!icoHeader) {
    throw new Error('Nepodařilo se najít sloupec s IČO (ico, ičo, ic, ič, company_ico).');
  }

  const parsedRows: ParsedRow[] = [];
  const unique = new Set<string>();
  const errors: string[] = [];

  rows.forEach((row, index) => {
    const rawValue = String(row[icoHeader] ?? '').trim();
    const rowNumber = index + 2;
    const normalized = normalizeIco(rawValue);

    if (!normalized.normalized) {
      parsedRows.push({
        rowNumber,
        rawValue,
        normalizedIco: null,
        status: 'invalid',
        message: normalized.error
      });
      errors.push(`Řádek ${rowNumber}: ${normalized.error}`);
      return;
    }

    if (unique.has(normalized.normalized)) {
      parsedRows.push({
        rowNumber,
        rawValue,
        normalizedIco: normalized.normalized,
        status: 'duplicate',
        message: 'Duplicitní IČO v dávce'
      });
      return;
    }

    unique.add(normalized.normalized);
    parsedRows.push({
      rowNumber,
      rawValue,
      normalizedIco: normalized.normalized,
      status: 'imported'
    });
  });

  return {
    rows: parsedRows,
    importedCount: parsedRows.filter((r) => r.status === 'imported').length,
    invalidCount: parsedRows.filter((r) => r.status === 'invalid').length,
    duplicateCount: parsedRows.filter((r) => r.status === 'duplicate').length,
    errors,
    uniqueIcos: [...unique]
  };
}
