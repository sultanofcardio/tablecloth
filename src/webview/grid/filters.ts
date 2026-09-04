// Text helpers for the WHERE and ORDER BY fields. The fields hold free text
// the user may edit by hand; header clicks and funnels compose into them.
import type { CellValue, DriverId } from '../../core/types';
import { quoteLiteral, sqlName } from '../../core/util';
import { significant, tokenize } from '../../sql/tokens';

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
    const match = /^(.*?)(?:\s+(asc|desc))?(\s+nulls\s+(?:first|last))?$/i.exec(part);
    const column = stripQuotes((match ? match[1]! : part).trim());
    const direction = match?.[2]?.toLowerCase() === 'desc' ? 'desc' : 'asc';
    return { column, direction };
  });
}

/** Identifier spelling for generated clauses: bare when it survives folding and is no keyword, else quoted. */
export function quoteName(dialect: DriverId, name: string): string {
  return sqlName(dialect, name);
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
  const rawTerms = splitTopLevel(orderBy);
  const terms = parseOrderBy(orderBy);
  const i = terms.findIndex((t) => t.column.toLowerCase() === column.toLowerCase());
  const current = i >= 0 ? terms[i]! : undefined;
  let next: OrderTerm | undefined;
  if (!current) next = { column, direction: 'asc' };
  else if (current.direction === 'asc') next = { column, direction: 'desc' };
  else next = undefined;

  if (!multi) return next ? composeOrderBy(dialect, [next]) : '';
  const rest = rawTerms.filter((_, idx) => idx !== i);
  if (next) {
    const existing = i >= 0 ? rawTerms[i] : undefined;
    const match = existing ? /^(.*?)(?:\s+(?:asc|desc))?(\s+nulls\s+(?:first|last))?$/i.exec(existing) : undefined;
    const rendered = match
      ? `${match[1]!.trim()}${next.direction === 'desc' ? ' DESC' : ''}${match[2] ?? ''}`
      : composeOrderBy(dialect, [next]);
    if (i >= 0) rest.splice(i, 0, rendered);
    else rest.push(rendered);
  }
  return rest.join(', ');
}

export function sqlLiteral(dialect: DriverId, value: CellValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return dialect === 'sqlite' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE';
  return quoteLiteral(dialect, value);
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

/** Whether the text has an OR outside quotes and parentheses, so ANDing onto it needs parentheses. */
function hasTopLevelOr(dialect: DriverId, text: string): boolean {
  let depth = 0;
  for (const token of significant(tokenize(text, dialect))) {
    if (token.text === '(') depth++;
    else if (token.text === ')') depth--;
    else if (depth === 0 && token.kind === 'word' && token.value === 'or') return true;
  }
  return false;
}

/**
 * The WHERE text as the field shows it: the hand-written part first, then
 * one clause per funnelled column, all joined with AND. The manual part is
 * parenthesized only when a top-level OR would otherwise bind wrongly, so
 * recomposing after every funnel change never grows the text.
 */
export function composeWhere(dialect: DriverId, manual: string, funnels: Iterable<string>): string {
  const clauses = [...funnels].map((clause) => clause.trim()).filter(Boolean);
  const text = manual.trim();
  if (!text) return clauses.join(' AND ');
  if (clauses.length === 0) return text;
  return [hasTopLevelOr(dialect, text) ? `(${text})` : text, ...clauses].join(' AND ');
}

export interface WhereParts {
  /** The user-typed part of the WHERE text. */
  manual: string;
  /** Funnel clauses per column, in application order. */
  funnels: Map<string, string>;
}

/**
 * Reconcile the funnel bookkeeping with the WHERE text a result came back
 * with. Text that still equals the composed form keeps its funnels; anything
 * else was edited by hand and becomes the manual part, with no funnels.
 */
export function resyncWhere(dialect: DriverId, where: string, parts: WhereParts): WhereParts {
  if (where.trim() === composeWhere(dialect, parts.manual, parts.funnels.values())) {
    return { manual: parts.manual, funnels: new Map(parts.funnels) };
  }
  return { manual: where, funnels: new Map() };
}
