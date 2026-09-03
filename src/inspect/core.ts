// Inspections over a SQL script against the introspected catalog: unresolved
// tables and columns, each with a "Change to …" quick fix when a close match
// exists. Pure and vscode-free, shared by the console webview (Monaco markers)
// and the extension host (diagnostics for attached .sql files).
import { parseTableRefs, type TableRef } from '../complete/refs';
import type { CatalogModel, DriverId, RelationModel } from '../core/types';
import { findRelation } from '../edit/relations';
import { splitStatements } from '../sql/splitter';
import { SQL_FUNCTIONS, SQL_KEYWORDS, significant, tokenize, type Token } from '../sql/tokens';

export interface Inspection {
  start: number;
  end: number;
  message: string;
  severity: 'warning' | 'error';
  fix?: { title: string; replacement: string };
}

/** Words that read like columns in tokenized SQL but never are. */
const NOT_A_COLUMN = new Set([
  ...SQL_KEYWORDS,
  ...SQL_FUNCTIONS,
  'year', 'month', 'day', 'hour', 'minute', 'second', 'epoch', 'dow', 'doy', 'week', 'quarter', 'millisecond',
  'microsecond', 'century', 'decade', 'timezone', 'isodow', 'isoyear', 'julian',
  'asc', 'desc', 'nulls', 'first', 'last', 'lateral', 'only', 'excluded', 'new', 'old',
]);

const OBJECT_INTRODUCERS = new Set(['from', 'join', 'update', 'into', 'table', 'index', 'view', 'sequence', 'type', 'schema']);

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

/** The candidate a typo most plausibly meant, or undefined when nothing is close. */
export function closestName(name: string, candidates: Iterable<string>): string | undefined {
  const lower = name.toLowerCase();
  let best: { name: string; score: number } | undefined;
  for (const candidate of candidates) {
    const c = candidate.toLowerCase();
    if (c === lower) return candidate;
    let score = levenshtein(lower, c);
    if (c.startsWith(lower) || lower.startsWith(c)) score = Math.min(score, 1.5);
    const limit = Math.max(2, Math.floor(Math.max(lower.length, c.length) / 3));
    if (score <= limit && (!best || score < best.score)) best = { name: candidate, score };
  }
  return best?.name;
}

interface StatementScope {
  refs: TableRef[];
  /** alias or table name (lowercased) -> resolved relation */
  relations: Map<string, RelationModel>;
  /** Names introduced by WITH ... AS ( and by SELECT ... AS alias: lowercased -> as written. */
  localNames: Map<string, string>;
}

function nameToken(token: Token | undefined): string | undefined {
  if (!token) return undefined;
  if (token.kind === 'ident') return token.value;
  if (token.kind === 'word') return token.text;
  return undefined;
}

function collectLocalNames(tokens: Token[]): Map<string, string> {
  const names = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // WITH name AS (   ,  name AS (
    if (t.kind === 'word' && t.value === 'as') {
      const next = tokens[i + 1];
      const prev = nameToken(tokens[i - 1]);
      if (next?.text === '(' && prev) names.set(prev.toLowerCase(), prev);
      const alias = nameToken(next);
      if (alias && next?.text !== '(') names.set(alias.toLowerCase(), alias);
    }
  }
  return names;
}

/**
 * For each token, whether it sits inside the argument list of a function call
 * (`extract(year FROM x)`, `substring(a FROM 1)`), where FROM is syntax, not a
 * table introducer.
 */
function functionArgDepths(tokens: Token[]): boolean[] {
  const inside: boolean[] = new Array(tokens.length).fill(false);
  const stack: boolean[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.text === '(') {
      const prev = tokens[i - 1];
      const isCall = !!prev && (prev.kind === 'word' || prev.kind === 'ident') && !(prev.kind === 'word' && SQL_KEYWORDS.has(prev.value) && !SQL_FUNCTIONS.has(prev.value));
      stack.push(isCall);
    } else if (t.text === ')') {
      stack.pop();
    }
    inside[i] = stack.some(Boolean);
  }
  return inside;
}

