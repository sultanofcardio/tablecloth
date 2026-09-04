import type { CellValue, ColumnInfo, ColumnModel, DriverId } from '../core/types';
import { quoteLiteral, sqlName } from '../core/util';
import { SQL_KEYWORDS, significant, tokenize, type Token } from '../sql/tokens';

/** How literals for a column are written into generated DML. */
export type ValueKind = 'numeric' | 'boolean' | 'text';

/** One pending edit of a cell, as the grid records it. */
export type CellEdit = { kind: 'value'; text: string } | { kind: 'null' } | { kind: 'default' };

export interface InsertedRow {
  /** Grid-side identity, echoed back in errors. */
  id: string;
  /** Column index within the page -> edit; untouched columns take the database default. */
  cells: Record<number, CellEdit>;
}

/**
 * The grid's local change set, expressed against the page it was made on:
 * row and column indices refer to that page's rows and columns.
 */
export interface ChangeSet {
  updates: Record<number, Record<number, CellEdit>>;
  deletes: number[];
  inserts: InsertedRow[];
}

export const EMPTY_CHANGES: ChangeSet = { updates: {}, deletes: [], inserts: [] };

export interface EditColumn {
  name: string;
  kind: ValueKind;
  /** Part of the row identity used in WHERE clauses. */
  key: boolean;
  /** Not writable: an expression, an alias, or a generated column. */
  readOnly: boolean;
  /** The database assigns the value; left out of INSERTs unless typed. */
  autoIncrement: boolean;
  hasDefault: boolean;
  nullable: boolean;
  foreignKeyTarget?: string;
  foreignKeyColumn?: string;
}

export interface EditTarget {
  dialect: DriverId;
  /** Quoted, schema-qualified table name ready for SQL. */
  table: string;
  /** Parallel to the page columns. */
  columns: EditColumn[];
  /** Set when the grid must stay read-only, with the reason shown to the user. */
  readOnlyReason?: string;
  /** Rows are identified by every column because the table has no key in the result. */
  wholeRowKey: boolean;
}

/** Best-effort literal kind from a column's declared type and the driver's numeric flag. */
export function valueKind(dataType: string | undefined, numeric?: boolean): ValueKind {
  const type = (dataType ?? '').toLowerCase();
  if (/\bbool/.test(type)) return 'boolean';
  if (numeric) return 'numeric';
  if (/int|serial|numeric|decimal|real|double|float|money|number/.test(type) && !/interval|point/.test(type)) {
    return 'numeric';
  }
  return 'text';
}

/**
 * Describe how a page maps onto one table. Page columns that are not table
 * columns (aliases, expressions) render but cannot be edited; when every key
 * column is present the key identifies rows, otherwise every writable column
 * does and the caller verifies each statement touched exactly one row. Console
 * results (`requireSourceColumns`) do not take that fallback: without the key
 * in the result they stay read-only, as the documented limit says.
 */
export function makeEditTarget(
  dialect: DriverId,
  qualifiedTable: string,
  tableColumns: ColumnModel[],
  pageColumns: ColumnInfo[],
  sourceReadOnly: boolean,
  requireSourceColumns = false,
): EditTarget {
  const byName = new Map(tableColumns.map((c) => [c.name, c]));
  const keyNames = tableColumns.filter((c) => c.primaryKey).map((c) => c.name);
  const pageSources = new Set(pageColumns.map((c) => c.sourceColumn ?? (requireSourceColumns ? undefined : c.name)));
  const keyPresent = keyNames.length > 0 && keyNames.every((k) => pageSources.has(k));

  const columns = pageColumns.map((page): EditColumn => {
    const sourceName = page.sourceColumn ?? (requireSourceColumns ? undefined : page.name);
    const model = sourceName ? byName.get(sourceName) : undefined;
    if (!model) {
      return {
        name: page.name,
        kind: valueKind(page.dataType, page.numeric),
        key: false,
        readOnly: true,
        autoIncrement: false,
        hasDefault: false,
        nullable: true,
      };
    }
    return {
      name: model.name,
      kind: valueKind(model.dataType, page.numeric),
      key: keyPresent ? model.primaryKey : !model.generated,
      readOnly: !!model.generated,
      autoIncrement: !!model.autoIncrement,
      hasDefault: model.default !== undefined || !!model.autoIncrement,
      nullable: model.nullable,
      foreignKeyTarget: model.foreignKeyTarget,
      foreignKeyColumn: model.foreignKeyColumn,
    };
  });

  let readOnlyReason: string | undefined;
  if (sourceReadOnly) readOnlyReason = 'The data source is read-only';
  else if (!columns.some((c) => !c.readOnly)) readOnlyReason = 'No editable columns in this result';
  else if (requireSourceColumns && !keyPresent) {
    readOnlyReason = "This result cannot be edited: the table's key columns are not in it";
  }
  return { dialect, table: qualifiedTable, columns, readOnlyReason, wholeRowKey: !keyPresent };
}

