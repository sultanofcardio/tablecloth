import type { DriverId } from './types';

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
