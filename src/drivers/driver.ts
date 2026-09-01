import type {
  CatalogModel,
  CellValue,
  ColumnInfo,
  DataSourceConfig,
  DataSourceSecrets,
  DriverId,
  QueryResult,
} from '../core/types';

export interface ConnectContext {
  config: DataSourceConfig;
  secrets: DataSourceSecrets;
}

/** A live connection ("session" in IntelliJ terms) to one data source. */
export interface DbSession {
  readonly dialect: DriverId;
  readonly serverVersion: string;
  /** Run a statement, returning display-normalized rows. */
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  /** Run a statement, returning raw driver values (driver-internal introspection use). */
  queryRaw(sql: string, params?: unknown[]): Promise<{ columns: string[]; rows: unknown[][] }>;
  close(): Promise<void>;
}

export interface Driver {
  readonly id: DriverId;
  readonly label: string;
  readonly defaultPort?: number;
  connect(ctx: ConnectContext): Promise<DbSession>;
  /** All schema-level names available for selection in the data source dialog. */
  listSchemas(session: DbSession): Promise<string[]>;
  introspect(session: DbSession, config: DataSourceConfig, showSystem: boolean): Promise<CatalogModel>;
}

// ---------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function formatDateValue(d: Date): string {
  const ms = d.getMilliseconds();
  const base =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return ms ? `${base}.${pad(ms, 3)}` : base;
}

const MAX_BINARY_PREVIEW = 64;

/** Collapse driver-specific values to the small set the grid and extractors understand. */
export function normalizeValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value as CellValue;
  if (t === 'bigint') {
    const b = value as bigint;
    return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b.toString();
  }
  if (value instanceof Date) return formatDateValue(value);
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value.buffer, value.byteOffset, Math.min(value.length, MAX_BINARY_PREVIEW)).toString('hex');
    return value.length > MAX_BINARY_PREVIEW ? `0x${hex}… (${value.length} bytes)` : `0x${hex}`;
  }
  if (Array.isArray(value)) {
    return `{${value.map((v) => String(normalizeValue(v) ?? 'NULL')).join(',')}}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeRows(rows: unknown[][]): CellValue[][] {
  return rows.map((row) => row.map(normalizeValue));
}

export function makeResult(columns: ColumnInfo[], rows: CellValue[][], affectedRows: number | null): QueryResult {
  return { columns, rows, affectedRows, hasRows: columns.length > 0 };
}
