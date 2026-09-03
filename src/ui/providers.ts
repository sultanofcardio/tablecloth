import { computeFilterCompletions, type CompletionEntry, type FilterField } from '../complete/core';
import type { CellValue, ColumnInfo, DataSourceConfig, DriverId, TxIsolation, TxMode } from '../core/types';
import { errorMessage } from '../core/util';
import type { ChangeStatement, EditTarget } from '../edit/changeSet';
import type { DbSession } from '../drivers/driver';
import type { SessionManager } from '../drivers/sessions';
import {
  tableCountQuery,
  tableDistinctQuery,
  tablePageQuery,
  tableViewQuery,
  wrapCount,
  wrapDistinct,
  wrapPaged,
} from '../sql/paging';
import type { FetchOptions, GridEditing, GridPage, GridProvider, GridTxControl, RunQuery } from './grid';
import type { GridTxDto, ReferencingDto } from './gridProtocol';

/** Run a query on the data source's session, measuring wall-clock duration. */
export function makeRunQuery(sessions: SessionManager, config: DataSourceConfig, suffix?: string): RunQuery {
  return async (sql: string, params?: unknown[]) => {
    const started = Date.now();
    const result = await sessions.run(config, (session) => session.query(sql, params), suffix);
    return { columns: result.columns, rows: result.rows, durationMs: Date.now() - started };
  };
}

