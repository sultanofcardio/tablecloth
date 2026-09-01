/** Words that look like aliases in a sloppy FROM-clause regex but never are. */
const NOT_AN_ALIAS = new Set([
  'where',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'outer',
  'on',
  'using',
  'group',
  'order',
  'having',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'set',
  'values',
  'as',
  'returning',
  'for',
  'window',
  'fetch',
]);

export interface TableRef {
  schema?: string;
  table: string;
  alias?: string;
}

export function stripQuotes(name: string): string {
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith('`') && name.endsWith('`'))) {
    return name.slice(1, -1);
  }
  return name;
}

/** Best-effort alias map for a statement: FROM/JOIN/UPDATE/INTO targets. */
export function parseTableRefs(statement: string): TableRef[] {
  const refs: TableRef[] = [];
  const pattern =
    /\b(from|join|update|into)\s+((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*))(?:\s*\.\s*((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)))?(?:\s+(?:as\s+)?((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)))?/gi;
  for (const match of statement.matchAll(pattern)) {
    const [, , first, second, aliasRaw] = match;
    const schema = second ? stripQuotes(first!) : undefined;
    const table = stripQuotes(second ?? first!);
    let alias = aliasRaw ? stripQuotes(aliasRaw) : undefined;
    if (alias && NOT_AN_ALIAS.has(alias.toLowerCase())) alias = undefined;
    refs.push({ schema, table, alias });
  }
  return refs;
}
