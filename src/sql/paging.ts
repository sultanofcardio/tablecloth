import type { DriverId } from '../core/types';
import { quoteIdent } from '../core/util';

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

/** Strip a single trailing semicolon so the statement can be embedded in a subquery. */
export function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, '');
}

/**
 * Wrap an arbitrary SELECT-ish statement for offset paging. The caller fetches
 * `limit + 1` rows to learn whether more pages exist without a COUNT(*).
 *
 * Note: like every offset-based pager, ordering across pages is only guaranteed
 * when the sort is applied here (on the wrapper), not inside the query.
 */
export function wrapPaged(
  dialect: DriverId,
  sql: string,
  opts: { limit: number | null; offset: number; sort?: SortSpec },
): string {
  const inner = stripTrailingSemicolon(sql);
  const orderBy = opts.sort
    ? ` ORDER BY ${quoteIdent(dialect, opts.sort.column)} ${opts.sort.direction.toUpperCase()}`
    : '';
  const paging = opts.limit === null ? '' : ` LIMIT ${opts.limit} OFFSET ${opts.offset}`;
  return `SELECT * FROM (\n${inner}\n) AS _tablecloth_q${orderBy}${paging}`;
}

/** Wrap a SELECT-ish statement to count its full result set. */
export function wrapCount(dialect: DriverId, sql: string): string {
  const inner = stripTrailingSemicolon(sql);
  return `SELECT COUNT(*) FROM (\n${inner}\n) AS _tablecloth_q`;
}

/** Build the page query for browsing a table or view directly. */
export function tablePageQuery(
  dialect: DriverId,
  schema: string | undefined,
  table: string,
  opts: { limit: number | null; offset: number; sort?: SortSpec },
): string {
  const target = schema ? `${quoteIdent(dialect, schema)}.${quoteIdent(dialect, table)}` : quoteIdent(dialect, table);
  const orderBy = opts.sort
    ? ` ORDER BY ${quoteIdent(dialect, opts.sort.column)} ${opts.sort.direction.toUpperCase()}`
    : '';
  const limit = opts.limit === null ? '' : ` LIMIT ${opts.limit}`;
  const offset = opts.offset > 0 ? ` OFFSET ${opts.offset}` : '';
  // MySQL requires LIMIT when OFFSET is used; "all rows from an offset" only
  // arises with limit=null which the grid never combines with an offset.
  return `SELECT * FROM ${target}${orderBy}${limit}${offset}`;
}

export function tableCountQuery(dialect: DriverId, schema: string | undefined, table: string): string {
  const target = schema ? `${quoteIdent(dialect, schema)}.${quoteIdent(dialect, table)}` : quoteIdent(dialect, table);
  return `SELECT COUNT(*) FROM ${target}`;
}