async function fetchPageWith(
  run: RunQuery,
  buildSql: (limit: number | null, offset: number) => string,
  opts: FetchOptions,
  params?: unknown[],
): Promise<GridPage> {
  // Fetch one extra row to learn whether more pages exist without COUNT(*).
  const limit = opts.limit === null ? null : opts.limit + 1;
  const { columns, rows, durationMs } = await run(buildSql(limit, opts.offset), params);
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

function beginSql(dialect: DriverId): string {
  return dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN';
}

const ISOLATION_SQL: Record<Exclude<TxIsolation, 'default'>, string> = {
  'read-committed': 'READ COMMITTED',
  'repeatable-read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

/**
 * Run reviewed DML atomically on a session. Each UPDATE and DELETE must touch
 * exactly one row (a key that turned out to be non-unique would otherwise
 * change more than the user reviewed); anything else rolls the batch back.
 * Inside an open manual transaction the batch runs under a savepoint so a
 * failure leaves the user's transaction usable.
 */
export async function runChangeBatch(
  session: DbSession,
  statements: ChangeStatement[],
  opts: { joinOpenTransaction: boolean; commit: boolean },
): Promise<void> {
  const savepoint = opts.joinOpenTransaction;
  if (savepoint) await session.query('SAVEPOINT tablecloth_submit');
  else await session.query(beginSql(session.dialect));
  try {
    for (const statement of statements) {
      const result = await session.query(statement.sql);
      const affected = result.affectedRows;
      if ((statement.kind === 'update' || statement.kind === 'delete') && affected !== null && affected !== 1) {
        throw new Error(
          `${statement.sql}\nmatched ${affected} row${affected === 1 ? '' : 's'} instead of exactly 1; nothing was changed.`,
        );
      }
    }
    if (savepoint) await session.query('RELEASE SAVEPOINT tablecloth_submit');
    else if (opts.commit) await session.query('COMMIT');
  } catch (err) {
    if (savepoint) {
      await session.query('ROLLBACK TO SAVEPOINT tablecloth_submit').catch(() => undefined);
      await session.query('RELEASE SAVEPOINT tablecloth_submit').catch(() => undefined);
    } else {
      await session.query('ROLLBACK').catch(() => undefined);
    }
    throw err;
  }
}

/**
 * Transaction control for a table data editor. Auto mode submits on the
 * shared main session inside BEGIN/COMMIT; Manual mode moves the editor onto
 * its own session, where submits accumulate until Commit or Roll Back.
 */
class TableTxControl implements GridTxControl {
  mode: TxMode = 'auto';
  isolation: TxIsolation = 'default';
  inTx = false;
  private readonly appliedIsolation = new WeakMap<DbSession, TxIsolation>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly config: DataSourceConfig,
    private readonly dedicatedSuffix: string,
    private readonly onChange: () => void,
  ) {}

  /** The session suffix reads and writes go to under the current mode. */
  suffix(): string | undefined {
    return this.mode === 'manual' ? this.dedicatedSuffix : undefined;
  }

  state(): GridTxDto {
    return {
      mode: this.mode,
      isolation: this.isolation,
      inTx: this.inTx,
      supportsIsolation: this.config.driver !== 'sqlite',
    };
  }

  async pick(itemId: string): Promise<void> {
    const [group, value] = itemId.split('|');
    if (group === 'mode' && (value === 'auto' || value === 'manual') && value !== this.mode) {
      if (value === 'auto' && this.inTx) {
        const vscode = await import('vscode');
        const answer = await vscode.window.showWarningMessage(
          'This data editor has an open transaction. Finish it before switching to Auto.',
          { modal: true },
          'Commit',
          'Roll Back',
        );
        if (!answer) return;
        if (answer === 'Commit') await this.commit();
        else await this.rollback();
      }
      this.mode = value;
      if (value === 'auto') await this.sessions.closeSession(this.config.id, this.dedicatedSuffix);
      this.onChange();
      return;
    }
    if (group === 'iso' && value && value !== this.isolation) {
      this.isolation = value as TxIsolation;
      this.onChange();
    }
  }

  /** Apply the chosen isolation level to a dedicated session once. */
  async ensureIsolation(session: DbSession): Promise<void> {
    if (this.isolation === 'default' || this.appliedIsolation.get(session) === this.isolation) return;
    const level = ISOLATION_SQL[this.isolation];
    const sql =
      this.config.driver === 'postgres'
        ? `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL ${level}`
        : `SET SESSION TRANSACTION ISOLATION LEVEL ${level}`;
    await session.query(sql);
    this.appliedIsolation.set(session, this.isolation);
  }

  async submit(statements: ChangeStatement[]): Promise<void> {
    if (this.mode === 'auto') {
      await this.sessions.run(this.config, (session) =>
        runChangeBatch(session, statements, { joinOpenTransaction: false, commit: true }),
      );
      return;
    }
    await this.sessions.run(
      this.config,
      async (session) => {
        await this.ensureIsolation(session);
        if (!this.inTx) {
          await session.query(beginSql(session.dialect));
          this.inTx = true;
          this.onChange();
        }
        await runChangeBatch(session, statements, { joinOpenTransaction: true, commit: false });
      },
      this.dedicatedSuffix,
    );
  }

  private async end(statement: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    if (!this.inTx) throw new Error('No open transaction on this data editor.');
    try {
      await this.sessions.run(this.config, (session) => session.query(statement), this.dedicatedSuffix);
    } finally {
      this.inTx = false;
      this.onChange();
    }
  }

  commit(): Promise<void> {
    return this.end('COMMIT');
  }

  rollback(): Promise<void> {
    return this.end('ROLLBACK');
  }

  /** The session died or was disconnected: whatever was open is gone. */
  sessionClosed(): void {
    if (this.inTx) {
      this.inTx = false;
      this.onChange();
    }
  }
}

export interface TableEditingOptions {
  target: EditTarget;
  referencing: ReferencingDto[];
  /** Unique per data editor; names its dedicated session in Manual mode. */
  panelKey: string;
  onTxChange: () => void;
}

/** Browses a table or view directly (the data editor opened from the tree). */
export class TableGridProvider implements GridProvider {
  readonly supportsFilter = true;
  readonly editing?: GridEditing;
  readonly referencing?: ReferencingDto[];
  private readonly tx?: TableTxControl;

  constructor(
    readonly dialect: DriverId,
    private readonly schema: string | undefined,
    private readonly table: string,
    readonly keyColumns: string[],
    readonly tableName: string,
    private readonly sessions: SessionManager,
    private readonly config: DataSourceConfig,
    editing?: TableEditingOptions,
  ) {
    if (editing) {
      const tx = new TableTxControl(sessions, config, `table:${editing.panelKey}`, editing.onTxChange);
      this.tx = tx;
      this.referencing = editing.referencing;
      this.editing = {
        target: editing.target,
        submit: (statements) => tx.submit(statements),
        tx,
      };
    }
  }

  /** Called by the panel when a session of this data source closes. */
  onSessionClosed(suffix: string): void {
    if (this.tx && suffix === this.tx.suffix()) this.tx.sessionClosed();
  }

  private run(): RunQuery {
    return makeRunQuery(this.sessions, this.config, this.tx?.suffix());
  }

  fetchPage(opts: FetchOptions): Promise<GridPage> {
    return fetchPageWith(
      this.run(),
      (limit, offset) =>
        tablePageQuery(this.dialect, this.schema, this.table, { limit, offset, where: opts.where, orderBy: opts.orderBy }),
      opts,
    );
  }

  async fetchCount(where?: string): Promise<number | undefined> {
    const { rows } = await this.run()(tableCountQuery(this.dialect, this.schema, this.table, where));
    return scalarCount(rows);
  }

  async fetchDistinct(column: string, where: string | undefined, limit: number): Promise<CellValue[]> {
    const { rows } = await this.run()(tableDistinctQuery(this.dialect, this.schema, this.table, column, where, limit));
    return rows.map((r) => r[0] ?? null);
  }

  queryText(opts: Pick<FetchOptions, 'where' | 'orderBy'>): string {
    return tableViewQuery(this.dialect, this.schema, this.table, opts);
  }

  async cancel(): Promise<boolean> {
    if (!this.sessions.canCancel(this.config)) return false;
    return this.sessions.cancel(this.config, this.tx?.suffix());
  }

  completions(field: FilterField, text: string, offset: number, columns: ColumnInfo[]): CompletionEntry[] {
    const catalog = this.sessions.getCatalog(this.config.id);
    if (!catalog) {
      // the page columns cover the gap while the model warms up in the background
      if (this.config.autoSync) void this.sessions.introspect(this.config).catch(() => undefined);
      return computeFilterCompletions({ columns }, this.dialect, field, text, offset);
    }
    return computeFilterCompletions({ catalog, table: this.tableName }, this.dialect, field, text, offset);
  }
}

export interface ConsoleEditingOptions {
  target: EditTarget;
  referencing: ReferencingDto[];
  /** Runs the batch on the console's session under the console's transaction mode. */
  submit(statements: ChangeStatement[]): Promise<void>;
}

/** Pages an arbitrary SELECT-ish console statement by wrapping it in a subquery. */
export class ConsoleGridProvider implements GridProvider {
  readonly tableName = undefined;
  readonly supportsFilter = true;
  readonly editing?: GridEditing;
  readonly referencing?: ReferencingDto[];

  constructor(
    readonly dialect: DriverId,
    private readonly baseSql: string,
    private readonly run: RunQuery,
    private readonly params?: unknown[],
    private readonly cancelFn?: () => Promise<boolean>,
    editing?: ConsoleEditingOptions,
  ) {
    if (editing) {
      this.referencing = editing.referencing;
      this.editing = { target: editing.target, submit: editing.submit };
    }
  }

  fetchPage(opts: FetchOptions): Promise<GridPage> {
    return fetchPageWith(
      this.run,
      (limit, offset) => wrapPaged(this.dialect, this.baseSql, { limit, offset, where: opts.where, orderBy: opts.orderBy }),
      opts,
      this.params,
    );
  }

  async fetchCount(where?: string): Promise<number | undefined> {
    const { rows } = await this.run(wrapCount(this.dialect, this.baseSql, where), this.params);
    return scalarCount(rows);
  }

  async fetchDistinct(column: string, where: string | undefined, limit: number): Promise<CellValue[]> {
    const { rows } = await this.run(wrapDistinct(this.dialect, this.baseSql, column, where, limit), this.params);
    return rows.map((r) => r[0] ?? null);
  }

  queryText(opts: Pick<FetchOptions, 'where' | 'orderBy'>): string {
    if (!opts.where?.trim() && !opts.orderBy?.trim()) return this.baseSql;
    return wrapPaged(this.dialect, this.baseSql, { limit: null, offset: 0, where: opts.where, orderBy: opts.orderBy });
  }

  get cancel(): (() => Promise<boolean>) | undefined {
    return this.cancelFn;
  }

  /** The result's own columns: a console statement may alias or compute them. */
  completions(field: FilterField, text: string, offset: number, columns: ColumnInfo[]): CompletionEntry[] {
    return computeFilterCompletions({ columns }, this.dialect, field, text, offset);
  }
}

export function describeError(err: unknown): string {
  return errorMessage(err);
}
