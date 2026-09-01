export interface StatementClass {
  /** First significant keyword, lowercased. */
  keyword: string;
  /** Likely produces a row set worth showing in the grid. */
  selectish: boolean;
  /** Definitely modifies data or schema (read-only is enforced server-side per session). */
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

/** Blank out string literals, quoted identifiers, and comments (splitter-style scan). */
function stripLiteralsAndComments(sql: string): string {
  const len = sql.length;
  let out = '';
  let i = 0;
  while (i < len) {
    const ch = sql[i]!;
    const next = i + 1 < len ? sql[i + 1] : '';
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? len : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < len && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < len) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2; // doubled quote
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      continue;
    }
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? len : close + tag.length;
        out += ' ';
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export function classifyStatement(sql: string): StatementClass {
  const start = significantStart(sql);
  const match = /^[A-Za-z_]+/.exec(sql.slice(start));
  const keyword = match ? match[0].toLowerCase() : '';

  if (keyword === 'with') {
    // WITH can front DML; look for a top-level-ish data-modifying keyword,
    // ignoring keywords buried in strings, quoted identifiers, or comments.
    const body = stripLiteralsAndComments(sql.slice(start)).toLowerCase();
    const dml = /\b(insert|update|delete|merge)\b/.test(body);
    return { keyword, selectish: !dml, mutating: dml };
  }

  return {
    keyword,
    selectish: SELECTISH.has(keyword),
    mutating: MUTATING.has(keyword),
  };
}
