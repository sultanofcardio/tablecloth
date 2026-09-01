import type { CellValue, DataSourceConfig, DriverId } from '../core/types';
import type { SessionManager } from '../drivers/sessions';
import { tableCountQuery, tablePageQuery, wrapCount, wrapPaged, type SortSpec } from '../sql/paging';
import type { GridPage, GridProvider, RunQuery } from './grid';

/** Run a query on the data source's session, measuring wall-clock duration. */
export function makeRunQuery(sessions: SessionManager, config: DataSourceConfig): RunQuery {
  return async (sql: string) => {
    const started = Date.now();
    const result = await sessions.run(config, (session) => session.query(sql));
    return { columns: result.columns, rows: result.rows, durationMs: Date.now() - started };
  };
}

async function fetchPageWith(
  run: RunQuery,
  buildSql: (limit: number | null, offset: number, sort?: SortSpec) => string,
  opts: { offset: number; limit: number | null; sort?: SortSpec },
): Promise<GridPage> {
  // Fetch one extra row to learn whether more pages exist without COUNT(*).
  const limit = opts.limit === null ? null : opts.limit + 1;
  const { columns, rows, durationMs } = await run(buildSql(limit, opts.offset, opts.sort));
  const hasMore = opts.limit !== null && rows.length > opts.limit;
  return {
    columns,
    rows: hasMore ? rows.slice(0, opts.limit!) : rows,
    offset: opts.offset,
    hasMore,
    durationMs,
  };
}

function scalarCount(rows: CellValue[][]): number | undefined {
  const value = rows[0]?.[0];
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Browses a table or view directly (the data editor opened from the tree). */
export class TableGridProvider implements GridProvider {
  constructor(
    readonly dialect: DriverId,
    private readonly schema: string | undefined,
    private readonly table: string,
    readonly keyColumns: string[],
    readonly tableName: string,
    private readonly run: RunQuery,
  ) {}

  fetchPage(opts: { offset: number; limit: number | null; sort?: SortSpec }): Promise<GridPage> {
    return fetchPageWith(
      this.run,
      (limit, offset, sort) => tablePageQuery(this.dialect, this.schema, this.table, { limit, offset, sort }),
      opts,
    );
  }

  async fetchCount(): Promise<number | undefined> {
    const { rows } = await this.run(tableCountQuery(this.dialect, this.schema, this.table));
    return scalarCount(rows);
  }
}

/** Pages an arbitrary SELECT-ish console statement by wrapping it in a subquery. */
export class ConsoleGridProvider implements GridProvider {
  readonly tableName = undefined;

  constructor(
    readonly dialect: DriverId,
    private readonly baseSql: string,
    private readonly run: RunQuery,
  ) {}

  fetchPage(opts: { offset: number; limit: number | null; sort?: SortSpec }): Promise<GridPage> {
    return fetchPageWith(
      this.run,
      (limit, offset, sort) => wrapPaged(this.dialect, this.baseSql, { limit, offset, sort }),
      opts,
    );
  }

  async fetchCount(): Promise<number | undefined> {
    const { rows } = await this.run(wrapCount(this.dialect, this.baseSql));
    return scalarCount(rows);
  }
}
