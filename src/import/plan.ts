import type { DriverId } from '../core/types';
import { qualify, quoteIdent, quoteLiteral } from '../core/util';
import { isNumericText, type ValueKind } from './infer';

export interface ImportColumn {
  /** Index into a data row. */
  source: number;
  /** Table column name. */
  target: string;
  /** How to emit literals. */
  kind: ValueKind;
}

export interface ImportPlanInput {
  dialect: DriverId;
  schema?: string;
  table: string;
  columns: ImportColumn[];
  /** Cells equal to this become NULL; the empty string disables the marker. */
  nullText: string;
  /**
   * '' becomes NULL. When false, '' becomes an empty string literal for text
   * columns and NULL for numeric and boolean columns, since '' is neither.
   */
  emptyAsNull: boolean;
  /** Rows per INSERT statement; values below 1 act as 1. */
  batchSize: number;
}

const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', '1']);
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', '0']);
const VALUES_KEYWORD = 'VALUES ';
const TUPLE_INDENT = ' '.repeat(VALUES_KEYWORD.length);

export function literalFor(
  dialect: DriverId,
  kind: ValueKind,
  cell: string,
  input: Pick<ImportPlanInput, 'nullText' | 'emptyAsNull'>,
): string {
  if (input.nullText !== '' && cell === input.nullText) return 'NULL';
  if (cell === '') return input.emptyAsNull || kind !== 'text' ? 'NULL' : quoteLiteral(dialect, '');
  if (kind === 'numeric' && isNumericText(cell)) return cell;
  if (kind === 'boolean') {
    const word = cell.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return dialect === 'sqlite' ? '1' : 'TRUE';
    if (FALSE_WORDS.has(word)) return dialect === 'sqlite' ? '0' : 'FALSE';
  }
  return quoteLiteral(dialect, cell);
}

export function buildCreateTable(
  dialect: DriverId,
  schema: string | undefined,
  table: string,
  columns: { name: string; sqlType: string }[],
): string {
  if (columns.length === 0) throw new Error('Cannot create a table without columns.');
  const body = columns.map((c) => `    ${quoteIdent(dialect, c.name)} ${c.sqlType}`).join(',\n');
  return `CREATE TABLE ${qualify(dialect, schema, table)}\n(\n${body}\n);`;
}

function insertHead(input: ImportPlanInput): string {
  if (input.columns.length === 0) throw new Error('Cannot insert without any mapped columns.');
  const target = qualify(input.dialect, input.schema, input.table);
  const cols = input.columns.map((c) => quoteIdent(input.dialect, c.target)).join(', ');
  return `INSERT INTO ${target} (${cols})\n${VALUES_KEYWORD}`;
}

function tuple(input: ImportPlanInput, row: string[]): string {
  const values = input.columns.map((c) => literalFor(input.dialect, c.kind, row[c.source] ?? '', input));
  return `(${values.join(', ')})`;
}

/** One multi-row INSERT per batch, tuples after the first aligned under the first. */
export function buildInsertBatches(input: ImportPlanInput, rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const head = insertHead(input);
  const size = Math.max(1, Math.floor(input.batchSize) || 1);
  const statements: string[] = [];
  for (let start = 0; start < rows.length; start += size) {
    const tuples = rows.slice(start, start + size).map((row) => tuple(input, row));
    statements.push(`${head}${tuples.join(`,\n${TUPLE_INDENT}`)};`);
  }
  return statements;
}

/** Single-row INSERT, used when a batch fails and its rows are retried one by one. */
export function buildRowInsert(input: ImportPlanInput, row: string[]): string {
  return `${insertHead(input)}${tuple(input, row)};`;
}
