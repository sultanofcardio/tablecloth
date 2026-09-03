import type { DriverId } from '../core/types';

export type InferredType = 'integer' | 'bigint' | 'numeric' | 'boolean' | 'date' | 'timestamp' | 'text';

/** How literals for a target column are emitted into generated SQL. */
export type ValueKind = 'numeric' | 'boolean' | 'text';

const INTEGER_RE = /^[+-]?\d+$/;
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const BOOLEAN_WORDS = new Set(['true', 'false', 't', 'f', 'yes', 'no']);

const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

/** True when the cell is a plain SQL number literal: optional sign, digits, one dot, optional exponent. */
export function isNumericText(cell: string): boolean {
  return NUMBER_RE.test(cell);
}

function classify(cell: string): InferredType {
  if (INTEGER_RE.test(cell)) {
    const n = BigInt(cell);
    if (n >= INT32_MIN && n <= INT32_MAX) return 'integer';
    if (n >= INT64_MIN && n <= INT64_MAX) return 'bigint';
    return 'numeric';
  }
  if (NUMBER_RE.test(cell)) return 'numeric';
  if (BOOLEAN_WORDS.has(cell.toLowerCase())) return 'boolean';
  if (DATE_RE.test(cell)) return 'date';
  if (TIMESTAMP_RE.test(cell)) return 'timestamp';
  return 'text';
}

/**
 * Infer a column type from sample cells. Empty cells and cells equal to
 * nullText are ignored; a column with nothing else is text. Number widths and
 * date precisions widen to fit every sample, and any other mixture is text.
 */
export function inferColumnType(samples: Iterable<string>, nullText = ''): InferredType {
  const seen = new Set<InferredType>();
  for (const cell of samples) {
    if (cell === '' || (nullText !== '' && cell === nullText)) continue;
    const type = classify(cell);
    if (type === 'text') return 'text';
    seen.add(type);
  }
  if (seen.size === 0) return 'text';

  const numberLike = seen.has('integer') || seen.has('bigint') || seen.has('numeric');
  const dateLike = seen.has('date') || seen.has('timestamp');
  const boolLike = seen.has('boolean');
  if ([numberLike, dateLike, boolLike].filter(Boolean).length > 1) return 'text';
  if (numberLike) return seen.has('numeric') ? 'numeric' : seen.has('bigint') ? 'bigint' : 'integer';
  if (dateLike) return seen.has('timestamp') ? 'timestamp' : 'date';
  return 'boolean';
}

const SQL_TYPES: Record<DriverId, Record<InferredType, string>> = {
  postgres: {
    integer: 'integer',
    bigint: 'bigint',
    numeric: 'numeric',
    boolean: 'boolean',
    date: 'date',
    timestamp: 'timestamp',
    text: 'text',
  },
  mysql: {
    integer: 'int',
    bigint: 'bigint',
    numeric: 'decimal(20,6)',
    boolean: 'tinyint(1)',
    date: 'date',
    timestamp: 'datetime',
    text: 'text',
  },
  sqlite: {
    integer: 'INTEGER',
    bigint: 'INTEGER',
    numeric: 'REAL',
    boolean: 'INTEGER',
    date: 'TEXT',
    timestamp: 'TEXT',
    text: 'TEXT',
  },
};

export function sqlTypeFor(dialect: DriverId, type: InferredType): string {
  return SQL_TYPES[dialect][type];
}

