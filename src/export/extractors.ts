import type { CellValue, ColumnInfo, DriverId } from '../core/types';
import { isPlainIdentifier, quoteIdent, quoteLiteral } from '../core/util';
import { buildXlsx, escapeXmlAttr, escapeXmlText, numericLiteral } from './xlsx';

/** Menu sections, mirroring IntelliJ's Data Extractors popup. */
export type ExtractorGroup = 'builtin' | 'csv' | 'scripted';

export const EXTRACTOR_GROUP_LABELS: Record<ExtractorGroup, string> = {
  builtin: 'Built-in',
  csv: 'CSV',
  scripted: 'Scripted',
};

export interface ExtractorInput {
  dialect: DriverId;
  columns: ColumnInfo[];
  rows: CellValue[][];
  /**
   * Column indices to emit, in this order (a rectangular cell selection in the grid).
   * Omitted or empty means every column.
   */
  selectedColumns?: number[];
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
  group: ExtractorGroup;
  fileExtension: string;
  extract(input: ExtractorInput, options: ExtractorOptions): string;
}

/** Extractors that produce a file rather than text; offered by Export Data instead of the copy menu. */
export interface BinaryExtractor {
  id: string;
  label: string;
  fileExtension: string;
  extractBinary(input: ExtractorInput, options: ExtractorOptions): Uint8Array;
}

export const DEFAULT_EXTRACTOR_OPTIONS: ExtractorOptions = { nullText: '', quoteAll: false };

const PLACEHOLDER_TABLE = 'MY_TABLE';
const LINE_BREAK = /\r\n|\r|\n/g;

/**
 * Narrow the input to `selectedColumns` so extractor bodies only ever see the columns
 * they should emit. Key columns are matched by name, so a deselected key simply drops out.
 */
function projectColumns(input: ExtractorInput): ExtractorInput {
  const selected = input.selectedColumns;
  if (!selected || selected.length === 0) return input;
  const indices = selected.filter((i) => Number.isInteger(i) && i >= 0 && i < input.columns.length);
  return {
    ...input,
    columns: indices.map((i) => input.columns[i]!),
    rows: input.rows.map((row) => indices.map((i) => row[i] ?? null)),
    selectedColumns: undefined,
  };
}

function defineExtractor(extractor: Extractor): Extractor {
  return { ...extractor, extract: (input, options) => extractor.extract(projectColumns(input), options) };
}

function defineBinaryExtractor(extractor: BinaryExtractor): BinaryExtractor {
  return {
    ...extractor,
    extractBinary: (input, options) => extractor.extractBinary(projectColumns(input), options),
  };
}

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

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

function cellText(value: CellValue, nullText: string): string {
  return value === null ? nullText : String(value);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function markdownCell(text: string): string {
  return text.replaceAll('|', '\\|').replace(LINE_BREAK, '<br>');
}

function jsonValue(column: ColumnInfo, value: CellValue): string {
  if (value === null || typeof value === 'boolean') return String(value);
  return numericLiteral(column, value) ?? JSON.stringify(String(value));
}

/** Python's repr() quoting: single quotes unless that would need escaping and double quotes would not. */
function pythonRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const escaped = text
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
    .replaceAll(quote, '\\' + quote);
  return quote + escaped + quote;
}

function pythonValue(column: ColumnInfo, value: CellValue): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return numericLiteral(column, value) ?? pythonRepr(String(value));
}

// ---------------------------------------------------------------------------
// Built-in: SQL extractors
// ---------------------------------------------------------------------------

const sqlInserts = defineExtractor({
  id: 'sql-inserts',
  label: 'SQL Inserts',
  group: 'builtin',
  fileExtension: 'sql',
  extract(input) {
    const { dialect, columns, rows } = input;
    const table = targetTable(input);
    const colList = columns.map((c) => sqlIdent(dialect, c.name)).join(', ');
    const lines = rows.map((row) => {
      const values = columns.map((_, i) => sqlValue(dialect, row[i] ?? null)).join(', ');
      return `INSERT INTO ${table} (${colList}) VALUES (${values});`;
    });
    return lines.join('\n') + (lines.length ? '\n' : '');
  },
});