/** The one table a SELECT reads from, as the statement names it. */
export interface SourceRelation {
  schema?: string;
  table: string;
  alias?: string;
}

const FROM_CLAUSE_ENDS = new Set([
  'where', 'group', 'having', 'window', 'order', 'limit', 'offset', 'fetch', 'for', 'returning',
]);
const SET_OPERATIONS = new Set(['union', 'intersect', 'except']);
const JOIN_WORDS = new Set(['join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'outer', 'lateral', 'tablesample']);

function isName(token: Token | undefined): token is Token {
  return !!token && (token.kind === 'word' || token.kind === 'ident');
}

/** A word that opens a clause or a join rather than naming a table or alias. */
function isStructural(token: Token): boolean {
  return token.kind === 'word' && (FROM_CLAUSE_ENDS.has(token.value) || SET_OPERATIONS.has(token.value) || JOIN_WORDS.has(token.value));
}

/** The top-level SELECT ... FROM split of a statement, or undefined when it has none. */
function selectFromSplit(tokens: Token[]): { select: number; from: number } | undefined {
  let depth = 0;
  let select = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === '(') depth++;
    else if (token.text === ')') depth--;
    else if (depth === 0 && token.kind === 'word' && token.value === 'select' && select < 0) select = i;
    else if (select >= 0 && depth === 0 && token.kind === 'word' && token.value === 'from') return { select, from: i };
  }
  return undefined;
}

/**
 * Prove that a statement reads exactly one plain table: `SELECT ... FROM
 * [schema.]table [[AS] alias]` followed by nothing but the tail clauses.
 * Derived tables, comma joins, JOINs, CTEs and set operations all return
 * undefined, because the result columns of those cannot be traced back to one
 * table's rows by name alone.
 */
export function singleSourceRelation(sql: string, dialect: DriverId): SourceRelation | undefined {
  const tokens = significant(tokenize(sql, dialect));
  if (tokens[0]?.kind !== 'word' || tokens[0].value !== 'select') return undefined;
  const split = selectFromSplit(tokens);
  if (!split) return undefined;
  let i = split.from + 1;
  if (dialect === 'postgres' && tokens[i]?.kind === 'word' && tokens[i]!.value === 'only') i++;
  const names: Token[] = [];
  for (;;) {
    const token = tokens[i];
    if (!isName(token) || isStructural(token)) return undefined;
    names.push(token);
    i++;
    if (tokens[i]?.text !== '.') break;
    i++;
  }
  if (names.length > 2) return undefined;
  let alias: string | undefined;
  const next = tokens[i];
  if (next?.kind === 'word' && next.value === 'as') {
    const name = tokens[i + 1];
    if (!isName(name) || isStructural(name)) return undefined;
    alias = name.value;
    i += 2;
  } else if (isName(next) && !isStructural(next) && !(next.kind === 'word' && SQL_KEYWORDS.has(next.value))) {
    alias = next.value;
    i++;
  }
  const tail = tokens[i];
  if (tail && !(tail.text === ';' && i === tokens.length - 1)) {
    if (tail.kind !== 'word' || !FROM_CLAUSE_ENDS.has(tail.value)) return undefined;
  }
  let depth = 0;
  for (; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === '(') depth++;
    else if (token.text === ')') depth--;
    else if (depth === 0 && token.kind === 'word' && SET_OPERATIONS.has(token.value)) return undefined;
  }
  const table = names[names.length - 1]!;
  const schema = names.length === 2 ? names[0]!.value : undefined;
  return { schema, table: table.value, alias };
}

function sameName(token: Token, name: string): boolean {
  return token.value.toLowerCase() === name.toLowerCase();
}

/** Whether `qualifier.column` names the source relation (by alias, table, or schema.table). */
function qualifierMatches(qualifier: Token[], source: SourceRelation): boolean {
  if (qualifier.length === 0) return true;
  if (qualifier.length === 1) {
    const q = qualifier[0]!;
    return source.alias ? sameName(q, source.alias) : sameName(q, source.table);
  }
  if (qualifier.length === 2 && !source.alias) {
    return !!source.schema && sameName(qualifier[0]!, source.schema) && sameName(qualifier[1]!, source.table);
  }
  return false;
}