/** Lowercase ASCII slug of a header; '' when nothing usable is left. */
function slug(header: string): string {
  return header
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Turn a file header into a column name that needs no quoting in any dialect,
 * unique within `used` (which is updated with the result).
 */
export function suggestColumnName(header: string, used: Set<string>): string {
  let base = slug(header);
  if (base === '') base = 'col';
  else if (/^[0-9]/.test(base)) base = `col_${base}`;
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
  used.add(name);
  return name;
}

/** A header's column by name: exact, then case-insensitive, then by normalized slug. */
function matchByName(header: string, tableColumns: string[]): string | undefined {
  const exact = tableColumns.find((c) => c === header);
  if (exact !== undefined) return exact;
  const lower = header.toLowerCase();
  const caseless = tableColumns.find((c) => c.toLowerCase() === lower);
  if (caseless !== undefined) return caseless;
  const normalized = slug(header);
  if (normalized === '') return undefined;
  return tableColumns.find((c) => slug(c) === normalized);
}

/**
 * A header's column by a whole word of the header ("Full Name" maps to name),
 * only when exactly one column matches: "Email Address" against email and
 * address names both, so it maps to neither rather than to a guess.
 */
function matchByWord(header: string, tableColumns: string[]): string | undefined {
  const normalized = slug(header);
  if (normalized === '') return undefined;
  const words = new Set(normalized.split('_').filter((w) => w.length > 1));
  const byWord = tableColumns.filter((c) => {
    const columnSlug = slug(c);
    return words.has(columnSlug) || (columnSlug.includes('_') && columnSlug.split('_').every((w) => words.has(w)));
  });
  return byWord.length === 1 ? byWord[0] : undefined;
}

/**
 * Match a file header to a table column: exact, then case-insensitive, then by
 * normalized slug, then by a whole word of the header when that names exactly
 * one column.
 */
export function matchTableColumn(header: string, tableColumns: string[]): string | undefined {
  return matchByName(header, tableColumns) ?? matchByWord(header, tableColumns);
}

/**
 * Match every header at once so no table column is proposed twice: name
 * matches are settled first, then word matches over the columns still free
 * ("First Name" takes name, "Last Name" is left unmapped for the user).
 */
export function matchTableColumns(headers: string[], tableColumns: string[]): (string | undefined)[] {
  const taken = new Set<string>();
  const matches: (string | undefined)[] = headers.map((header) => {
    const match = matchByName(header, tableColumns.filter((c) => !taken.has(c)));
    if (match !== undefined) taken.add(match);
    return match;
  });
  return matches.map((match, i) => {
    if (match !== undefined) return match;
    const byWord = matchByWord(headers[i]!, tableColumns.filter((c) => !taken.has(c)));
    if (byWord !== undefined) taken.add(byWord);
    return byWord;
  });
}

/** The first target column mapped twice, or undefined when every mapped target is distinct. */
export function duplicateTarget(columns: { target: string }[]): string | undefined {
  const seen = new Set<string>();
  for (const column of columns) {
    const target = column.target.trim();
    if (!target) continue;
    if (seen.has(target)) return target;
    seen.add(target);
  }
  return undefined;
}

/**
 * Literal kind for a column the import itself creates. Derive it from the
 * inferred type rather than from the emitted SQL type: SQLite spells boolean
 * as INTEGER, which would otherwise turn yes/no cells into text.
 */
export function valueKindForInferred(type: InferredType): ValueKind {
  switch (type) {
    case 'integer':
    case 'bigint':
    case 'numeric':
      return 'numeric';
    case 'boolean':
      return 'boolean';
    default:
      return 'text';
  }
}

const NUMERIC_TYPES = new Set([
  'int',
  'integer',
  'int2',
  'int4',
  'int8',
  'tinyint',
  'smallint',
  'mediumint',
  'bigint',
  'serial',
  'smallserial',
  'bigserial',
  'decimal',
  'dec',
  'numeric',
  'fixed',
  'number',
  'real',
  'float',
  'float4',
  'float8',
  'double',
  'double precision',
  'year',
]);

const BOOLEAN_TYPES = new Set(['boolean', 'bool']);

/**
 * Map a column data type as reported by introspection (either dialect's
 * spelling, with or without modifiers) to how literals should be emitted.
 * MySQL's tinyint(1) is its boolean; other tinyints are numbers.
 */
export function valueKindForSqlType(sqlType: string): ValueKind {
  const lower = sqlType.trim().toLowerCase();
  const base = lower.replace(/\(.*$/, '').replace(/\s+(unsigned|signed|zerofill)\b.*$/, '').trim();
  if (BOOLEAN_TYPES.has(base)) return 'boolean';
  if (base === 'tinyint' && /^tinyint\s*\(\s*1\s*\)/.test(lower)) return 'boolean';
  if (NUMERIC_TYPES.has(base)) return 'numeric';
  return 'text';
}
