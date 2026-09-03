// "Go to DDL": reconstruct the CREATE statement of a database object from the
// server's own metadata, in the style IntelliJ shows for each dialect.
import type { DriverId } from '../core/types';
import { quoteIdent } from '../core/util';
import type { DbSession } from '../drivers/driver';

export type DdlKind = 'table' | 'view' | 'routine' | 'sequence' | 'enum';

export interface DdlRef {
  kind: DdlKind;
  /** Schema (PostgreSQL) or database (MySQL); absent for SQLite. */
  schema?: string;
  name: string;
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export async function generateDdl(session: DbSession, ref: DdlRef): Promise<string> {
  switch (session.dialect) {
    case 'postgres':
      return postgresDdl(session, ref);
    case 'mysql':
      return mysqlDdl(session, ref);
    case 'sqlite':
      return sqliteDdl(session, ref);
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL: rebuilt from pg_catalog with the server's own deparsers
// ---------------------------------------------------------------------------

function pgName(schema: string | undefined, name: string): string {
  return schema ? `${quoteIdent('postgres', schema)}.${quoteIdent('postgres', name)}` : quoteIdent('postgres', name);
}

async function postgresDdl(session: DbSession, ref: DdlRef): Promise<string> {
  const schema = ref.schema ?? 'public';
  switch (ref.kind) {
    case 'table':
      return postgresTableDdl(session, schema, ref.name);
    case 'view': {
      const res = await session.queryRaw(
        `SELECT c.relkind, pg_get_viewdef(c.oid, true)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, ref.name],
      );
      const row = res.rows[0];
      if (!row) throw new Error(`View ${schema}.${ref.name} was not found.`);
      const kind = row[0] === 'm' ? 'materialized view' : 'view';
      return `create ${kind} ${pgName(schema, ref.name)} as\n${str(row[1]).trim()}\n`;
    }
    case 'routine': {
      const res = await session.queryRaw(
        `SELECT pg_get_functiondef(p.oid)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind IN ('f','p')
         ORDER BY p.oid`,
        [schema, ref.name],
      );
      if (res.rows.length === 0) throw new Error(`Routine ${schema}.${ref.name} was not found.`);
      return res.rows.map((r) => str(r[0]).trim() + ';').join('\n\n') + '\n';
    }
    case 'sequence': {
      const res = await session.queryRaw(
        `SELECT start_value, increment_by, min_value, max_value, cache_size, cycle, data_type::text
         FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`,
        [schema, ref.name],
      );
      const row = res.rows[0];
      if (!row) throw new Error(`Sequence ${schema}.${ref.name} was not found.`);
      const [start, increment, min, max, cache, cycle, dataType] = row;
      const lines = [`create sequence ${pgName(schema, ref.name)}`];
      if (dataType && dataType !== 'bigint') lines.push(`    as ${str(dataType)}`);
      lines.push(`    start with ${str(start)}`, `    increment by ${str(increment)}`);
      lines.push(`    minvalue ${str(min)}`, `    maxvalue ${str(max)}`, `    cache ${str(cache)}`);
      if (cycle) lines.push('    cycle');
      return lines.join('\n') + ';\n';
    }
    case 'enum': {
      const res = await session.queryRaw(
        `SELECT e.enumlabel FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE n.nspname = $1 AND t.typname = $2 ORDER BY e.enumsortorder`,
        [schema, ref.name],
      );
      if (res.rows.length === 0) throw new Error(`Type ${schema}.${ref.name} was not found.`);
      const labels = res.rows.map((r) => `'${str(r[0]).replaceAll("'", "''")}'`);
      return `create type ${pgName(schema, ref.name)} as enum (${labels.join(', ')});\n`;
    }
  }
}

async function postgresTableDdl(session: DbSession, schema: string, table: string): Promise<string> {
  const target = pgName(schema, table);
  const cols = await session.queryRaw(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
            pg_get_expr(d.adbin, d.adrelid), a.attidentity, a.attgenerated,
            col_description(c.oid, a.attnum)
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [schema, table],
  );
  if (cols.rows.length === 0) throw new Error(`Table ${schema}.${table} was not found.`);

  const cons = await session.queryRaw(
    `SELECT con.conname, con.contype, pg_get_constraintdef(con.oid, true)
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2
     ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, con.conname`,
    [schema, table],
  );
  const constraintNames = new Set(cons.rows.map((r) => str(r[0])));

  const idx = await session.queryRaw(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
    [schema, table],
  );
  const comment = await session.queryRaw(
    `SELECT obj_description(c.oid, 'pg_class')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  );

  const columnLines: { name: string; rest: string }[] = [];
  const columnComments: string[] = [];
  for (const row of cols.rows) {
    const [name, type, notNull, def, identity, generated, description] = row;
    const parts = [str(type)];
    if (str(generated) === 's' && def) parts.push(`generated always as (${str(def)}) stored`);
    else if (str(identity) === 'a') parts.push('generated always as identity');
    else if (str(identity) === 'd') parts.push('generated by default as identity');
    else if (def) parts.push(`default ${str(def)}`);
    if (notNull) parts.push('not null');
    columnLines.push({ name: quoteIdent('postgres', str(name)), rest: parts.join(' ') });
    if (description) {
      columnComments.push(
        `comment on column ${target}.${quoteIdent('postgres', str(name))} is '${str(description).replaceAll("'", "''")}';`,
      );
    }
  }
  const width = Math.max(...columnLines.map((c) => c.name.length));
  const body = columnLines.map((c) => `    ${c.name.padEnd(width)} ${c.rest}`);
  for (const row of cons.rows) {
    body.push(`    constraint ${quoteIdent('postgres', str(row[0]))}\n        ${str(row[2])}`);
  }
  const out = [`create table ${target}\n(\n${body.join(',\n')}\n);`];
  if (comment.rows[0]?.[0]) out.push(`\ncomment on table ${target} is '${str(comment.rows[0][0]).replaceAll("'", "''")}';`);
  if (columnComments.length > 0) out.push('\n' + columnComments.join('\n'));
  const extraIndexes = idx.rows.filter((r) => !constraintNames.has(str(r[0])));
  for (const row of extraIndexes) {
    // pg_indexes gives "CREATE INDEX name ON schema.table USING btree (col)"; lay it out on two lines
    const def = str(row[1]).replace(/^CREATE (UNIQUE )?INDEX /i, (m) => m.toLowerCase());
    const onIndex = def.indexOf(' ON ');
    out.push(onIndex > 0 ? `\n${def.slice(0, onIndex)}\n    on${def.slice(onIndex + 3)};` : `\n${def};`);
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB: SHOW CREATE
// ---------------------------------------------------------------------------

async function mysqlDdl(session: DbSession, ref: DdlRef): Promise<string> {
  const target = ref.schema ? `${quoteIdent('mysql', ref.schema)}.${quoteIdent('mysql', ref.name)}` : quoteIdent('mysql', ref.name);
  const pick = (columns: string[], rows: unknown[][], label: string): string => {
    const row = rows[0];
    if (!row) throw new Error(`${label} ${ref.name} was not found.`);
    const index = columns.findIndex((c) => /^create/i.test(c));
    return str(row[index >= 0 ? index : 1]).trim() + ';\n';
  };
  switch (ref.kind) {
    case 'table': {
      const res = await session.queryRaw(`SHOW CREATE TABLE ${target}`);
      return pick(res.columns, res.rows, 'Table');
    }
    case 'view': {
      const res = await session.queryRaw(`SHOW CREATE VIEW ${target}`);
      return pick(res.columns, res.rows, 'View');
    }
    case 'routine': {
      for (const kind of ['FUNCTION', 'PROCEDURE']) {
        try {
          const res = await session.queryRaw(`SHOW CREATE ${kind} ${target}`);
          if (res.rows.length > 0) return pick(res.columns, res.rows, 'Routine');
        } catch {
          // try the other routine kind
        }
      }
      throw new Error(`Routine ${ref.name} was not found.`);
    }
    default:
      throw new Error(`MySQL has no DDL for ${ref.kind} objects.`);
  }
}

// ---------------------------------------------------------------------------
// SQLite: the stored CREATE text
// ---------------------------------------------------------------------------

async function sqliteDdl(session: DbSession, ref: DdlRef): Promise<string> {
  if (ref.kind === 'table' || ref.kind === 'view') {
    const res = await session.queryRaw(`SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')`, [ref.name]);
    const sql = res.rows[0]?.[0];
    if (!sql) throw new Error(`${ref.kind === 'view' ? 'View' : 'Table'} ${ref.name} was not found.`);
    const out = [str(sql).trim() + ';'];
    if (ref.kind === 'table') {
      const idx = await session.queryRaw(
        `SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type = 'index' AND sql IS NOT NULL ORDER BY name`,
        [ref.name],
      );
      for (const row of idx.rows) out.push('\n' + str(row[0]).trim() + ';');
    }
    return out.join('\n') + '\n';
  }
  throw new Error(`SQLite has no DDL for ${ref.kind} objects.`);
}

/** File name for the DDL document tab, e.g. "orders.sql". */
export function ddlDocumentName(ref: DdlRef, dialect: DriverId): string {
  const base = ref.schema && dialect !== 'sqlite' ? `${ref.schema}.${ref.name}` : ref.name;
  return `${base}.sql`;
}
