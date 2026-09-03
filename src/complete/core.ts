import type { CatalogModel, ColumnModel, DriverId, RelationModel, SchemaModel } from '../core/types';
import { splitStatements, statementAt } from '../sql/splitter';
import { SQL_RESERVED_WORDS } from '../sql/reserved';
import { SQL_FUNCTIONS, SQL_KEYWORDS, significant, tokenize, type Token } from '../sql/tokens';
import { parseTableRefs, stripQuotes, type TableRef } from './refs';

export type CompletionKind =
  | 'column'
  | 'table'
  | 'view'
  | 'schema'
  | 'routine'
  | 'keyword'
  | 'function'
  | 'template'
  | 'join'
  /** IntelliJ's alias suggestion for a table just named in FROM or JOIN. */
  | 'alias';

export interface CompletionEntry {
  label: string;
  kind: CompletionKind;
  detail?: string;
  sortText: string;
  documentation?: string;
  /** Text to insert when it differs from the label (quoted identifiers, snippets). */
  insertText?: string;
  /** insertText is a snippet with $1-style tab stops. */
  snippet?: boolean;
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

function schemaOf(catalog: CatalogModel, rel: RelationModel): SchemaModel | undefined {
  return allSchemas(catalog).find((s) => s.relations.includes(rel));
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

function routineEntries(catalog: CatalogModel): CompletionEntry[] {
  const entries: CompletionEntry[] = [];
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

// ---------------------------------------------------------------------------
// Keywords, functions, live templates
// ---------------------------------------------------------------------------

const STATEMENT_KEYWORDS = [
  'SELECT',
  'SELECT DISTINCT',
  'INSERT INTO',
  'UPDATE',
  'DELETE FROM',
  'WITH',
  'CREATE TABLE',
  'CREATE INDEX',
  'CREATE VIEW',
  'ALTER TABLE',
  'DROP TABLE',
  'TRUNCATE TABLE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'EXPLAIN',
];

const CLAUSE_KEYWORDS = [
  'FROM',
  'WHERE',
  'JOIN',
  'LEFT JOIN',
  'INNER JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'ON',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'UNION ALL',
  'AND',
  'OR',
  'AS',
  'ASC',
  'DESC',
  'IN',
  'IS NULL',
  'IS NOT NULL',
  'LIKE',
  'BETWEEN',
  'NOT',
  'EXISTS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'NULL',
  'TRUE',
  'FALSE',
  'DISTINCT',
  'VALUES',
  'SET',
  'RETURNING',
  'PRIMARY KEY',
  'REFERENCES',
  'NOT NULL',
  'DEFAULT',
];

interface Template {
  abbreviation: string;
  description: string;
  body: string;
}

/** IntelliJ's SQL live templates, as snippets. */
export const LIVE_TEMPLATES: Template[] = [
  { abbreviation: 'sel', description: 'SELECT * FROM', body: 'SELECT * FROM ${1:table}' },
  { abbreviation: 'selc', description: 'SELECT count(*) FROM', body: 'SELECT count(*) FROM ${1:table}' },
  { abbreviation: 'selw', description: 'SELECT * FROM … WHERE', body: 'SELECT * FROM ${1:table} WHERE ${2:condition}' },
  { abbreviation: 'ins', description: 'INSERT INTO … VALUES', body: 'INSERT INTO ${1:table} (${2:columns}) VALUES (${3:values})' },
  { abbreviation: 'upd', description: 'UPDATE … SET … WHERE', body: 'UPDATE ${1:table} SET ${2:column} = ${3:value} WHERE ${4:condition}' },
  { abbreviation: 'del', description: 'DELETE FROM … WHERE', body: 'DELETE FROM ${1:table} WHERE ${2:condition}' },
  { abbreviation: 'tab', description: 'CREATE TABLE', body: 'CREATE TABLE ${1:name}\n(\n    ${2:id} ${3:integer} PRIMARY KEY\n)' },
  { abbreviation: 'col', description: 'column definition', body: '${1:name} ${2:type}' },
  { abbreviation: 'ind', description: 'CREATE INDEX', body: 'CREATE INDEX ${1:name} ON ${2:table} (${3:columns})' },
  { abbreviation: 'view', description: 'CREATE VIEW', body: 'CREATE VIEW ${1:name} AS\nSELECT ${2:*}\nFROM ${3:table}' },
];

function keywordEntries(words: string[], sortPrefix: string): CompletionEntry[] {
  return words.map((w) => ({ label: w, kind: 'keyword' as const, sortText: sortPrefix + w }));
}

function functionEntries(): CompletionEntry[] {
  return [...SQL_FUNCTIONS]
    .sort()
    .map((name) => ({ label: name, kind: 'function' as const, detail: 'function', sortText: '5' + name, insertText: `${name}($1)`, snippet: true }));
}

function templateEntries(): CompletionEntry[] {
  return LIVE_TEMPLATES.map((t) => ({
    label: t.abbreviation,
    kind: 'template' as const,
    detail: t.description,
    documentation: t.body.replace(/\$\{\d+:([^}]*)\}/g, '$1'),
    sortText: '0t' + t.abbreviation,
    insertText: t.body,
    snippet: true,
  }));
}

// ---------------------------------------------------------------------------
// FK-based JOIN inference
// ---------------------------------------------------------------------------

interface ResolvedRef {
  ref: TableRef;
  rel: RelationModel;
  /** How the table is addressed in the statement: alias or bare name. */
  handle: string;
}

function resolveRefs(catalog: CatalogModel, refs: TableRef[]): ResolvedRef[] {
  const out: ResolvedRef[] = [];
  for (const ref of refs) {
    const rel = findRelation(catalog, ref.schema, ref.table);
    if (rel) out.push({ ref, rel, handle: ref.alias ?? ref.table });
  }
  return out;
}

/** A word that cannot stand bare as an alias in some dialect (invoice_notes -> "in"). */
function isReservedAlias(alias: string): boolean {
  const lower = alias.toLowerCase();
  return SQL_KEYWORDS.has(lower) || SQL_RESERVED_WORDS.has(lower);
}

/**
 * A short alias IntelliJ would pick: initials of the underscore-separated
 * words. Initials that spell a keyword grow by the following letters of the
 * last word (invoice_notes -> ino); an alias another table holds gets a
 * numeric suffix (c2).
 */
export function aliasFor(name: string, taken: Set<string>): string {
  // words split on underscores and camel humps; initials keep their case (Programs -> P, LiveStream -> LS)
  const words = name
    .split(/[_\s]+/)
    .filter(Boolean)
    .flatMap((w) => w.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[A-Z]/g) ?? [w]);
  const initials = (words.length > 1 ? words.map((w) => w[0]!).join('') : name.slice(0, 1)) || 't';
  const lastWord = words[words.length - 1] ?? name;
  let alias = initials;
  for (let k = 2; isReservedAlias(alias) && k <= lastWord.length; k++) alias = initials + lastWord.slice(1, k);
  let candidate = alias;
  for (let n = 2; taken.has(candidate.toLowerCase()) || isReservedAlias(candidate); n++) candidate = `${alias}${n}`;
  return candidate;
}

function targetMatches(column: ColumnModel, rel: RelationModel, relSchema: string | undefined): boolean {
  if (!column.foreignKeyTarget) return false;
  const dot = column.foreignKeyTarget.lastIndexOf('.');
  const table = dot >= 0 ? column.foreignKeyTarget.slice(dot + 1) : column.foreignKeyTarget;
  const schema = dot >= 0 ? column.foreignKeyTarget.slice(0, dot) : undefined;
  if (table.toLowerCase() !== rel.name.toLowerCase()) return false;
  return !schema || !relSchema || schema.toLowerCase() === relSchema.toLowerCase();
}

function referencedColumn(column: ColumnModel, target: RelationModel): string | undefined {
  return column.foreignKeyColumn ?? target.columns.find((c) => c.primaryKey)?.name;
}

/** "customers c ON c.id = o.customer_id" entries for every FK linking the statement's tables to another. */
function joinEntries(catalog: CatalogModel, dialect: DriverId, resolved: ResolvedRef[]): CompletionEntry[] {
  const entries: CompletionEntry[] = [];
  const taken = new Set(resolved.map((r) => r.handle.toLowerCase()));
  const seen = new Set<string>();
  const q = (name: string) => identifierInsertText(dialect, name) ?? name;
  for (const schema of allSchemas(catalog)) {
    for (const other of schema.relations) {
      if (other.kind !== 'table') continue;
      for (const { rel, handle } of resolved) {
        if (other === rel) continue;
        const relSchema = schemaOf(catalog, rel)?.name;
        const conditions: string[] = [];
        // other -> rel
        for (const column of other.columns) {
          if (!targetMatches(column, rel, relSchema)) continue;
          const referenced = referencedColumn(column, rel);
          if (referenced) conditions.push(`ALIAS.${q(column.name)} = ${q(handle)}.${q(referenced)}`);
        }
        // rel -> other
        for (const column of rel.columns) {
          if (!targetMatches(column, other, schema.name)) continue;
          const referenced = referencedColumn(column, other);
          if (referenced) conditions.push(`ALIAS.${q(referenced)} = ${q(handle)}.${q(column.name)}`);
        }
        for (const condition of conditions) {
          const alias = aliasFor(other.name, taken);
          const text = `${q(other.name)} ${alias} ON ${condition.replaceAll('ALIAS', alias)}`;
          if (seen.has(text)) continue;
          seen.add(text);
          entries.push({
            label: text,
            kind: 'join',
            detail: 'FK join',
            sortText: '00' + other.name,
            insertText: text,
          });
        }
      }
    }
  }
  return entries;
}

/** "c.id = o.customer_id" entries for the table just joined against the earlier ones. */
function joinConditionEntries(catalog: CatalogModel, dialect: DriverId, resolved: ResolvedRef[]): CompletionEntry[] {
  if (resolved.length < 2) return [];
  const last = resolved[resolved.length - 1]!;
  const entries: CompletionEntry[] = [];
  const q = (name: string) => identifierInsertText(dialect, name) ?? name;
  for (const earlier of resolved.slice(0, -1)) {
    const lastSchema = schemaOf(catalog, last.rel)?.name;
    const earlierSchema = schemaOf(catalog, earlier.rel)?.name;
    for (const column of last.rel.columns) {
      if (!targetMatches(column, earlier.rel, earlierSchema)) continue;
      const referenced = referencedColumn(column, earlier.rel);
      if (!referenced) continue;
      const text = `${q(last.handle)}.${q(column.name)} = ${q(earlier.handle)}.${q(referenced)}`;
      entries.push({ label: text, kind: 'join', detail: `FK join · ${column.dataType}`, sortText: '00' + text, insertText: text });
    }
    for (const column of earlier.rel.columns) {
      if (!targetMatches(column, last.rel, lastSchema)) continue;
      const referenced = referencedColumn(column, last.rel);
      if (!referenced) continue;
      const text = `${q(last.handle)}.${q(referenced)} = ${q(earlier.handle)}.${q(column.name)}`;
      entries.push({ label: text, kind: 'join', detail: `FK join · ${column.dataType}`, sortText: '00' + text, insertText: text });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

function generalEntries(catalog: CatalogModel, refs: TableRef[]): CompletionEntry[] {
  const entries: CompletionEntry[] = [];
  const inStatement = refs
    .map((r) => findRelation(catalog, r.schema, r.table))
    .filter((r): r is RelationModel => !!r);
  entries.push(...columnEntries(inStatement, '0'));
  entries.push(...tableEntries(catalog, '1'));
  entries.push(...schemaEntries(catalog, '2'));
  entries.push(...routineEntries(catalog));
  return entries;
}

/** Tokens before the caret, with the word being typed removed. */
function contextTokens(before: string, dialect: DriverId): { tokens: Token[]; partial: string } {
  const tokens = significant(tokenize(before, dialect));
  const last = tokens[tokens.length - 1];
  if (last && (last.kind === 'word' || last.kind === 'ident') && last.end === before.length) {
    return { tokens: tokens.slice(0, -1), partial: last.text };
  }
  return { tokens, partial: '' };
}

function inOnClause(tokens: Token[]): boolean {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.kind !== 'word') continue;
    if (t.value === 'on') return true;
    if (['where', 'select', 'from', 'group', 'order', 'having', 'set', 'values', 'join'].includes(t.value)) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The token after a complete term
// ---------------------------------------------------------------------------

type Clause =
  | 'select'
  | 'from'
  | 'join'
  | 'on'
  | 'where'
  | 'group'
  | 'having'
  | 'order'
  | 'limit'
  | 'into'
  | 'update'
  | 'set'
  | 'values'
  | 'returning'
  | 'other';

const JOINS = ['JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN'];
const SET_OPERATIONS = ['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT'];
const TAIL_CLAUSES = ['ORDER BY', 'LIMIT', 'OFFSET', 'FETCH', 'FOR', ...SET_OPERATIONS];
const CONDITION_OPERATORS = ['IS NULL', 'IS NOT NULL', 'IN', 'NOT IN', 'LIKE', 'NOT LIKE', 'BETWEEN', 'NOT'];

/** The clause the caret sits in, found by scanning back at parenthesis depth 0. */
function currentClause(tokens: Token[]): Clause {
  let depth = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.kind === 'punct') {
      if (t.text === ')') depth++;
      else if (t.text === '(') {
        if (depth === 0) return 'other';
        depth--;
      }
      continue;
    }
    if (depth > 0 || t.kind !== 'word') continue;
    switch (t.value) {
      case 'select':
        return 'select';
      case 'from':
        return 'from';
      case 'join':
        return 'join';
      case 'on':
      case 'using':
        return 'on';
      case 'where':
        return 'where';
      case 'having':
        return 'having';
      case 'by': {
        const owner = tokens[i - 1]?.value;
        if (owner === 'order') return 'order';
        if (owner === 'group') return 'group';
        break;
      }
      case 'limit':
      case 'offset':
      case 'fetch':
        return 'limit';
      case 'into':
        return 'into';
      case 'update':
        return 'update';
      case 'set':
        return 'set';
      case 'values':
        return 'values';
      case 'returning':
        return 'returning';
    }
  }
  return 'other';
}

function aliasEntry(table: Token, refs: TableRef[]): CompletionEntry {
  const taken = new Set(refs.filter((r) => r.alias).map((r) => r.alias!.toLowerCase()));
  const alias = aliasFor(table.kind === 'ident' ? table.value : table.text, taken);
  return { label: alias, kind: 'alias', detail: 'alias', sortText: '2' + alias };
}

/**
 * After a complete term (a name, a value, a closing parenthesis) only
 * keywords can follow, and which ones depends on the clause. Likely picks
 * come first, the rest alphabetically, as in IntelliJ's lookup.
 */
function nextTokenEntries(dialect: DriverId, tokens: Token[], refs: TableRef[]): CompletionEntry[] {
  const last = tokens[tokens.length - 1]!;
  const prev = tokens[tokens.length - 2];
  const clause = currentClause(tokens);
  const statement = tokens.find((t) => t.kind === 'word')?.value ?? '';
  const afterName = last.kind === 'word' || last.kind === 'ident';
  const afterStar = last.kind === 'punct' && last.text === '*';
  const returning = dialect !== 'mysql' && ['insert', 'update', 'delete'].includes(statement) ? ['RETURNING'] : [];
  const conditions = afterName ? CONDITION_OPERATORS : [];
  const entries: CompletionEntry[] = [];
  let first: string[] = [];
  let rest: string[] = [];
  switch (clause) {
    case 'select':
      first = afterStar ? ['FROM'] : ['FROM', 'AS'];
      break;
    case 'from':
    case 'join': {
      const justNamed =
        afterName &&
        prev !== undefined &&
        ((prev.kind === 'word' && (prev.value === 'from' || prev.value === 'join')) ||
          (prev.kind === 'punct' && (prev.text === ',' || prev.text === '.')));
      if (justNamed) {
        entries.push(aliasEntry(last, refs));
        first.push('AS');
      }
      if (statement === 'delete') {
        first.push('WHERE');
        rest = [...returning, 'USING'];
      } else {
        if (clause === 'join') first.push('ON', 'USING');
        first.push('WHERE', 'LEFT JOIN', 'JOIN');
        rest = [...JOINS, 'GROUP BY', 'HAVING', 'WINDOW', ...TAIL_CLAUSES];
      }
      break;
    }
    case 'on':
      first = ['AND', 'OR', ...conditions];
      rest = ['WHERE', ...JOINS, 'GROUP BY', 'HAVING', 'WINDOW', ...TAIL_CLAUSES];
      break;
    case 'where':
    case 'having':
      first = ['AND', 'OR', ...conditions];
      rest = [...(clause === 'where' ? ['GROUP BY', 'HAVING', 'WINDOW'] : []), ...TAIL_CLAUSES, ...returning];
      break;
    case 'group':
      first = ['HAVING', 'ORDER BY'];
      rest = ['WINDOW', ...TAIL_CLAUSES];
      break;
    case 'order':
      first = ['ASC', 'DESC', ...(dialect === 'mysql' ? [] : ['NULLS FIRST', 'NULLS LAST'])];
      rest = ['LIMIT', 'OFFSET', 'FETCH', 'FOR', ...SET_OPERATIONS];
      break;
    case 'limit':
      first = ['OFFSET'];
      rest = ['FETCH', 'FOR', ...SET_OPERATIONS];
      break;
    case 'into':
      first = ['VALUES', 'SELECT', 'DEFAULT VALUES'];
      break;
    case 'update':
      if (afterName && prev?.kind === 'word' && prev.value === 'update') {
        entries.push(aliasEntry(last, refs));
        first.push('AS');
      }
      first.push('SET');
      break;
    case 'set':
      first = ['WHERE', ...returning];
      break;
    case 'values':
      first = [...returning, dialect === 'mysql' ? 'ON DUPLICATE KEY UPDATE' : 'ON CONFLICT'];
      break;
    case 'returning':
      first = afterStar ? [] : ['AS'];
      break;
    default:
      first = afterStar ? [] : ['AND', 'OR', ...conditions, 'AS'];
  }
  const seen = new Set(first);
  first.forEach((word, i) => entries.push({ label: word, kind: 'keyword', sortText: '3' + String(i).padStart(2, '0') }));
  entries.push(...keywordEntries(rest.filter((word) => !seen.has(word)).sort(), '4'));
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
    entries.map((entry) =>
      entry.kind === 'column' || entry.kind === 'table' || entry.kind === 'view' || entry.kind === 'schema' || entry.kind === 'routine'
        ? { ...entry, insertText: identifierInsertText(dialect, entry.label) }
        : entry,
    );

  // qualified position: "alias." / "schema." / "table."
  const dotMatch = /((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*))\s*\.\s*(?:[A-Za-z_][\w$]*)?$/.exec(before);
  if (dotMatch) {
    return quoted(qualifiedEntries(catalog, refs, stripQuotes(dotMatch[1]!)));
  }

  const { tokens } = contextTokens(before, dialect);
  const last = tokens[tokens.length - 1];
  const last2 = tokens[tokens.length - 2];

  // statement start: live templates and statement keywords first
  if (!last) {
    return [...templateEntries(), ...keywordEntries(STATEMENT_KEYWORDS, '1k'), ...quoted(tableEntries(catalog, '2'))];
  }

  // right after FROM/JOIN/UPDATE/INTO/TABLE: tables and schemas, plus FK joins after JOIN
  if (last.kind === 'word' && ['from', 'join', 'update', 'into', 'table', 'lateral'].includes(last.value)) {
    const entries = [...tableEntries(catalog), ...schemaEntries(catalog)];
    if (last.value === 'join' || last.value === 'lateral') {
      entries.unshift(...joinEntries(catalog, dialect, resolveRefs(catalog, refs)));
    }
    return quoted(entries);
  }

  // join conditions right after ON (or continuing one with AND/OR)
  if (last.kind === 'word' && (last.value === 'on' || ((last.value === 'and' || last.value === 'or') && inOnClause(tokens)))) {
    const resolved = resolveRefs(catalog, refs);
    return quoted([...joinConditionEntries(catalog, dialect, resolved), ...generalEntries(catalog, refs), ...keywordEntries(['NOT', 'EXISTS'], '4')]);
  }

  // "SELECT *", "t.*", "count(*": a star standing as a whole term
  const starTerm =
    last.kind === 'punct' &&
    last.text === '*' &&
    ((last2?.kind === 'word' && ['select', 'distinct', 'returning'].includes(last2.value)) ||
      (last2?.kind === 'punct' && [',', '.', '('].includes(last2.text)));
  if (starTerm) {
    return nextTokenEntries(dialect, tokens, refs);
  }

  const afterKeyword = last.kind === 'word' && ['select', 'where', 'and', 'or', 'by', 'having', 'set', 'when', 'then', 'else', 'distinct', 'not', 'returning', 'case'].includes(last.value);
  const afterPunct = last.kind === 'punct' && ['(', ',', '=', '<', '>', '<>', '!=', '<=', '>=', '+', '-', '*', '/', '||'].includes(last.text);
  if (afterKeyword || afterPunct) {
    const extras = last.kind === 'word' && last.value === 'select' ? ['*', 'DISTINCT', 'CASE', 'NULL'] : ['NOT', 'NULL', 'CASE', 'EXISTS'];
    return quoted([...generalEntries(catalog, refs), ...keywordEntries(extras, '4'), ...functionEntries()]);
  }

  // after a complete identifier / value: clause keywords
  const midExpression =
    (last.kind === 'word' && !STATEMENT_KEYWORDS.some((k) => k.toLowerCase() === last.value)) ||
    last.kind === 'ident' ||
    last.kind === 'number' ||
    last.kind === 'string' ||
    last.text === ')';
  if (midExpression && !(last2?.kind === 'word' && ['insert', 'delete'].includes(last2.value))) {
    return nextTokenEntries(dialect, tokens, refs);
  }

  return quoted([...generalEntries(catalog, refs), ...keywordEntries(CLAUSE_KEYWORDS, '4'), ...functionEntries()]);
}

// ---------------------------------------------------------------------------
// Grid filter fields
// ---------------------------------------------------------------------------

export type FilterField = 'where' | 'orderBy';

export interface FilterCompletionSource {
  /** The catalog the grid's table lives in; absent for ad-hoc console results. */
  catalog?: CatalogModel;
  /** The table the grid shows, written the way the page query names it (qualified, quoted as needed). */
  table?: string;
  /** Columns of the page on screen, used when no catalog relation describes the result. */
  columns?: { name: string; dataType?: string | null }[];
}

const RESULT_RELATION = 'result';

/** Keywords that can appear inside a WHERE clause; the rest of CLAUSE_KEYWORDS belong to other clauses. */
const WHERE_FIELD_KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'BETWEEN', 'EXISTS',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'TRUE', 'FALSE',
  'SELECT', 'SELECT DISTINCT', 'DISTINCT', 'FROM', 'AS',
]);
const ORDER_FIELD_KEYWORDS = new Set(['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'NOT', 'AND', 'OR']);
/** Sort directions come before every other keyword in the ORDER BY field. */
const ORDER_FIRST = new Set(['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST']);

/** Drop keywords that make no sense in the field and put sort directions first in ORDER BY. */
function trimForField(entries: CompletionEntry[], dialect: DriverId, field: FilterField): CompletionEntry[] {
  const allowed = field === 'where' ? WHERE_FIELD_KEYWORDS : ORDER_FIELD_KEYWORDS;
  const out = entries.filter((entry) => entry.kind !== 'keyword' || allowed.has(entry.label));
  if (field !== 'orderBy') return out;
  // NULLS FIRST / LAST wherever ASC is offered (MySQL has no such clause)
  const has = (label: string) => out.some((entry) => entry.kind === 'keyword' && entry.label === label);
  if (dialect !== 'mysql' && has('ASC') && !has('NULLS FIRST')) {
    out.push(...keywordEntries(['NULLS FIRST', 'NULLS LAST'], '4'));
  }
  return out.map((entry) =>
    entry.kind === 'keyword' && ORDER_FIRST.has(entry.label) ? { ...entry, sortText: '3' + entry.label } : entry,
  );
}

/**
 * Completion for the grid's WHERE / ORDER BY fields, which hold a clause
 * without its keyword: the text is placed after that keyword in a SELECT on
 * the grid's table so the ordinary statement completion applies.
 */
export function computeFilterCompletions(
  source: FilterCompletionSource,
  dialect: DriverId,
  field: FilterField,
  text: string,
  offset: number,
): CompletionEntry[] {
  const keyword = field === 'where' ? 'WHERE' : 'ORDER BY';
  if (source.catalog && source.table) {
    const prefix = `SELECT * FROM ${source.table} ${keyword} `;
    return trimForField(computeCompletions(source.catalog, dialect, prefix + text, prefix.length + offset), dialect, field);
  }
  // an ad-hoc result: its columns as a one-relation catalog, minus the objects that would name it
  const seen = new Set<string>();
  const columns: ColumnModel[] = [];
  for (const column of source.columns ?? []) {
    if (!column.name || seen.has(column.name)) continue;
    seen.add(column.name);
    columns.push({ name: column.name, dataType: column.dataType ?? '', nullable: true, primaryKey: false });
  }
  const catalog: CatalogModel = {
    serverVersion: '',
    introspectedAt: 0,
    databases: [
      {
        name: '',
        allSchemaNames: [],
        schemas: [
          {
            name: '',
            implicit: true,
            sequences: [],
            enums: [],
            routines: [],
            relations: [{ name: RESULT_RELATION, kind: 'view', indexes: [], columns }],
          },
        ],
      },
    ],
  };
  const prefix = `SELECT * FROM ${RESULT_RELATION} ${keyword} `;
  const entries = computeCompletions(catalog, dialect, prefix + text, prefix.length + offset).filter(
    (entry) => entry.kind !== 'table' && entry.kind !== 'view' && entry.kind !== 'schema',
  );
  return trimForField(entries, dialect, field);
}
