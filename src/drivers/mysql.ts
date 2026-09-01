import { readFileSync } from 'node:fs';
import * as mysql from 'mysql2/promise';
import type {
  CatalogModel,
  DataSourceConfig,
  DatabaseModel,
  IndexModel,
  QueryResult,
  RelationModel,
  SchemaModel,
} from '../core/types';
import type { ConnectContext, DbSession, Driver } from './driver';
import { makeResult, normalizeRows } from './driver';
import { openSshTunnel, type SshTunnel } from './ssh';

/** mysql2 column type codes that should right-align as numbers. */
const NUMERIC_TYPE_CODES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 246]);

const TYPE_NAMES: Record<number, string> = {
  0: 'decimal',
  1: 'tinyint',
  2: 'smallint',
  3: 'int',
  4: 'float',
  5: 'double',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  15: 'varchar',
  16: 'bit',
  245: 'json',
  246: 'decimal',
  247: 'enum',
  248: 'set',
  249: 'tinyblob',
  250: 'mediumblob',
  251: 'longblob',
  252: 'blob',
  253: 'varchar',
  254: 'char',
  255: 'geometry',
};

const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

class MySqlSession implements DbSession {
  readonly dialect = 'mysql' as const;

  constructor(
    private readonly connection: mysql.Connection,
    readonly serverVersion: string,
    private readonly tunnel?: SshTunnel,
  ) {}

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    let [rows, fields] = await this.connection.query({ sql, values: params, rowsAsArray: true });
    // A CALL of a rowset-returning procedure yields nested result sets
    // ([resultRows[], ResultSetHeader]) with per-set field arrays; present the
    // last row-bearing one (mirrors the pg lastResult normalization).
    if (Array.isArray(fields) && fields.some((f) => Array.isArray(f))) {
      const sets = rows as unknown[];
      const fieldSets = fields as unknown as (mysql.FieldPacket[] | undefined)[];
      let picked = -1;
      for (let i = fieldSets.length - 1; i >= 0; i--) {
        if (Array.isArray(fieldSets[i]) && fieldSets[i]!.length > 0 && Array.isArray(sets[i])) {
          picked = i;
          break;
        }
      }
      if (picked >= 0) {
        rows = sets[picked] as typeof rows;
        fields = fieldSets[picked] as typeof fields;
      } else {
        const header = sets.find((s): s is mysql.ResultSetHeader => !!s && !Array.isArray(s));
        return makeResult([], [], header?.affectedRows ?? null);
      }
    }
    if (Array.isArray(rows)) {
      const cols = (fields ?? []).map((f: any) => {
        const code = typeof f.columnType === 'number' ? f.columnType : f.type;
        return {
          name: String(f.name),
          dataType: TYPE_NAMES[code],
          numeric: NUMERIC_TYPE_CODES.has(code),
        };
      });
      return makeResult(cols, normalizeRows(rows as unknown[][]), null);
    }
    const header = rows as mysql.ResultSetHeader;
    return makeResult([], [], header.affectedRows ?? null);
  }

  async queryRaw(sql: string, params?: unknown[]): Promise<{ columns: string[]; rows: unknown[][] }> {
    const [rows, fields] = await this.connection.query({ sql, values: params, rowsAsArray: true });
    if (!Array.isArray(rows)) return { columns: [], rows: [] };
    return { columns: (fields ?? []).map((f: any) => String(f.name)), rows: rows as unknown[][] };
  }

  async close(): Promise<void> {
    try {
      await this.connection.end();
    } catch {
      this.connection.destroy();
    } finally {
      this.tunnel?.dispose();
    }
  }
}

function buildSsl(config: DataSourceConfig): mysql.ConnectionOptions['ssl'] {
  const mode = config.ssl?.mode ?? 'disable';
  if (mode === 'disable') return undefined;
  const ca = config.ssl?.caFile ? readFileSync(config.ssl.caFile).toString() : undefined;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-ca') {
    // mysql2 forwards ssl options to tls.connect, but its SslOptions type
    // does not declare checkServerIdentity (hostname check suppression).
    return { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined } as unknown as NonNullable<
      mysql.ConnectionOptions['ssl']
    >;
  }
  return { ca, rejectUnauthorized: true };
}