/** The token naming the projected column, `'*'` for a star, undefined for anything else. */
function directProjection(tokens: Token[], source: SourceRelation): Token | '*' | undefined {
  let body = tokens;
  const as = body.findIndex((token) => token.kind === 'word' && token.value === 'as');
  if (as >= 0) body = body.slice(0, as);
  else if (body.length >= 2 && ['word', 'ident'].includes(body[body.length - 1]!.kind)) {
    const withoutAlias = body.slice(0, -1);
    if (withoutAlias.length % 2 === 1) body = withoutAlias;
  }
  if (body.length % 2 === 0) return undefined;
  for (let i = 0; i < body.length; i++) {
    if (i % 2 === 0) {
      const last = i === body.length - 1;
      if (!isName(body[i]) && !(last && body[i]!.text === '*')) return undefined;
    } else if (body[i]!.text !== '.') return undefined;
  }
  const qualifier = body.filter((_, i) => i % 2 === 0).slice(0, -1);
  if (!qualifierMatches(qualifier, source)) return undefined;
  const last = body[body.length - 1]!;
  return last.text === '*' ? '*' : last;
}

/**
 * Dialects where a column reference finds its column whatever case the name is
 * stored in, quoted or not. PostgreSQL instead folds unquoted words to lower
 * case, so there the tokenizer's lowercased value is already the name the
 * server resolves and a quoted name means exactly what it spells.
 */
const CASE_INSENSITIVE_NAMES: Record<DriverId, boolean> = { postgres: false, mysql: true, sqlite: true };

/** The catalog column a reference names, as the catalog spells it. */
function catalogName(tableColumns: ColumnModel[], name: string, caseInsensitive: boolean): string {
  if (tableColumns.some((column) => column.name === name)) return name;
  if (!caseInsensitive) return name;
  const folded = name.toLowerCase();
  const matches = tableColumns.filter((column) => column.name.toLowerCase() === folded);
  return matches.length === 1 ? matches[0]!.name : name;
}

/**
 * Map result positions to source columns, rejecting expressions even when
 * aliased like a real column, and qualified names that belong to anything
 * other than the statement's one source relation.
 */
export function resultColumnOrigins(
  sql: string,
  dialect: DriverId,
  tableColumns: ColumnModel[],
  resultColumns: ColumnInfo[],
  source?: SourceRelation,
): (string | undefined)[] {
  const relation = source ?? singleSourceRelation(sql, dialect);
  if (!relation) return resultColumns.map(() => undefined);
  const tokens = significant(tokenize(sql, dialect));
  const split = selectFromSplit(tokens);
  if (!split) return resultColumns.map(() => undefined);
  const projection = tokens.slice(split.select + 1, split.from);
  if (projection[0]?.kind === 'word' && projection[0].value === 'distinct') projection.shift();
  const items: Token[][] = [];
  let item: Token[] = [];
  let depth = 0;
  for (const token of projection) {
    if (token.text === '(') depth++;
    else if (token.text === ')') depth--;
    if (token.text === ',' && depth === 0) {
      items.push(item);
      item = [];
    } else item.push(token);
  }
  if (item.length > 0) items.push(item);
  const folds = CASE_INSENSITIVE_NAMES[dialect];
  const projected = items.map((tokens) => directProjection(tokens, relation));
  // a star stands for the columns the driver reported at those positions, which
  // are the live table's; the catalog's order may be stale after DDL
  const stars = projected.filter((origin) => origin === '*').length;
  const starWidth = resultColumns.length - (projected.length - 1);
  if (stars > 1 || (stars === 1 && starWidth < 0)) return resultColumns.map(() => undefined);
  const origins: (string | undefined)[] = [];
  for (const origin of projected) {
    if (origin === '*') {
      for (let i = 0; i < starWidth; i++) {
        const name = resultColumns[origins.length]?.name;
        origins.push(name === undefined ? undefined : catalogName(tableColumns, name, folds));
      }
    } else if (origin) {
      origins.push(catalogName(tableColumns, origin.value, folds));
    } else origins.push(undefined);
  }
  return origins.length === resultColumns.length ? origins : resultColumns.map(() => undefined);
}

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TRUE_TEXT = new Set(['true', 't', 'yes', 'y', '1', 'on']);
const FALSE_TEXT = new Set(['false', 'f', 'no', 'n', '0', 'off']);

function boolLiteral(dialect: DriverId, value: boolean): string {
  if (dialect === 'sqlite') return value ? '1' : '0';
  return value ? 'TRUE' : 'FALSE';
}

