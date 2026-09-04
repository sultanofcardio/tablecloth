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

/** `IS [NOT] DISTINCT FROM x` and `ON DUPLICATE KEY UPDATE x` name values, so their FROM / UPDATE introduce no table. */
const NOT_AN_INTRODUCER_AFTER = [/\bis\s+(?:not\s+)?distinct\s+$/i, /\bon\s+duplicate\s+key\s+$/i];

const NAME_SOURCE = '(?:"[^"]+"|`[^`]+`|[A-Za-z_][\\w$]*)';
const TARGET = new RegExp(`\\b(from|join|update|into)\\s+(${NAME_SOURCE})(?:\\s*\\.\\s*(${NAME_SOURCE}))?`, 'gi');
const ALIAS = new RegExp(`^\\s+(?:(as)\\s+)?(${NAME_SOURCE})`, 'i');

/** Best-effort alias map for a statement: FROM/JOIN/UPDATE/INTO targets. */
export function parseTableRefs(statement: string): TableRef[] {
  const refs: TableRef[] = [];
  TARGET.lastIndex = 0;
  for (let match = TARGET.exec(statement); match; match = TARGET.exec(statement)) {
    const [, , first, second] = match;
    const afterTable = TARGET.lastIndex;
    // an alias is only consumed once it is one, so `FROM key JOIN t` still sees the JOIN
    let alias: string | undefined;
    const candidate = ALIAS.exec(statement.slice(afterTable));
    if (candidate) {
      const name = stripQuotes(candidate[2]!);
      if (candidate[1] || !NOT_AN_ALIAS.has(name.toLowerCase())) {
        alias = name;
        TARGET.lastIndex = afterTable + candidate[0].length;
      }
    }
    if (NOT_AN_INTRODUCER_AFTER.some((pattern) => pattern.test(statement.slice(0, match!.index)))) continue;
    refs.push({ schema: second ? stripQuotes(first!) : undefined, table: stripQuotes(second ?? first!), alias });
  }
  return refs;
}
