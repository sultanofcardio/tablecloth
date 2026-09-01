import type { CellValue, ColumnInfo, DriverId } from '../core/types';
import { isPlainIdentifier, quoteIdent, quoteLiteral } from '../core/util';

export interface ExtractorInput {
  dialect: DriverId;
  columns: ColumnInfo[];
  rows: CellValue[][];
  /** Qualified-enough table name for generated DML; placeholder when unknown. */
  tableName?: string;
  /** Names of primary key columns, when known (SQL Updates uses them for WHERE). */
  keyColumns?: string[];
}

export interface ExtractorOptions {
  /** Text standing in for NULL in CSV-family output. */
  nullText: string;
  /** Quote every CSV value, not only the ones that need it. */
  quoteAll: boolean;
}

export interface Extractor {
  id: string;
  label: string;
  fileExtension: string;
  extract(input: ExtractorInput, options: ExtractorOptions): string;
}

export const DEFAULT_EXTRACTOR_OPTIONS: ExtractorOptions = { nullText: '', quoteAll: false };

const PLACEHOLDER_TABLE = 'MY_TABLE';

function sqlIdent(dialect: DriverId, name: string): string {
  return isPlainIdentifier(name) ? name : quoteIdent(dialect, name);
}

function sqlValue(dialect: DriverId, value: CellValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : quoteLiteral(dialect, String(value));
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return quoteLiteral(dialect, value);
}

function targetTable(input: ExtractorInput): string {
  return input.tableName ?? PLACEHOLDER_TABLE;
}

// ---------------------------------------------------------------------------
// SQL extractors
// ---------------------------------------------------------------------------

const sqlInserts: Extractor = {
  id: 'sql-inserts',
  label: 'SQL Inserts',
  fileExtension: 'sql',
  extract(input) {
    const { dialect, columns, rows } = input;
    const table = targetTable(input);
    const colList = columns.map((c) => sqlIdent(dialect, c.name)).join(', ');
    const lines = rows.map((row) => {
      const values = row.map((v) => sqlValue(dialect, v)).join(', ');
      return `INSERT INTO ${table} (${colList}) VALUES (${values});`;
    });
    return lines.join('\n') + (lines.length ? '\n' : '');
  },
};

const sqlUpdates: Extractor = {
  id: 'sql-updates',
  label: 'SQL Updates',
  fileExtension: 'sql',
  extract(input) {
    const { dialect, columns, rows } = input;
    const table = targetTable(input);
    const keySet = new Set(input.keyColumns ?? []);
    const keyIdx: number[] = [];
    const valueIdx: number[] = [];
    columns.forEach((c, i) => {
      if (keySet.size > 0 ? keySet.has(c.name) : false) keyIdx.push(i);
      else valueIdx.push(i);
    });
    // Without a known key, fall back to updating every column with a WHERE on every column.
    const whereIdx = keyIdx.length > 0 ? keyIdx : columns.map((_, i) => i);
    const setIdx = keyIdx.length > 0 ? valueIdx : columns.map((_, i) => i);

    const lines = rows.map((row) => {
      const sets = setIdx
        .map((i) => `${sqlIdent(dialect, columns[i]!.name)} = ${sqlValue(dialect, row[i] ?? null)}`)
        .join(', ');
      const wheres = whereIdx
        .map((i) => {
          const v = row[i] ?? null;
          const col = sqlIdent(dialect, columns[i]!.name);
          return v === null ? `${col} IS NULL` : `${col} = ${sqlValue(dialect, v)}`;
        })
        .join(' AND ');
      return `UPDATE ${table} SET ${sets} WHERE ${wheres};`;
    });
    return lines.join('\n') + (lines.length ? '\n' : '');
  },
};

const sqlWhereClause: Extractor = {
  id: 'sql-where',
  label: 'SQL Where Clause',
  fileExtension: 'sql',
  extract(input) {
    const { dialect, columns, rows } = input;
    const keySet = new Set(input.keyColumns ?? []);
    const idx = keySet.size > 0 ? columns.flatMap((c, i) => (keySet.has(c.name) ? [i] : [])) : columns.map((_, i) => i);
    const perRow = rows.map((row) => {
      const parts = idx.map((i) => {
        const v = row[i] ?? null;
        const col = sqlIdent(dialect, columns[i]!.name);
        return v === null ? `${col} IS NULL` : `${col} = ${sqlValue(dialect, v)}`;
      });
      return parts.length > 1 ? `(${parts.join(' AND ')})` : parts.join(' AND ');
    });
    if (perRow.length === 0) return 'WHERE FALSE\n';
    return `WHERE ${perRow.join('\n   OR ')}\n`;
  },
};

// ---------------------------------------------------------------------------
// CSV family
// ---------------------------------------------------------------------------

function csvExtractor(id: string, label: string, delimiter: string, fileExtension: string): Extractor {
  return {
    id,
    label,
    fileExtension,
    extract(input, options) {
      const { columns, rows } = input;
      const needsQuote = (s: string) =>
        options.quoteAll || s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r');
      const field = (s: string) => (needsQuote(s) ? '"' + s.replaceAll('"', '""') + '"' : s);
      const cell = (v: CellValue) => field(v === null ? options.nullText : String(v));
      const lines: string[] = [];
      lines.push(columns.map((c) => field(c.name)).join(delimiter));
      for (const row of rows) {
        lines.push(row.map(cell).join(delimiter));
      }
      return lines.join('\n') + '\n';
    },
  };
}

export const EXTRACTORS: Extractor[] = [
  sqlInserts,
  sqlUpdates,
  sqlWhereClause,
  csvExtractor('csv', 'Comma-Separated Values (CSV)', ',', 'csv'),
  csvExtractor('tsv', 'Tab-Separated Values (TSV)', '\t', 'tsv'),
  csvExtractor('psv', 'Pipe-Separated Values', '|', 'csv'),
  csvExtractor('ssv', 'Semicolon-Separated Values', ';', 'csv'),
];

export function getExtractor(id: string): Extractor | undefined {
  return EXTRACTORS.find((e) => e.id === id);
}
