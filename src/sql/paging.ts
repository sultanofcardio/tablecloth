import type { DriverId } from '../core/types';
import { quoteIdent, sqlName } from '../core/util';

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export interface PageOptions {
  limit: number | null;
  offset: number;
  /** Legacy single-column sort; `orderBy` text wins when both are given. */
  sort?: SortSpec;
  /** Free WHERE text from the grid's filter field (no leading WHERE). */
  where?: string;
  /** Free ORDER BY text from the grid's sort field (no leading ORDER BY). */
  orderBy?: string;
}

/** Strip a single trailing semicolon so the statement can be embedded in a subquery. */
export function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, '');
}

function clauses(dialect: DriverId, opts: Pick<PageOptions, 'sort' | 'where' | 'orderBy'>): string {
  const where = opts.where?.trim() ? ` WHERE ${opts.where.trim()}` : '';
  let orderBy = '';
  if (opts.orderBy?.trim()) orderBy = ` ORDER BY ${opts.orderBy.trim()}`;
  else if (opts.sort) orderBy = ` ORDER BY ${quoteIdent(dialect, opts.sort.column)} ${opts.sort.direction.toUpperCase()}`;
  return where + orderBy;
}

/**
 * Wrap an arbitrary SELECT-ish statement for offset paging. The caller fetches
 * `limit + 1` rows to learn whether more pages exist without a COUNT(*).
 *
 * Note: like every offset-based pager, ordering across pages is only guaranteed
 * when the sort is applied here (on the wrapper), not inside the query.
 */
export function wrapPaged(dialect: DriverId, sql: string, opts: PageOptions): string {
  const inner = stripTrailingSemicolon(sql);
  const paging = opts.limit === null ? '' : ` LIMIT ${opts.limit} OFFSET ${opts.offset}`;
  return `SELECT * FROM (\n${inner}\n) AS _tablecloth_q${clauses(dialect, opts)}${paging}`;
}

/** Wrap a SELECT-ish statement to count its (filtered) result set. */
export function wrapCount(dialect: DriverId, sql: string, where?: string): string {
  const inner = stripTrailingSemicolon(sql);
  return `SELECT COUNT(*) FROM (\n${inner}\n) AS _tablecloth_q${clauses(dialect, { where })}`;
}

/** Distinct values of one column of a wrapped statement, for the header funnel. */
export function wrapDistinct(dialect: DriverId, sql: string, column: string, where: string | undefined, limit: number): string {
  const inner = stripTrailingSemicolon(sql);
  const name = sqlName(dialect, column);
  return `SELECT DISTINCT ${name} FROM (\n${inner}\n) AS _tablecloth_q${clauses(dialect, { where })} ORDER BY ${name} LIMIT ${limit}`;
}

function targetName(dialect: DriverId, schema: string | undefined, table: string): string {
  return schema ? `${quoteIdent(dialect, schema)}.${quoteIdent(dialect, table)}` : quoteIdent(dialect, table);
}

/** Build the page query for browsing a table or view directly. */
export function tablePageQuery(dialect: DriverId, schema: string | undefined, table: string, opts: PageOptions): string {
  const limit = opts.limit === null ? '' : ` LIMIT ${opts.limit}`;
  const offset = opts.offset > 0 ? ` OFFSET ${opts.offset}` : '';
  // MySQL requires LIMIT when OFFSET is used; "all rows from an offset" only
  // arises with limit=null which the grid never combines with an offset.
  return `SELECT * FROM ${targetName(dialect, schema, table)}${clauses(dialect, opts)}${limit}${offset}`;
}

export function tableCountQuery(dialect: DriverId, schema: string | undefined, table: string, where?: string): string {
  return `SELECT COUNT(*) FROM ${targetName(dialect, schema, table)}${clauses(dialect, { where })}`;
}

export function tableDistinctQuery(
  dialect: DriverId,
  schema: string | undefined,
  table: string,
  column: string,
  where: string | undefined,
  limit: number,
): string {
  const name = sqlName(dialect, column);
  return `SELECT DISTINCT ${name} FROM ${targetName(dialect, schema, table)}${clauses(dialect, { where })} ORDER BY ${name} LIMIT ${limit}`;
}

/** The statement the grid shows for a table, without paging (View Query). */
export function tableViewQuery(dialect: DriverId, schema: string | undefined, table: string, opts: Pick<PageOptions, 'where' | 'orderBy'>): string {
  return `SELECT * FROM ${targetName(dialect, schema, table)}${clauses(dialect, opts)}`;
}
