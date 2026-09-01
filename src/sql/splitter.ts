import type { DriverId } from '../core/types';

export interface SplitStatement {
  /** Statement text with surrounding whitespace trimmed. */
  sql: string;
  /** Offset of the first character of `sql` in the source. */
  start: number;
  /** Offset just past the last character of `sql` in the source. */
  end: number;
}

/**
 * Split a SQL script into statements on semicolons, respecting:
 *  - line comments (`--`, and `#` for MySQL)
 *  - block comments, nested (PostgreSQL nests them; MySQL does not, but treating
 *    them as nested only mis-parses scripts that are already broken)
 *  - single-quoted strings with '' doubling, and backslash escapes for MySQL
 *  - double-quoted identifiers/strings, backtick identifiers (MySQL)
 *  - dollar-quoted strings ($$ … $$, $tag$ … $tag$) for PostgreSQL
 */
export function splitStatements(source: string, dialect: DriverId): SplitStatement[] {
  const statements: SplitStatement[] = [];
  const len = source.length;
  let i = 0;
  let stmtStart = 0;

  const push = (endExclusive: number) => {
    const raw = source.slice(stmtStart, endExclusive);
    const trimmedLeading = raw.length - raw.trimStart().length;
    const sql = raw.trim();
    if (sql.length > 0) {
      statements.push({ sql, start: stmtStart + trimmedLeading, end: stmtStart + trimmedLeading + sql.length });
    }
  };

  while (i < len) {
    const ch = source[i]!;
    const next = i + 1 < len ? source[i + 1] : '';

    // line comments
    if (ch === '-' && next === '-') {
      i = skipToLineEnd(source, i + 2);
      continue;
    }
    if (dialect === 'mysql' && ch === '#') {
      i = skipToLineEnd(source, i + 1);
      continue;
    }

    // block comments (nested)
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < len && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    // single-quoted string
    if (ch === "'") {
      i = skipQuoted(source, i, "'", dialect === 'mysql');
      continue;
    }

    // double-quoted identifier (string in MySQL without ANSI_QUOTES, same skip logic)
    if (ch === '"') {
      i = skipQuoted(source, i, '"', dialect === 'mysql');
      continue;
    }

    // backtick identifier
    if (dialect === 'mysql' && ch === '`') {
      i = skipQuoted(source, i, '`', false);
      continue;
    }

    // dollar-quoted string
    if (dialect === 'postgres' && ch === '$') {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(source.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = source.indexOf(tag, i + tag.length);
        i = close === -1 ? len : close + tag.length;
        continue;
      }
    }

    if (ch === ';') {
      push(i);
      i++;
      stmtStart = i;
      continue;
    }

    i++;
  }
  push(len);
  return statements;
}

/**
 * The statement the caret is genuinely on: inside its text, or after it on the
 * same line with only the terminator and whitespace in between. A caret on a
 * blank line between statements belongs to none of them.
 */
export function statementAt(statements: SplitStatement[], offset: number, source: string): SplitStatement | undefined {
  for (const stmt of statements) {
    if (offset >= stmt.start && offset <= stmt.end) return stmt;
    if (offset > stmt.end) {
      const between = source.slice(stmt.end, offset);
      if (!between.includes('\n') && /^[;\s]*$/.test(between)) return stmt;
    }
  }
  return undefined;
}

function skipToLineEnd(source: string, from: number): number {
  const nl = source.indexOf('\n', from);
  return nl === -1 ? source.length : nl + 1;
}

function skipQuoted(source: string, from: number, quote: string, backslashEscapes: boolean): number {
  let i = from + 1;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    if (backslashEscapes && ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (source[i + 1] === quote) {
        i += 2; // doubled quote
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return len;
}