const sqlUpdates = defineExtractor({
  id: 'sql-updates',
  label: 'SQL Updates',
  group: 'builtin',
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
});

const sqlWhereClause = defineExtractor({
  id: 'sql-where',
  label: 'Where Clause',
  group: 'builtin',
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
});

// ---------------------------------------------------------------------------
// CSV family
// ---------------------------------------------------------------------------

function csvExtractor(id: string, label: string, delimiter: string, fileExtension: string): Extractor {
  return defineExtractor({
    id,
    label,
    group: 'csv',
    fileExtension,
    extract(input, options) {
      const { columns, rows } = input;
      const needsQuote = (s: string) =>
        options.quoteAll || s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r');
      const field = (s: string) => (needsQuote(s) ? '"' + s.replaceAll('"', '""') + '"' : s);
      const cell = (v: CellValue) => field(cellText(v, options.nullText));
      const lines: string[] = [];
      lines.push(columns.map((c) => field(c.name)).join(delimiter));
      for (const row of rows) {
        lines.push(columns.map((_, i) => cell(row[i] ?? null)).join(delimiter));
      }
      return lines.join('\n') + '\n';
    },
  });
}

// ---------------------------------------------------------------------------
// Scripted extractors
// ---------------------------------------------------------------------------

const html = defineExtractor({
  id: 'html',
  label: 'HTML',
  group: 'scripted',
  fileExtension: 'html',
  extract({ columns, rows }) {
    const lines = ['<table>', '  <thead>', '    <tr>'];
    for (const c of columns) lines.push(`      <th>${escapeHtml(c.name)}</th>`);
    lines.push('    </tr>', '  </thead>', '  <tbody>');
    for (const row of rows) {
      lines.push('    <tr>');
      columns.forEach((_, i) => lines.push(`      <td>${escapeHtml(cellText(row[i] ?? null, ''))}</td>`));
      lines.push('    </tr>');
    }
    lines.push('  </tbody>', '</table>');
    return lines.join('\n') + '\n';
  },
});

const json = defineExtractor({
  id: 'json',
  label: 'JSON',
  group: 'scripted',
  fileExtension: 'json',
  extract({ columns, rows }) {
    if (rows.length === 0) return '[]\n';
    const objects = rows.map((row) => {
      if (columns.length === 0) return '  {}';
      const fields = columns.map((c, i) => `    ${JSON.stringify(c.name)}: ${jsonValue(c, row[i] ?? null)}`);
      return `  {\n${fields.join(',\n')}\n  }`;
    });
    return `[\n${objects.join(',\n')}\n]\n`;
  },
});

const markdown = defineExtractor({
  id: 'markdown',
  label: 'Markdown',
  group: 'scripted',
  fileExtension: 'md',
  extract({ columns, rows }) {
    const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
    const lines = [
      line(columns.map((c) => markdownCell(c.name))),
      line(columns.map((c) => (c.numeric ? '---:' : '---'))),
      ...rows.map((row) => line(columns.map((_, i) => markdownCell(cellText(row[i] ?? null, ''))))),
    ];
    return lines.join('\n') + '\n';
  },
});

const oneRow = defineExtractor({
  id: 'one-row',
  label: 'One-row',
  group: 'scripted',
  fileExtension: 'txt',
  extract({ dialect, columns, rows }) {
    const values = rows.flatMap((row) => columns.map((_, i) => sqlValue(dialect, row[i] ?? null)));
    return values.join(', ') + '\n';
  },
});

