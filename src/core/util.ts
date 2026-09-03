import type { DriverId, StorageScope } from './types';
import { SQL_RESERVED_WORDS } from '../sql/reserved';
import { SQL_KEYWORDS } from '../sql/tokens';

/**
 * Where a new data source is stored when the user has not chosen. Project
 * (workspace settings) keeps a source with the code it belongs to, so it wins
 * whenever a workspace folder is open and trusted; otherwise only Global works.
 */
export function defaultStorageScope(hasWorkspaceFolder: boolean, workspaceTrusted: boolean): StorageScope {
  return hasWorkspaceFolder && workspaceTrusted ? 'project' : 'global';
}

/** Quote an identifier for the given dialect, doubling embedded quote characters. */
export function quoteIdent(dialect: DriverId, name: string): string {
  if (dialect === 'mysql') {
    return '`' + name.replaceAll('`', '``') + '`';
  }
  return '"' + name.replaceAll('"', '""') + '"';
}

/** Qualify and quote schema.name, omitting the schema when absent. */
export function qualify(dialect: DriverId, schema: string | undefined, name: string): string {
  return schema ? `${quoteIdent(dialect, schema)}.${quoteIdent(dialect, name)}` : quoteIdent(dialect, name);
}

/** A conservative check for names that can be used bare inside generated SQL. */
export function isPlainIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * An identifier as generated SQL must spell it: bare when the dialect resolves
 * the bare form to the same object (Postgres and SQLite fold unquoted names to
 * lowercase, MySQL keeps case), quoted for keywords, words reserved by any
 * supported dialect, and anything else.
 */
export function sqlName(dialect: DriverId, name: string): string {
  const plain = dialect === 'mysql' ? /^[A-Za-z_$][A-Za-z0-9_$]*$/ : /^[a-z_][a-z0-9_]*$/;
  const lower = name.toLowerCase();
  if (plain.test(name) && !SQL_KEYWORDS.has(lower) && !SQL_RESERVED_WORDS.has(lower)) return name;
  return quoteIdent(dialect, name);
}

/** Escape a string literal for SQL ('' doubling; safe for all three dialects with backslash doubling for MySQL). */
export function quoteLiteral(dialect: DriverId, value: string): string {
  let escaped = value.replaceAll("'", "''");
  if (dialect === 'mysql') {
    escaped = escaped.replaceAll('\\', '\\\\');
  }
  return `'${escaped}'`;
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'source';
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

export function timestamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

export function formatMillis(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
