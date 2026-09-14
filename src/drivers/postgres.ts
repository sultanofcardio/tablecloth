import { readFileSync } from 'node:fs';
import pg from 'pg';
import { mintRdsAuthToken, rdsTokenRequest } from '../data/awsIam';
import { lookupPgPass } from '../data/pgpass';
import type {
  CatalogModel,
  ColumnModel,
  DataSourceConfig,
  EnumTypeModel,
  IndexModel,
  QueryResult,
  RelationModel,
  RoutineModel,
  SchemaModel,
  SequenceModel,
} from '../core/types';
import type { ConnectContext, DbSession, Driver } from './driver';
import { errorMessage, quoteLiteral } from '../core/util';
import { effectiveSslMode, makeResult, normalizeRows } from './driver';
import { pgCatalogSupport } from './pgVersion';
import { sessionTimeZone } from './timeZone';
import { openSshTunnel, type SshTunnel } from './ssh';

/** OIDs whose default pg parsers mangle display (dates/times shift time zones); keep the wire text. */
const RAW_TEXT_OIDS = new Set([1082, 1083, 1114, 1184, 1186, 1266]);

const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 790, 1700]);

const OID_NAMES: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  26: 'oid',
  114: 'json',
  700: 'real',
  701: 'double precision',
  790: 'money',
  1042: 'char',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
};

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);

/**
 * pg resolves multi-statement text to an ARRAY of results. Statements are
 * split upstream, but when several still arrive as one string, present the
 * last row-bearing result rather than reading fields off the array.
 */
function lastResult(result: pg.QueryArrayResult): pg.QueryArrayResult {
  if (!Array.isArray(result)) return result;
  const list = result as pg.QueryArrayResult[];
  for (let i = list.length - 1; i >= 0; i--) {
    if ((list[i]!.fields?.length ?? 0) > 0) return list[i]!;
  }
  return list[list.length - 1]!;
}

class PostgresSession implements DbSession {
  readonly dialect = 'postgres' as const;

  constructor(
    private readonly client: pg.Client,
    readonly serverVersion: string,
    readonly backendId: number | undefined,
    private readonly tunnel?: SshTunnel,
    readonly timeZone?: string,
  ) {}

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const result = lastResult(await this.client.query({ text: sql, values: params as any[], rowMode: 'array' }));
    const fields = result.fields ?? [];
    const columns = fields.map((f) => ({
      name: f.name,
      dataType: OID_NAMES[f.dataTypeID],
      numeric: NUMERIC_OIDS.has(f.dataTypeID),
    }));
    const rows = normalizeRows((result.rows ?? []) as unknown[][]);
    const affected = columns.length > 0 ? null : (result.rowCount ?? null);
    return makeResult(columns, rows, affected, this.timeZone);
  }

  async queryRaw(sql: string, params?: unknown[]): Promise<{ columns: string[]; rows: unknown[][] }> {
    const result = lastResult(await this.client.query({ text: sql, values: params as any[], rowMode: 'array' }));
    return { columns: (result.fields ?? []).map((f) => f.name), rows: (result.rows ?? []) as unknown[][] };
  }

  async close(): Promise<void> {
    try {
      await this.client.end();
    } finally {
      this.tunnel?.dispose();
    }
  }
}

/**
 * pg surfaces "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a
 * string" when the server demands a password and none is configured; say what
 * that actually means. An IAM refusal names the two grants that are usually
 * missing, with the server's own text kept first so it stays searchable.
 * Everything else passes through untouched.
 */
function friendlyConnectError(err: unknown, config: DataSourceConfig): unknown {
  const message = err instanceof Error ? err.message : '';
  // SCRAM servers fail on the client before anything is sent; md5 and password
  // auth send an empty password and the server is the one that refuses it
  if (/client password must be a string|empty password returned by client/i.test(message)) {
    return new Error(
      'The server asked for a password, but none is saved for this data source. ' +
        'Set a password, or pick a different authentication mode if the server does not need one.',
    );
  }
  // RDS instances answer "PAM authentication failed", RDS Proxy "IAM authentication failed"
  if (config.auth === 'awsIam' && /IAM authentication failed|PAM authentication failed/i.test(message)) {
    return new Error(
      `${message}. The AWS principal needs rds-db:connect on this instance or proxy, ` +
        'and the database role needs rds_iam.',
    );
  }
  return err;
}

function buildSsl(config: DataSourceConfig): pg.ClientConfig['ssl'] {
  const mode = effectiveSslMode(config);
  if (mode === 'disable') return undefined;
  const ca = config.ssl?.caFile ? readFileSync(config.ssl.caFile).toString() : undefined;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-ca') return { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };
  return { ca, rejectUnauthorized: true };
}