const pretty = defineExtractor({
  id: 'pretty',
  label: 'Pretty',
  group: 'scripted',
  fileExtension: 'txt',
  extract({ columns, rows }) {
    const flatten = (text: string) => text.replace(LINE_BREAK, ' ');
    const header = columns.map((c) => flatten(c.name));
    const body = rows.map((row) => columns.map((_, i) => flatten(cellText(row[i] ?? null, '<null>'))));
    const widths = header.map((h) => h.length);
    for (const cells of body) {
      cells.forEach((text, i) => {
        widths[i] = Math.max(widths[i]!, text.length);
      });
    }
    const border = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
    const line = (cells: string[], alignRight: boolean) =>
      '| ' +
      cells
        .map((text, i) => (alignRight && columns[i]!.numeric ? text.padStart(widths[i]!) : text.padEnd(widths[i]!)))
        .join(' | ') +
      ' |';
    const lines = [border, line(header, false), border, ...body.map((cells) => line(cells, true))];
    if (body.length > 0) lines.push(border);
    return lines.join('\n') + '\n';
  },
});

const pythonDataFrame = defineExtractor({
  id: 'python-dataframe',
  label: 'Python-DataFrame',
  group: 'scripted',
  fileExtension: 'py',
  extract({ columns, rows }) {
    const series = columns.map((c, i) => {
      const values = rows.map((row) => pythonValue(c, row[i] ?? null)).join(', ');
      return `    ${pythonRepr(c.name)}: [${values}],`;
    });
    return ['import pandas as pd', '', 'df = pd.DataFrame({', ...series, '})'].join('\n') + '\n';
  },
});

const sqlInsertMultirow = defineExtractor({
  id: 'sql-insert-multirow',
  label: 'SQL-Insert-Multirow',
  group: 'scripted',
  fileExtension: 'sql',
  extract(input) {
    const { dialect, columns, rows } = input;
    if (rows.length === 0) return '';
    const colList = columns.map((c) => sqlIdent(dialect, c.name)).join(', ');
    const tuples = rows.map((row) => `(${columns.map((_, i) => sqlValue(dialect, row[i] ?? null)).join(', ')})`);
    return `INSERT INTO ${targetTable(input)} (${colList})\nVALUES ${tuples.join(',\n       ')};\n`;
  },
});

const xml = defineExtractor({
  id: 'xml',
  label: 'XML',
  group: 'scripted',
  fileExtension: 'xml',
  extract({ columns, rows }) {
    const lines = ['<data>'];
    for (const row of rows) {
      lines.push('  <row>');
      columns.forEach((c, i) => {
        const value = row[i] ?? null;
        const name = escapeXmlAttr(c.name);
        lines.push(
          value === null
            ? `    <column name="${name}" null="true"/>`
            : `    <column name="${name}">${escapeXmlText(String(value))}</column>`,
        );
      });
      lines.push('  </row>');
    }
    lines.push('</data>');
    return lines.join('\n') + '\n';
  },
});

/** Menu order: the builtin group, then the CSV group, then the scripted group. */
export const EXTRACTORS: Extractor[] = [
  sqlInserts,
  sqlUpdates,
  sqlWhereClause,
  csvExtractor('csv', 'CSV', ',', 'csv'),
  csvExtractor('tsv', 'TSV', '\t', 'tsv'),
  csvExtractor('psv', 'Pipe-separated', '|', 'csv'),
  csvExtractor('ssv', 'Semicolon-separated', ';', 'csv'),
  html,
  json,
  markdown,
  oneRow,
  pretty,
  pythonDataFrame,
  sqlInsertMultirow,
  xml,
];

export function getExtractor(id: string): Extractor | undefined {
  return EXTRACTORS.find((e) => e.id === id);
}

// ---------------------------------------------------------------------------
// Binary extractors (Export Data only)
// ---------------------------------------------------------------------------

const xlsx = defineBinaryExtractor({
  id: 'xlsx',
  label: 'Excel (xlsx)',
  fileExtension: 'xlsx',
  extractBinary({ columns, rows, tableName }) {
    return buildXlsx({ columns, rows, sheetName: tableName });
  },
});

export const BINARY_EXTRACTORS: BinaryExtractor[] = [xlsx];

export function getBinaryExtractor(id: string): BinaryExtractor | undefined {
  return BINARY_EXTRACTORS.find((e) => e.id === id);
}