/** Literal for a value the database returned (used in WHERE clauses). */
export function originalLiteral(dialect: DriverId, kind: ValueKind, value: CellValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return boolLiteral(dialect, value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : quoteLiteral(dialect, String(value));
  if (kind === 'numeric' && NUMBER_TEXT.test(value.trim())) return value.trim();
  return quoteLiteral(dialect, value);
}

/** Literal for text the user typed into a cell of the given kind. */
export function typedLiteral(dialect: DriverId, kind: ValueKind, text: string): string {
  const trimmed = text.trim();
  if (kind === 'numeric') {
    if (trimmed === '') return 'NULL';
    return NUMBER_TEXT.test(trimmed) ? trimmed : quoteLiteral(dialect, text);
  }
  if (kind === 'boolean') {
    const lower = trimmed.toLowerCase();
    if (lower === '') return 'NULL';
    if (TRUE_TEXT.has(lower)) return boolLiteral(dialect, true);
    if (FALSE_TEXT.has(lower)) return boolLiteral(dialect, false);
    return quoteLiteral(dialect, text);
  }
  return quoteLiteral(dialect, text);
}

function editLiteral(target: EditTarget, column: EditColumn, edit: CellEdit): string {
  if (edit.kind === 'null') return 'NULL';
  if (edit.kind === 'default') {
    if (target.dialect === 'sqlite') {
      throw new Error(`SQLite cannot reset "${column.name}" to its default in an UPDATE; type the value instead.`);
    }
    return 'DEFAULT';
  }
  return typedLiteral(target.dialect, column.kind, edit.text);
}

function whereClause(target: EditTarget, row: CellValue[]): string {
  const parts: string[] = [];
  target.columns.forEach((column, i) => {
    if (!column.key) return;
    const value = row[i] ?? null;
    const name = sqlName(target.dialect, column.name);
    parts.push(value === null ? `${name} IS NULL` : `${name} = ${originalLiteral(target.dialect, column.kind, value)}`);
  });
  if (parts.length === 0) throw new Error('Cannot identify rows: the result has no key columns.');
  return parts.join(' AND ');
}

export interface ChangeStatement {
  sql: string;
  kind: 'update' | 'delete' | 'insert';
  /** Row index within the page for updates and deletes; the insert id for inserts. */
  row: number | string;
}

/** How many statements a change set produces; the badge on the Submit button. */
export function countChanges(changes: ChangeSet): number {
  const deleted = new Set(changes.deletes);
  const updated = Object.keys(changes.updates)
    .map(Number)
    .filter((r) => !deleted.has(r) && Object.keys(changes.updates[r] ?? {}).length > 0).length;
  return updated + deleted.size + changes.inserts.length;
}

/**
 * Turn the grid's change set into reviewable DML: one UPDATE per edited row,
 * one DELETE per deleted row, one INSERT per added row, in that order (the
 * order IntelliJ previews). A row that was edited and then deleted only
 * produces the DELETE.
 */
export function buildChangeStatements(target: EditTarget, rows: CellValue[][], changes: ChangeSet): ChangeStatement[] {
  if (target.readOnlyReason) throw new Error(target.readOnlyReason);
  const { dialect } = target;
  const statements: ChangeStatement[] = [];
  const deleted = new Set(changes.deletes);

  const updatedRows = Object.keys(changes.updates)
    .map(Number)
    .filter((r) => !deleted.has(r))
    .sort((a, b) => a - b);
  for (const r of updatedRows) {
    const row = rows[r];
    const edits = changes.updates[r];
    if (!row || !edits) throw new Error(`Row ${r + 1} is no longer on this page; reload and try again.`);
    const sets: string[] = [];
    for (const key of Object.keys(edits).map(Number).sort((a, b) => a - b)) {
      const column = target.columns[key];
      const edit = edits[key];
      if (!column || !edit) continue;
      if (column.readOnly) throw new Error(`Column "${column.name}" cannot be edited.`);
      sets.push(`${sqlName(dialect, column.name)} = ${editLiteral(target, column, edit)}`);
    }
    if (sets.length === 0) continue;
    statements.push({
      kind: 'update',
      row: r,
      sql: `UPDATE ${target.table} SET ${sets.join(', ')} WHERE ${whereClause(target, row)};`,
    });
  }

  for (const r of [...deleted].sort((a, b) => a - b)) {
    const row = rows[r];
    if (!row) throw new Error(`Row ${r + 1} is no longer on this page; reload and try again.`);
    statements.push({ kind: 'delete', row: r, sql: `DELETE FROM ${target.table} WHERE ${whereClause(target, row)};` });
  }

  for (const insert of changes.inserts) {
    const names: string[] = [];
    const values: string[] = [];
    target.columns.forEach((column, i) => {
      const edit = insert.cells[i];
      if (!edit || edit.kind === 'default') return; // the database default applies
      if (column.readOnly) throw new Error(`Column "${column.name}" cannot be set.`);
      names.push(sqlName(dialect, column.name));
      values.push(edit.kind === 'null' ? 'NULL' : typedLiteral(dialect, column.kind, edit.text));
    });
    const sql =
      names.length === 0
        ? dialect === 'mysql'
          ? `INSERT INTO ${target.table} () VALUES ();`
          : `INSERT INTO ${target.table} DEFAULT VALUES;`
        : `INSERT INTO ${target.table} (${names.join(', ')}) VALUES (${values.join(', ')});`;
    statements.push({ kind: 'insert', row: insert.id, sql });
  }

  return statements;
}
