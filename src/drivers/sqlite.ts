import { Database } from 'node-sqlite3-wasm';
import { classifyStatement } from '../sql/classify';
import { quoteIdent } from '../core/util';
import type { CatalogModel, DataSourceConfig, QueryResult, RelationModel, SchemaModel } from '../core/types';
import type { ConnectContext, DbSession, Driver } from './driver';
import { makeResult, normalizeRows, normalizeValue } from './driver';

/**
 * SQLite runs in-process through a WebAssembly build, so nothing native has to
 * be compiled for the extension host. The wasm API returns rows as objects, so
 * duplicate column names in one SELECT collapse to the last one.
 */
class SqliteSession implements DbSession {
  readonly dialect = 'sqlite' as const;

  constructor(
    private readonly db: Database,
    readonly serverVersion: string,
  ) {}

  private rowsToArrays(records: Record<string, unknown>[]): { columns: string[]; rows: unknown[][] } {
    if (records.length === 0) return { columns: [], rows: [] };
    const columns = Object.keys(records[0]!);
    const rows = records.map((r) => columns.map((c) => r[c]));
    return { columns, rows };
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const cls = classifyStatement(sql);
    const wantsRows = cls.selectish || /\breturning\b/i.test(sql);
    if (wantsRows) {
      const records = this.db.all(sql, params as any) as Record<string, unknown>[];
      const { columns, rows } = this.rowsToArrays(records);
      const colInfos = columns.map((name) => {
        const first = records.find((r) => r[name] !== null && r[name] !== undefined)?.[name];
        return { name, numeric: typeof first === 'number' || typeof first === 'bigint' };
      });
      // db.all on a zero-row SELECT cannot report column names; show an empty grid.
      return makeResult(colInfos, normalizeRows(rows), null);
    }
    const result = this.db.run(sql, params as any);
    return makeResult([], [], result.changes);
  }

  async queryRaw(sql: string, params?: unknown[]): Promise<{ columns: string[]; rows: unknown[][] }> {
    const records = this.db.all(sql, params as any) as Record<string, unknown>[];
    return this.rowsToArrays(records);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export const sqliteDriver: Driver = {
  id: 'sqlite',
  label: 'SQLite',

  async connect(ctx: ConnectContext): Promise<DbSession> {
    const { config } = ctx;
    if (!config.file) {
      throw new Error('SQLite data source has no database file configured.');
    }
    const db = new Database(config.file, { fileMustExist: false, readOnly: config.readOnly });
    try {
      const version = db.get('SELECT sqlite_version() AS v') as { v?: unknown } | null;
      if (config.readOnly) {
        db.exec('PRAGMA query_only = ON');
      }
      db.exec('PRAGMA foreign_keys = ON');
      return new SqliteSession(db, `SQLite ${String(normalizeValue(version?.v) ?? '')}`);
    } catch (err) {
      db.close();
      throw err;
    }
  },

  async listSchemas(): Promise<string[]> {
    return ['main'];
  },

  async introspect(session: DbSession, _config: DataSourceConfig, showSystem: boolean): Promise<CatalogModel> {
    const schema: SchemaModel = { name: 'main', implicit: true, relations: [], routines: [], enums: [], sequences: [] };

    const rels = await session.queryRaw(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table','view') ${showSystem ? '' : "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"}
       ORDER BY name`,
    );
    for (const [name, type] of rels.rows as [string, string][]) {
      const rel: RelationModel = { name, kind: type === 'view' ? 'view' : 'table', columns: [], indexes: [] };
      schema.relations.push(rel);

      // table_xinfo adds the hidden flag (2/3 = generated column) to table_info
      const cols = await session.queryRaw(`PRAGMA table_xinfo(${quoteIdent('sqlite', name)})`);
      const colIdx = indexColumns(cols.columns);
      for (const row of cols.rows) {
        const hidden = colIdx.hidden === undefined ? 0 : Number(row[colIdx.hidden] ?? 0);
        if (hidden === 1) continue; // virtual-table hidden columns
        rel.columns.push({
          name: String(row[colIdx.name!]),
          dataType: String(row[colIdx.type!] ?? '') || 'any',
          nullable: !row[colIdx.notnull!],
          primaryKey: Number(row[colIdx.pk!] ?? 0) > 0,
          default: row[colIdx.dflt_value!] === null ? undefined : String(row[colIdx.dflt_value!]),
          ...(hidden >= 2 ? { generated: true } : {}),
        });
      }
      // a lone INTEGER PRIMARY KEY is the rowid alias: the engine assigns it
      const pkColumns = rel.columns.filter((c) => c.primaryKey);
      if (pkColumns.length === 1 && /^integer$/i.test(pkColumns[0]!.dataType)) pkColumns[0]!.autoIncrement = true;

      if (rel.kind === 'table') {
        const fks = await session.queryRaw(`PRAGMA foreign_key_list(${quoteIdent('sqlite', name)})`);
        const fkIdx = indexColumns(fks.columns);
        for (const row of fks.rows) {
          const col = rel.columns.find((c) => c.name === String(row[fkIdx.from!]));
          if (!col) continue;
          col.foreignKeyTarget = String(row[fkIdx.table!]);
          const to = fkIdx.to === undefined ? null : row[fkIdx.to];
          if (to !== null && to !== undefined) col.foreignKeyColumn = String(to);
        }

        const idxList = await session.queryRaw(`PRAGMA index_list(${quoteIdent('sqlite', name)})`);
        const ilIdx = indexColumns(idxList.columns);
        for (const row of idxList.rows) {
          const idxName = String(row[ilIdx.name!]);
          if (idxName.startsWith('sqlite_autoindex_')) continue;
          const info = await session.queryRaw(`PRAGMA index_info(${quoteIdent('sqlite', idxName)})`);
          const iiIdx = indexColumns(info.columns);
          rel.indexes.push({
            name: idxName,
            unique: !!row[ilIdx.unique!],
            columns: info.rows.map((r) => (r[iiIdx.name!] === null ? '(expr)' : String(r[iiIdx.name!]))),
          });
        }
      }
    }

    return {
      databases: [{ name: 'main', schemas: [schema], allSchemaNames: ['main'] }],
      introspectedAt: Date.now(),
      serverVersion: session.serverVersion,
    };
  },
};

/** PRAGMA result column order varies across SQLite builds; index by name. */
function indexColumns(columns: string[]): Record<string, number | undefined> {
  const map: Record<string, number | undefined> = {};
  columns.forEach((c, i) => (map[c] = i));
  return map;
}
