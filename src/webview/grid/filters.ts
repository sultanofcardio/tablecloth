// Text helpers for the WHERE and ORDER BY fields. The fields hold free text
// the user may edit by hand; header clicks and funnels compose into them.
import type { CellValue, DriverId } from '../../core/types';

export interface OrderTerm {
  /** Column name (unquoted) or the raw expression text. */
  column: string;
  direction: 'asc' | 'desc';
}

function stripQuotes(name: string): string {
  const first = name[0];
  if ((first === '"' || first === '`') && name.endsWith(first) && name.length >= 2) {
    return name.slice(1, -1).replaceAll(first + first, first);
  }
  return name;
}

/** Split on commas outside quotes and parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function parseOrderBy(text: string): OrderTerm[] {
  return splitTopLevel(text).map((part) => {
    const match = /^(.*?)\s+(asc|desc)(\s+nulls\s+(?:first|last))?$/i.exec(part);
    const column = stripQuotes((match ? match[1]! : part).trim());
    const direction = match && match[2]!.toLowerCase() === 'desc' ? 'desc' : 'asc';
    return { column, direction };
  });
}

/** Identifier spelling for generated clauses: bare when it survives folding, else quoted. */
export function quoteName(dialect: DriverId, name: string): string {
  const plain = dialect === 'mysql' ? /^[A-Za-z_$][A-Za-z0-9_$]*$/ : /^[a-z_][a-z0-9_]*$/;
  if (plain.test(name)) return name;
  const q = dialect === 'mysql' ? '`' : '"';
  return q + name.replaceAll(q, q + q) + q;
}

export function composeOrderBy(dialect: DriverId, terms: OrderTerm[]): string {
  return terms
    .map((t) => `${quoteName(dialect, t.column)}${t.direction === 'desc' ? ' DESC' : ''}`)
    .join(', ');
}

export interface SortMark {
  direction: 'asc' | 'desc';
  /** 1-based position when several columns sort, else 0. */
  index: number;
}

export function sortMark(orderBy: string, column: string): SortMark | undefined {
  const terms = parseOrderBy(orderBy);
  const i = terms.findIndex((t) => t.column.toLowerCase() === column.toLowerCase());
  if (i < 0) return undefined;
  return { direction: terms[i]!.direction, index: terms.length > 1 ? i + 1 : 0 };
}

/**
 * The IntelliJ header-click cycle: none -> ASC -> DESC -> none. Without
 * `multi` the clicked column replaces the whole ORDER BY; with it (Alt-click)
 * the column joins the existing terms.
 */
export function toggleSort(dialect: DriverId, orderBy: string, column: string, multi: boolean): string {
  const terms = parseOrderBy(orderBy);
  const i = terms.findIndex((t) => t.column.toLowerCase() === column.toLowerCase());
  const current = i >= 0 ? terms[i]! : undefined;
  let next: OrderTerm | undefined;
  if (!current) next = { column, direction: 'asc' };
  else if (current.direction === 'asc') next = { column, direction: 'desc' };
  else next = undefined;

  if (!multi) return next ? composeOrderBy(dialect, [next]) : '';
  const rest = terms.filter((_, idx) => idx !== i);
  if (next) {
    if (i >= 0) rest.splice(i, 0, next);
    else rest.push(next);
  }
  return composeOrderBy(dialect, rest);
}

export function sqlLiteral(dialect: DriverId, value: CellValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return dialect === 'sqlite' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE';
  let escaped = value.replaceAll("'", "''");
  if (dialect === 'mysql') escaped = escaped.replaceAll('\\', '\\\\');
  return `'${escaped}'`;
}

/** `col IN (...)`, `col = x`, `col IS NULL`, or a combination, for a funnel selection. */
export function funnelClause(dialect: DriverId, column: string, values: CellValue[]): string {
  const name = quoteName(dialect, column);
  const nonNull = values.filter((v) => v !== null);
  const hasNull = values.length !== nonNull.length;
  const parts: string[] = [];
  if (nonNull.length === 1) parts.push(`${name} = ${sqlLiteral(dialect, nonNull[0]!)}`);
  else if (nonNull.length > 1) parts.push(`${name} IN (${nonNull.map((v) => sqlLiteral(dialect, v)).join(', ')})`);
  if (hasNull) parts.push(`${name} IS NULL`);
  return parts.length > 1 ? `(${parts.join(' OR ')})` : (parts[0] ?? '');
}

/** AND a clause onto the WHERE text, replacing the previous clause for the same column. */
export function mergeWhere(where: string, previous: string | undefined, clause: string): string {
  let base = where;
  if (previous) {
    const idx = base.indexOf(previous);
    if (idx >= 0) {
      base = (base.slice(0, idx) + base.slice(idx + previous.length)).replace(/^\s*AND\s+/i, '');
      base = base.replace(/\s+AND\s*$/i, '').replace(/\s+AND\s+AND\s+/i, ' AND ').trim();
    }
  }
  if (!clause) return base;
  return base.trim() ? `${base.trim()} AND ${clause}` : clause;
}