/**
 * Run the inspections. `defaultSchema` is the console's bound schema (or
 * MySQL database); unqualified tables resolve there first, then anywhere in
 * the catalog.
 */
export function inspectSql(catalog: CatalogModel, dialect: DriverId, text: string, defaultSchema?: string): Inspection[] {
  const out: Inspection[] = [];
  const allRelationNames = catalog.databases.flatMap((db) => db.schemas.flatMap((s) => s.relations.map((r) => r.name)));
  const schemaNames = new Set(catalog.databases.flatMap((db) => db.schemas.map((s) => s.name.toLowerCase())));
  const knownSchemaNames = new Set(catalog.databases.flatMap((db) => db.allSchemaNames.map((s) => s.toLowerCase())));

  for (const stmt of splitStatements(text, dialect)) {
    const tokens = significant(tokenize(stmt.sql, dialect));
    if (tokens.length === 0) continue;
    const scope: StatementScope = {
      refs: parseTableRefs(stmt.sql),
      relations: new Map(),
      localNames: collectLocalNames(tokens),
    };
    for (const ref of scope.refs) {
      const found = findRelation(catalog, ref.schema ?? defaultSchema, ref.table);
      if (!found) continue;
      scope.relations.set((ref.alias ?? ref.table).toLowerCase(), found.relation);
      scope.relations.set(ref.table.toLowerCase(), found.relation);
    }
    const abs = (offset: number) => stmt.start + offset;
    const inCall = functionArgDepths(tokens);

    // --- object references after FROM / JOIN / UPDATE / INTO / TABLE ...
    for (let i = 0; i < tokens.length - 1; i++) {
      const t = tokens[i]!;
      if (t.kind !== 'word' || !OBJECT_INTRODUCERS.has(t.value)) continue;
      if (inCall[i]) continue;
      if (t.value === 'table' || t.value === 'index' || t.value === 'view' || t.value === 'sequence' || t.value === 'type' || t.value === 'schema') {
        // CREATE/DROP/ALTER targets may legitimately not exist yet; only DROP/ALTER TABLE x are worth checking
        const verb = tokens[i - 1]?.value;
        if (verb !== 'alter' && verb !== 'drop' && verb !== 'truncate') continue;
        if (t.value !== 'table') continue;
      }
      let j = i + 1;
      if (tokens[j]?.kind === 'word' && (tokens[j]!.value === 'if' || tokens[j]!.value === 'only' || tokens[j]!.value === 'lateral')) {
        // IF EXISTS / ONLY
        while (j < tokens.length && tokens[j]!.kind === 'word' && ['if', 'exists', 'not', 'only', 'lateral'].includes(tokens[j]!.value)) j++;
      }
      const first = tokens[j];
      if (!first || (first.kind !== 'word' && first.kind !== 'ident')) continue;
      if (first.kind === 'word' && (SQL_KEYWORDS.has(first.value) && first.value !== 'user')) continue;
      let schema: Token | undefined;
      let table: Token = first;
      if (tokens[j + 1]?.text === '.' && tokens[j + 2] && (tokens[j + 2]!.kind === 'word' || tokens[j + 2]!.kind === 'ident')) {
        schema = first;
        table = tokens[j + 2]!;
      }
      if (tokens[tokens.indexOf(table) + 1]?.text === '(') continue; // function call in FROM
      const tableName = nameToken(table)!;
      if (scope.localNames.has(tableName.toLowerCase())) continue;
      const schemaName = nameToken(schema);
      if (schemaName && !schemaNames.has(schemaName.toLowerCase())) {
        // an unknown or non-introspected schema: nothing to check against
        if (!knownSchemaNames.has(schemaName.toLowerCase()) && !scope.relations.has(schemaName.toLowerCase())) continue;
        if (!schemaNames.has(schemaName.toLowerCase())) continue;
      }
      const found = findRelation(catalog, schemaName ?? defaultSchema, tableName);
      if (found) continue;
      const suggestion = closestName(tableName, allRelationNames);
      out.push({
        start: abs(table.start),
        end: abs(table.end),
        message: `Unable to resolve table '${tableName}'`,
        severity: 'warning',
        fix: suggestion ? { title: `Change to '${suggestion}'`, replacement: suggestion } : undefined,
      });
    }

    // --- qualified columns: alias.column
    for (let i = 0; i < tokens.length - 2; i++) {
      const qual = tokens[i]!;
      const dot = tokens[i + 1]!;
      const col = tokens[i + 2]!;
      if (dot.text !== '.' || (qual.kind !== 'word' && qual.kind !== 'ident')) continue;
      if (col.kind !== 'word' && col.kind !== 'ident') continue;
      if (tokens[i - 1]?.text === '.') continue; // schema.table.column: skip the middle pair
      const qualName = nameToken(qual)!.toLowerCase();
      const relation = scope.relations.get(qualName);
      if (!relation) continue;
      const colName = nameToken(col)!;
      if (relation.columns.some((c) => c.name.toLowerCase() === colName.toLowerCase())) continue;
      const suggestion = closestName(colName, relation.columns.map((c) => c.name));
      out.push({
        start: abs(col.start),
        end: abs(col.end),
        message: `Unable to resolve column '${colName}' in ${relation.name}`,
        severity: 'warning',
        fix: suggestion ? { title: `Change to '${suggestion}'`, replacement: suggestion } : undefined,
      });
    }

    // --- bare columns, when every referenced table resolved and no subquery hides columns
    const resolvedRelations = scope.refs.map((ref) => scope.relations.get(ref.table.toLowerCase()));
    const selectCount = tokens.filter((t) => t.kind === 'word' && t.value === 'select').length;
    if (scope.refs.length === 0 || resolvedRelations.some((r) => !r) || selectCount > 1) continue;
    const allColumns = resolvedRelations.flatMap((r) => r!.columns.map((c) => c.name));
    const tableWords = new Set(scope.refs.flatMap((ref) => [ref.table.toLowerCase(), (ref.alias ?? '').toLowerCase()]));
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.kind !== 'word' && t.kind !== 'ident') continue;
      const name = nameToken(t)!;
      const lower = name.toLowerCase();
      if (t.kind === 'word' && NOT_A_COLUMN.has(lower)) continue;
      if (tableWords.has(lower) || scope.localNames.has(lower)) continue;
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      if (next?.text === '(' || next?.text === '.' || prev?.text === '.') continue;
      if (prev?.text === '::') continue; // cast target type
      // an implicit alias ("count(*) total") or a value in a list of literals
      if (prev && (prev.kind === 'word' && !SQL_KEYWORDS.has(prev.value) && prev.text !== ',' || prev.kind === 'ident' || prev.kind === 'number' || prev.kind === 'string' || prev.text === ')')) continue;
      if (prev?.kind === 'word' && OBJECT_INTRODUCERS.has(prev.value)) continue;
      if (prev?.kind === 'word' && (prev.value === 'as' || prev.value === 'into' || prev.value === 'language')) continue;
      if (allColumns.some((c) => c.toLowerCase() === lower)) continue;
      // a bare name that is another table (a JOIN-less reference) is still a table
      if (allRelationNames.some((r) => r.toLowerCase() === lower)) continue;
      const suggestion = closestName(name, [...allColumns, ...scope.localNames.values()]);
      out.push({
        start: abs(t.start),
        end: abs(t.end),
        message: `Unable to resolve column '${name}'`,
        severity: 'warning',
        fix: suggestion ? { title: `Change to '${suggestion}'`, replacement: suggestion } : undefined,
      });
    }
  }
  return out;
}
