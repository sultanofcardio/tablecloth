import type { CellValue, ColumnInfo, ColumnModel, DriverId } from '../core/types';
import { quoteLiteral, sqlName } from '../core/util';

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
 * does and the caller verifies each statement touched exactly one row.
 */
export function makeEditTarget(
  dialect: DriverId,
  qualifiedTable: string,
  tableColumns: ColumnModel[],
  pageColumns: ColumnInfo[],
  sourceReadOnly: boolean,
): EditTarget {
  const byName = new Map(tableColumns.map((c) => [c.name, c]));
  const keyNames = tableColumns.filter((c) => c.primaryKey).map((c) => c.name);
  const pageNames = new Set(pageColumns.map((c) => c.name));
  const keyPresent = keyNames.length > 0 && keyNames.every((k) => pageNames.has(k));

  const columns = pageColumns.map((page): EditColumn => {
    const model = byName.get(page.name);
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
  return { dialect, table: qualifiedTable, columns, readOnlyReason, wholeRowKey: !keyPresent };
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