async function resolvePassword(ctx: ConnectContext): Promise<string | undefined> {
  const { config, secrets } = ctx;
  if (config.auth === 'none') return undefined;
  if (config.auth === 'pgpass') {
    return lookupPgPass({
      host: config.host ?? 'localhost',
      port: config.port ?? 5432,
      database: config.database ?? '',
      user: config.user ?? '',
    });
  }
  if (config.auth === 'awsIam') {
    // signed for the RDS endpoint in config.host, even when the socket goes through an SSH tunnel
    return mintRdsAuthToken(rdsTokenRequest(config, 5432));
  }
  return secrets.password;
}

/**
 * The session zone, set right after the handshake like read-only: from here on
 * the server renders timestamptz text in it and reads zone-less literals in it,
 * so grids, consoles, exports and typed edits all agree.
 */
export async function applyTimeZone(client: Pick<pg.Client, 'query'>, zone: string): Promise<void> {
  try {
    await client.query(`SET TIME ZONE ${quoteLiteral('postgres', zone)}`);
  } catch (err) {
    throw new Error(
      `The server does not know the time zone "${zone}" (${errorMessage(err)}). ` +
        "Pick another zone, or Server, on the data source's Options tab.",
    );
  }
}

export const postgresDriver: Driver = {
  id: 'postgres',
  label: 'PostgreSQL',
  defaultPort: 5432,

  async connect(ctx: ConnectContext): Promise<DbSession> {
    const { config } = ctx;
    const host = config.host ?? 'localhost';
    const port = config.port ?? 5432;
    // before the tunnel: a mode that cannot produce a password fails without opening one
    const password = await resolvePassword(ctx);

    let tunnel: SshTunnel | undefined;
    if (config.ssh?.enabled) {
      tunnel = await openSshTunnel(config.ssh, ctx.secrets, host, port);
    }

    const client = new pg.Client({
      host,
      port,
      database: config.database,
      user: config.user,
      password,
      ssl: buildSsl(config),
      connectionTimeoutMillis: 15_000,
      stream: tunnel ? () => tunnel!.stream as any : undefined,
      types: {
        getTypeParser: ((oid: number, format?: any) =>
          RAW_TEXT_OIDS.has(oid) ? (v: string) => v : (pg.types.getTypeParser as any)(oid, format)) as any,
      },
    });

    try {
      await client.connect();
      const versionRes = await client.query('SHOW server_version');
      const version = String(versionRes.rows[0]?.server_version ?? '').split(' ')[0] ?? '';
      if (config.readOnly) {
        await client.query('SET default_transaction_read_only = on');
      }
      const zone = sessionTimeZone(config);
      if (zone) await applyTimeZone(client, zone);
      const pidRes = await client.query('SELECT pg_backend_pid() AS pid');
      const pid = Number(pidRes.rows[0]?.pid);
      return new PostgresSession(client, `PostgreSQL ${version}`, Number.isFinite(pid) ? pid : undefined, tunnel, zone);
    } catch (err) {
      tunnel?.dispose();
      void client.end().catch(() => undefined);
      throw friendlyConnectError(err, config);
    }
  },

  async listSchemas(session: DbSession): Promise<string[]> {
    const res = await session.queryRaw(
      `SELECT nspname FROM pg_namespace
       WHERE nspname NOT LIKE 'pg\\_temp%' AND nspname NOT LIKE 'pg\\_toast%'
       ORDER BY nspname`,
    );
    return res.rows.map((r) => String(r[0]));
  },

  async introspect(session: DbSession, config: DataSourceConfig, showSystem: boolean): Promise<CatalogModel> {
    const allSchemas = (await this.listSchemas(session)).filter((s) => showSystem || !SYSTEM_SCHEMAS.has(s));
    const selected =
      config.schemas && config.schemas.length > 0
        ? allSchemas.filter((s) => config.schemas!.includes(s))
        : allSchemas.includes('public')
          ? ['public']
          : allSchemas;

    const schemas = new Map<string, SchemaModel>();
    const relations = new Map<string, RelationModel>();
    for (const name of selected) {
      schemas.set(name, { name, implicit: false, relations: [], routines: [], enums: [], sequences: [] });
    }
    const relKey = (schema: string, rel: string) => `${schema}\x00${rel}`;

    const rels = await session.queryRaw(
      `SELECT n.nspname, c.relname, c.relkind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p','v','m','f','S')
       ORDER BY n.nspname, c.relname`,
      [selected],
    );
    for (const [schemaName, relName, kind] of rels.rows as [string, string, string][]) {
      const schema = schemas.get(schemaName);
      if (!schema) continue;
      if (kind === 'S') {
        schema.sequences.push({ name: relName } satisfies SequenceModel);
        continue;
      }
      const rel: RelationModel = {
        name: relName,
        kind: kind === 'v' || kind === 'm' ? 'view' : 'table',
        columns: [],
        indexes: [],
      };
      schema.relations.push(rel);
      relations.set(relKey(schemaName, relName), rel);
    }

    // older servers introspect without the columns they lack rather than
    // failing the whole catalog
    const support = pgCatalogSupport(session.serverVersion);
    const identityExpr = support.identity ? `a.attidentity <> ''` : 'false';
    const generatedExpr = support.generated ? `a.attgenerated <> ''` : 'false';
    const cols = await session.queryRaw(
      `SELECT n.nspname, c.relname, a.attname,
              format_type(a.atttypid, a.atttypmod) AS dtype,
              a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS default,
              ${identityExpr} AS identity, ${generatedExpr} AS generated
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p','v','m','f')
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY n.nspname, c.relname, a.attnum`,
      [selected],
    );
    for (const row of cols.rows) {
      const [schemaName, relName, colName, dtype, notNull, def, identity, generated] = row as [
        string,
        string,
        string,
        string,
        boolean,
        string | null,
        boolean,
        boolean,
      ];
      const rel = relations.get(relKey(schemaName, relName));
      if (!rel) continue;
      const column: ColumnModel = {
        name: colName,
        dataType: dtype,
        nullable: !notNull,
        primaryKey: false,
        default: def ?? undefined,
      };
      // serial columns are plain columns whose default pulls from a sequence
      if (identity || (def && /^nextval\(/i.test(def))) column.autoIncrement = true;
      if (generated) column.generated = true;
      rel.columns.push(column);
    }

    const cons = await session.queryRaw(
      `SELECT n.nspname, c.relname, con.contype, a.attname, fn.nspname AS fschema, fc.relname AS ftable,
              fa.attname AS fcolumn
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
       LEFT JOIN pg_class fc ON fc.oid = con.confrelid
       LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       LEFT JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[k.ord::int]
       WHERE n.nspname = ANY($1) AND con.contype IN ('p','f')
       ORDER BY con.oid, k.ord`,
      [selected],
    );
    for (const row of cons.rows) {
      const [schemaName, relName, contype, colName, fSchema, fTable, fColumn] = row as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
      ];
      const rel = relations.get(relKey(schemaName, relName));
      const col = rel?.columns.find((c) => c.name === colName);
      if (!col) continue;
      if (contype === 'p') {
        col.primaryKey = true;
      } else if (contype === 'f' && fTable) {
        col.foreignKeyTarget = fSchema && fSchema !== schemaName ? `${fSchema}.${fTable}` : fTable;
        if (fColumn) col.foreignKeyColumn = fColumn;
      }
    }

    const idx = await session.queryRaw(
      `SELECT n.nspname, t.relname AS tbl, ic.relname AS idx, i.indisunique, a.attname
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class ic ON ic.oid = i.indexrelid
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
       LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE n.nspname = ANY($1) AND NOT i.indisprimary
       ORDER BY n.nspname, t.relname, ic.relname, k.ord`,
      [selected],
    );
    const idxMap = new Map<string, IndexModel>();
    for (const row of idx.rows) {
      const [schemaName, tblName, idxName, unique, colName] = row as [string, string, string, boolean, string | null];
      const rel = relations.get(relKey(schemaName, tblName));
      if (!rel) continue;
      const key = relKey(schemaName, `${tblName}\x00${idxName}`);
      let model = idxMap.get(key);
      if (!model) {
        model = { name: idxName, columns: [], unique };
        idxMap.set(key, model);
        rel.indexes.push(model);
      }
      model.columns.push(colName ?? '(expr)');
    }

    const routines = await session.queryRaw(
      `SELECT n.nspname, p.proname, ${support.prokind ? 'p.prokind' : `'f'`} AS prokind,
              pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = ANY($1) AND ${support.prokind ? `p.prokind IN ('f','p')` : 'NOT p.proisagg AND NOT p.proiswindow'}
       ORDER BY n.nspname, p.proname`,
      [selected],
    );
    for (const row of routines.rows) {
      const [schemaName, name, kind, args] = row as [string, string, string, string];
      schemas.get(schemaName)?.routines.push({
        name,
        kind: kind === 'p' ? 'procedure' : 'function',
        args: args ? `(${args})` : '()',
      } satisfies RoutineModel);
    }

    const enums = await session.queryRaw(
      `SELECT n.nspname, t.typname, e.enumlabel
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE n.nspname = ANY($1)
       ORDER BY n.nspname, t.typname, e.enumsortorder`,
      [selected],
    );
    const enumMap = new Map<string, EnumTypeModel>();
    for (const row of enums.rows) {
      const [schemaName, typeName, label] = row as [string, string, string];
      const schema = schemas.get(schemaName);
      if (!schema) continue;
      const key = relKey(schemaName, typeName);
      let model = enumMap.get(key);
      if (!model) {
        model = { name: typeName, values: [] };
        enumMap.set(key, model);
        schema.enums.push(model);
      }
      model.values.push(label);
    }

    const dbRes = await session.queryRaw('SELECT current_database()');
    const dbName = String(dbRes.rows[0]?.[0] ?? config.database ?? 'postgres');

    return {
      databases: [
        {
          name: dbName,
          schemas: selected.map((s) => schemas.get(s)!),
          allSchemaNames: allSchemas,
        },
      ],
      introspectedAt: Date.now(),
      serverVersion: session.serverVersion,
    };
  },
};