export const mysqlDriver: Driver = {
  id: 'mysql',
  label: 'MySQL / MariaDB',
  defaultPort: 3306,

  async connect(ctx: ConnectContext): Promise<DbSession> {
    const { config, secrets } = ctx;
    const host = config.host ?? 'localhost';
    const port = config.port ?? 3306;

    let tunnel: SshTunnel | undefined;
    if (config.ssh?.enabled) {
      tunnel = await openSshTunnel(config.ssh, secrets, host, port);
    }

    try {
      const connection = await mysql.createConnection({
        host,
        port,
        database: config.database || undefined,
        user: config.user,
        password: config.auth === 'none' ? undefined : secrets.password,
        ssl: buildSsl(config),
        connectTimeout: 15_000,
        dateStrings: true,
        supportBigNumbers: true,
        stream: tunnel ? (tunnel.stream as any) : undefined,
      });
      const [versionRows] = await connection.query({ sql: 'SELECT VERSION()', rowsAsArray: true });
      const version = String((versionRows as unknown[][])[0]?.[0] ?? '');
      if (config.readOnly) {
        await connection.query('SET SESSION TRANSACTION READ ONLY');
      }
      const flavor = /mariadb/i.test(version) ? 'MariaDB' : 'MySQL';
      return new MySqlSession(connection, `${flavor} ${version}`, tunnel);
    } catch (err) {
      tunnel?.dispose();
      throw err;
    }
  },

  async listSchemas(session: DbSession): Promise<string[]> {
    const res = await session.queryRaw('SELECT schema_name FROM information_schema.schemata ORDER BY schema_name');
    return res.rows.map((r) => String(r[0]));
  },

  async introspect(session: DbSession, config: DataSourceConfig, showSystem: boolean): Promise<CatalogModel> {
    const allDatabases = (await this.listSchemas(session)).filter((s) => showSystem || !SYSTEM_DATABASES.has(s));
    let selected: string[];
    if (config.schemas && config.schemas.length > 0) {
      selected = allDatabases.filter((s) => config.schemas!.includes(s));
    } else if (config.database && allDatabases.includes(config.database)) {
      selected = [config.database];
    } else {
      selected = allDatabases;
    }

    const databases: DatabaseModel[] = [];
    const schemaByDb = new Map<string, SchemaModel>();
    const relations = new Map<string, RelationModel>();
    const relKey = (db: string, rel: string) => `${db} ${rel}`;
    for (const name of selected) {
      const schema: SchemaModel = { name, implicit: true, relations: [], routines: [], enums: [], sequences: [] };
      schemaByDb.set(name, schema);
      databases.push({ name, schemas: [schema], allSchemaNames: [name] });
    }
    if (selected.length === 0) {
      return {
        databases: [],
        allDatabaseNames: allDatabases,
        introspectedAt: Date.now(),
        serverVersion: session.serverVersion,
      };
    }
    const placeholders = selected.map(() => '?').join(',');

    const rels = await session.queryRaw(
      `SELECT table_schema, table_name, table_type FROM information_schema.tables
       WHERE table_schema IN (${placeholders}) ORDER BY table_schema, table_name`,
      selected,
    );
    for (const [db, name, type] of rels.rows as [string, string, string][]) {
      const schema = schemaByDb.get(db);
      if (!schema) continue;
      const rel: RelationModel = {
        name,
        kind: /view/i.test(type) ? 'view' : 'table',
        columns: [],
        indexes: [],
      };
      schema.relations.push(rel);
      relations.set(relKey(db, name), rel);
    }

    const cols = await session.queryRaw(
      `SELECT table_schema, table_name, column_name, column_type, is_nullable, column_default, column_key
       FROM information_schema.columns
       WHERE table_schema IN (${placeholders})
       ORDER BY table_schema, table_name, ordinal_position`,
      selected,
    );
    for (const row of cols.rows) {
      const [db, tbl, name, dtype, nullable, def, key] = row as [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string,
      ];
      const rel = relations.get(relKey(db, tbl));
      if (!rel) continue;
      rel.columns.push({
        name,
        dataType: String(dtype),
        nullable: /yes/i.test(nullable),
        primaryKey: key === 'PRI',
        default: def ?? undefined,
      });
    }

    const fks = await session.queryRaw(
      `SELECT table_schema, table_name, column_name, referenced_table_schema, referenced_table_name
       FROM information_schema.key_column_usage
       WHERE table_schema IN (${placeholders}) AND referenced_table_name IS NOT NULL`,
      selected,
    );
    for (const row of fks.rows) {
      const [db, tbl, colName, fdb, ftbl] = row as [string, string, string, string, string];
      const col = relations.get(relKey(db, tbl))?.columns.find((c) => c.name === colName);
      if (!col) continue;
      col.foreignKeyTarget = fdb && fdb !== db ? `${fdb}.${ftbl}` : ftbl;
    }

    const idx = await session.queryRaw(
      `SELECT table_schema, table_name, index_name, non_unique, column_name
       FROM information_schema.statistics
       WHERE table_schema IN (${placeholders}) AND index_name <> 'PRIMARY'
       ORDER BY table_schema, table_name, index_name, seq_in_index`,
      selected,
    );
    const idxMap = new Map<string, IndexModel>();
    for (const row of idx.rows) {
      const [db, tbl, idxName, nonUnique, colName] = row as [string, string, string, number, string | null];
      const rel = relations.get(relKey(db, tbl));
      if (!rel) continue;
      const key = relKey(db, `${tbl} ${idxName}`);
      let model = idxMap.get(key);
      if (!model) {
        model = { name: idxName, columns: [], unique: !nonUnique };
        idxMap.set(key, model);
        rel.indexes.push(model);
      }
      model.columns.push(colName ?? '(expr)');
    }

    const routines = await session.queryRaw(
      `SELECT routine_schema, routine_name, routine_type FROM information_schema.routines
       WHERE routine_schema IN (${placeholders}) ORDER BY routine_schema, routine_name`,
      selected,
    );
    for (const row of routines.rows) {
      const [db, name, type] = row as [string, string, string];
      schemaByDb.get(db)?.routines.push({
        name,
        kind: /procedure/i.test(type) ? 'procedure' : 'function',
      });
    }

    return {
      databases,
      allDatabaseNames: allDatabases,
      introspectedAt: Date.now(),
      serverVersion: session.serverVersion,
    };
  },
};
