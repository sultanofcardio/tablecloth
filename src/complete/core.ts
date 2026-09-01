import type { CatalogModel, DriverId, RelationModel, SchemaModel } from '../core/types';
import { splitStatements, statementAt } from '../sql/splitter';
import { parseTableRefs, stripQuotes, type TableRef } from './refs';

export type CompletionKind = 'column' | 'table' | 'view' | 'schema' | 'routine';

export interface CompletionEntry {
  label: string;
  kind: CompletionKind;
  detail?: string;
  sortText: string;
  documentation?: string;
  /** Set when the bare name needs quoting in this dialect (e.g. "Channel"). */
  insertText?: string;
}

/**
 * The identifier as it must be typed in SQL: quoted whenever the bare form
 * would not resolve (Postgres folds unquoted names to lowercase; MySQL needs
 * backticks for specials).
 */
export function identifierInsertText(dialect: DriverId, name: string): string | undefined {
  const plain = dialect === 'mysql' ? /^[A-Za-z_$][A-Za-z0-9_$]*$/ : /^[a-z_][a-z0-9_$]*$/;
  if (plain.test(name)) return undefined;
  if (dialect === 'mysql') return '`' + name.replaceAll('`', '``') + '`';
  return '"' + name.replaceAll('"', '""') + '"';
}

function allSchemas(catalog: CatalogModel): SchemaModel[] {
  return catalog.databases.flatMap((db) => db.schemas);
}

function findRelation(catalog: CatalogModel, schema: string | undefined, table: string): RelationModel | undefined {
  const norm = (s: string) => s.toLowerCase();
  for (const s of allSchemas(catalog)) {
    if (schema && norm(s.name) !== norm(schema)) continue;
    const rel = s.relations.find((r) => norm(r.name) === norm(table));
    if (rel) return rel;
  }
  return undefined;
}

function columnEntries(relations: RelationModel[], sortPrefix = '0'): CompletionEntry[] {
  const entries: CompletionEntry[] = [];
  for (const rel of relations) {
    for (const col of rel.columns) {
      const marks = [col.primaryKey ? 'PK' : '', col.foreignKeyTarget ? `FK → ${col.foreignKeyTarget}` : '']
        .filter(Boolean)
        .join(' · ');
      entries.push({
        label: col.name,
        kind: 'column',
        detail: `${col.dataType}${marks ? ' · ' + marks : ''}`,
        documentation: rel.name,
        sortText: sortPrefix + col.name,
      });
    }
  }
  return entries;
}

function tableEntry(rel: RelationModel, schemaName: string, sortPrefix = '1'): CompletionEntry {
  return {
    label: rel.name,
    kind: rel.kind === 'view' ? 'view' : 'table',
    detail: `${rel.kind} · ${schemaName}`,
    sortText: sortPrefix + rel.name,
  };
}

function tableEntries(catalog: CatalogModel, sortPrefix = '1'): CompletionEntry[] {
  const entries: CompletionEntry[] = [];
  for (const schema of allSchemas(catalog)) {
    for (const rel of schema.relations) {
      entries.push(tableEntry(rel, schema.name, sortPrefix));
    }
  }
  return entries;
}

function schemaEntries(catalog: CatalogModel, sortPrefix = '2'): CompletionEntry[] {
  return allSchemas(catalog)
    .filter((s) => !s.implicit)
    .map((s) => ({ label: s.name, kind: 'schema' as const, detail: 'schema', sortText: sortPrefix + s.name }));
}

function qualifiedEntries(catalog: CatalogModel, refs: TableRef[], qualifier: string): CompletionEntry[] {
  const norm = qualifier.toLowerCase();

  const aliasRef = refs.find((r) => (r.alias ?? r.table).toLowerCase() === norm);
  if (aliasRef) {
    const rel = findRelation(catalog, aliasRef.schema, aliasRef.table);
    if (rel) return columnEntries([rel]);
  }

  const schema = allSchemas(catalog).find((s) => s.name.toLowerCase() === norm);
  if (schema) {
    return schema.relations.map((rel) => tableEntry(rel, schema.name));
  }

  const rel = findRelation(catalog, undefined, qualifier);
  if (rel) return columnEntries([rel]);
  return [];
}

function generalEntries(catalog: CatalogModel, refs: TableRef[]): CompletionEntry[] {
  const entries: CompletionEntry[] = [];
  const inStatement = refs
    .map((r) => findRelation(catalog, r.schema, r.table))
    .filter((r): r is RelationModel => !!r);
  entries.push(...columnEntries(inStatement, '0'));
  entries.push(...tableEntries(catalog, '1'));
  entries.push(...schemaEntries(catalog, '2'));
  for (const schema of allSchemas(catalog)) {
    for (const routine of schema.routines) {
      entries.push({
        label: routine.name,
        kind: 'routine',
        detail: `${routine.kind}${routine.args ?? ''}`,
        sortText: '3' + routine.name,
      });
    }
  }
  return entries;
}

/** Object completion for a position in a SQL script, driven by the schema model. */
export function computeCompletions(
  catalog: CatalogModel,
  dialect: DriverId,
  text: string,
  offset: number,
): CompletionEntry[] {
  const statements = splitStatements(text, dialect);
  const stmt = statementAt(statements, offset, text);
  const stmtText = stmt?.sql ?? '';
  const before = text.slice(stmt?.start ?? Math.max(0, offset - 200), offset);
  const refs = parseTableRefs(stmtText);
  const quoted = (entries: CompletionEntry[]) =>
    entries.map((entry) => ({ ...entry, insertText: identifierInsertText(dialect, entry.label) }));

  // qualified position: "alias." / "schema." / "table."
  const dotMatch = /((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*))\s*\.\s*(?:[A-Za-z_][\w$]*)?$/.exec(before);
  if (dotMatch) {
    return quoted(qualifiedEntries(catalog, refs, stripQuotes(dotMatch[1]!)));
  }

  // right after FROM/JOIN/UPDATE/INTO: tables and schemas
  if (/\b(from|join|update|into|table)\s+(?:"[^"]*|`[^`]*|[A-Za-z_][\w$]*)?$/i.test(before)) {
    return quoted([...tableEntries(catalog), ...schemaEntries(catalog)]);
  }

  return quoted(generalEntries(catalog, refs));
}
