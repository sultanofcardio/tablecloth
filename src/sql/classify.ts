export interface StatementClass {
  /** First significant keyword, lowercased. */
  keyword: string;
  /** Likely produces a row set worth showing in the grid. */
  selectish: boolean;
  /** Definitely modifies data or schema (used for the client-side read-only guard). */
  mutating: boolean;
}

const SELECTISH = new Set(['select', 'values', 'show', 'explain', 'pragma', 'table', 'describe', 'desc', 'with']);

const MUTATING = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'replace',
  'truncate',
  'create',
  'alter',
  'drop',
  'rename',
  'grant',
  'revoke',
  'vacuum',
  'reindex',
  'comment',
  'import',
  'load',
  'call',
  'do',
  'copy',
]);

/** Strip leading comments and whitespace, returning the offset of the first significant char. */
function significantStart(sql: string): number {
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const ch = sql[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
    } else if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) return len;
      i = nl + 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) return len;
      i = close + 2;
    } else {
      return i;
    }
  }
  return len;
}

export function classifyStatement(sql: string): StatementClass {
  const start = significantStart(sql);
  const match = /^[A-Za-z_]+/.exec(sql.slice(start));
  const keyword = match ? match[0].toLowerCase() : '';

  if (keyword === 'with') {
    // WITH can front DML; look for a top-level-ish data-modifying keyword.
    const body = sql.slice(start).toLowerCase();
    const dml = /\b(insert|update|delete|merge)\b/.test(body);
    return { keyword, selectish: !dml, mutating: dml };
  }

  return {
    keyword,
    selectish: SELECTISH.has(keyword),
    mutating: MUTATING.has(keyword),
  };
}
