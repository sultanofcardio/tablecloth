import type { DriverId } from '../core/types';

export type TokenKind =
  /** Unquoted word: a keyword or a bare identifier. */
  | 'word'
  /** Quoted identifier ("name" or `name`); `value` holds the unquoted name. */
  | 'ident'
  /** String literal, including dollar-quoted strings. */
  | 'string'
  | 'number'
  /** Bind parameter (:name, ${name}, ?, $1); `value` holds the bare name. */
  | 'param'
  /** Operators and punctuation, one token per operator. */
  | 'punct'
  | 'comment'
  | 'ws';

export interface Token {
  kind: TokenKind;
  /** Raw source text of the token. */
  text: string;
  start: number;
  end: number;
  /** Lowercased text for words; the unquoted name for identifiers and parameters. */
  value: string;
}

const MULTI_CHAR_OPERATORS = [
  '->>',
  '#>>',
  '::',
  '<=',
  '>=',
  '<>',
  '!=',
  '||',
  '->',
  '#>',
  '@>',
  '<@',
  '?|',
  '?&',
  '#-',
  '&&',
  '<<',
  '>>',
  ':=',
];

function isWordStart(ch: string): boolean {
  return /[A-Za-z_\u0080-\uffff]/.test(ch);
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uffff]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * Tokenize a SQL script. Trivia (whitespace, comments) is included so callers
 * that rewrite text can round-trip it; `significant()` drops it. The scan
 * never throws: unterminated strings and comments run to the end of input.
 */
export function tokenize(sql: string, dialect: DriverId): Token[] {
  const tokens: Token[] = [];
  const len = sql.length;
  let i = 0;

  const push = (kind: TokenKind, start: number, end: number, value?: string) => {
    const text = sql.slice(start, end);
    tokens.push({ kind, text, start, end, value: value ?? text });
  };

  while (i < len) {
    const ch = sql[i]!;
    const next = i + 1 < len ? sql[i + 1]! : '';

    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      let j = i + 1;
      while (j < len && /\s/.test(sql[j]!)) j++;
      push('ws', i, j);
      i = j;
      continue;
    }

    // line comments
    if ((ch === '-' && next === '-') || (dialect === 'mysql' && ch === '#')) {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? len : nl;
      push('comment', i, end);
      i = end;
      continue;
    }

    // block comments, nested
    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < len && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      push('comment', i, j);
      i = j;
      continue;
    }

    // string literals
    if (ch === "'") {
      const end = skipQuoted(sql, i, "'", dialect === 'mysql');
      push('string', i, end);
      i = end;
      continue;
    }

    // quoted identifiers: "name" everywhere (a string in MySQL without
    // ANSI_QUOTES, but naming the same thing for our purposes), `name` in MySQL
    if (ch === '"' || (dialect === 'mysql' && ch === '`')) {
      const end = skipQuoted(sql, i, ch, false);
      const inner = sql.slice(i + 1, end - (sql[end - 1] === ch && end - 1 > i ? 1 : 0));
      push('ident', i, end, inner.replaceAll(ch + ch, ch));
      i = end;
      continue;
    }

    // dollar-quoted strings and $n / ${name} parameters
    if (ch === '$') {
      if (dialect === 'postgres') {
        const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
        if (tagMatch) {
          const tag = tagMatch[0];
          const close = sql.indexOf(tag, i + tag.length);
          const end = close === -1 ? len : close + tag.length;
          push('string', i, end);
          i = end;
          continue;
        }
        const positional = /^\$(\d+)/.exec(sql.slice(i));
        if (positional) {
          push('param', i, i + positional[0].length, positional[1]!);
          i += positional[0].length;
          continue;
        }
      }
      const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(sql.slice(i));
      if (braced) {
        push('param', i, i + braced[0].length, braced[1]!);
        i += braced[0].length;
        continue;
      }
    }

    // :name parameters (but not the :: cast operator or a := assignment)
    if (ch === ':' && next !== ':' && next !== '=' && (i === 0 || sql[i - 1] !== ':')) {
      const named = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (named) {
        push('param', i, i + named[0].length, named[1]!);
        i += named[0].length;
        continue;
      }
    }

    // ? positional parameter (MySQL and SQLite; a JSON operator in Postgres)
    if (ch === '?' && dialect !== 'postgres') {
      push('param', i, i + 1, '?');
      i++;
      continue;
    }

    // numbers
    if (isDigit(ch) || (ch === '.' && isDigit(next))) {
      const match = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(sql.slice(i));
      const end = i + match![0].length;
      push('number', i, end);
      i = end;
      continue;
    }

    // words: keywords and bare identifiers
    if (isWordStart(ch)) {
      let j = i + 1;
      while (j < len && isWordChar(sql[j]!)) j++;
      push('word', i, j, sql.slice(i, j).toLowerCase());
      i = j;
      continue;
    }

    // operators
    const op = MULTI_CHAR_OPERATORS.find((candidate) => sql.startsWith(candidate, i));
    if (op) {
      push('punct', i, i + op.length);
      i += op.length;
      continue;
    }
    push('punct', i, i + 1);
    i++;
  }
  return tokens;
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
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return len;
}

/** Tokens without whitespace and comments. */
export function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.kind !== 'ws' && t.kind !== 'comment');
}

/** Reserved words and common keywords across the three dialects, lowercased. */
export const SQL_KEYWORDS: ReadonlySet<string> = new Set([
  'add', 'all', 'alter', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'authorization', 'autoincrement',
  'begin', 'between', 'bigint', 'binary', 'bit', 'blob', 'boolean', 'both', 'by',
  'call', 'cascade', 'case', 'cast', 'char', 'character', 'check', 'collate', 'column', 'commit', 'concurrently',
  'conflict', 'constraint', 'create', 'cross', 'current', 'current_date', 'current_time', 'current_timestamp',
  'current_user', 'cube',
  'database', 'date', 'datetime', 'decimal', 'declare', 'default', 'deferrable', 'delete', 'desc', 'describe',
  'distinct', 'do', 'double', 'drop',
  'each', 'else', 'end', 'enum', 'escape', 'except', 'exclude', 'exists', 'explain', 'extract',
  'false', 'fetch', 'filter', 'first', 'float', 'following', 'for', 'foreign', 'from', 'full', 'function',
  'generated', 'glob', 'grant', 'group', 'grouping', 'groups',
  'having',
  'identity', 'if', 'ilike', 'immediate', 'in', 'index', 'indexed', 'initially', 'inner', 'insert', 'int', 'integer',
  'intersect', 'interval', 'into', 'is', 'isnull', 'isolation',
  'join', 'json', 'jsonb',
  'key',
  'language', 'last', 'lateral', 'leading', 'left', 'level', 'like', 'limit', 'localtime', 'localtimestamp', 'lock',
  'match', 'materialized', 'merge',
  'natural', 'nchar', 'no', 'not', 'nothing', 'notnull', 'now', 'null', 'nulls', 'numeric',
  'of', 'off', 'offset', 'on', 'only', 'or', 'order', 'others', 'outer', 'over', 'overlaps',
  'partition', 'placing', 'pragma', 'preceding', 'precision', 'primary', 'procedure',
  'range', 'read', 'real', 'recursive', 'references', 'regexp', 'reindex', 'release', 'rename', 'repeatable',
  'replace', 'restrict', 'returning', 'returns', 'revoke', 'right', 'rlike', 'rollback', 'rollup', 'row', 'rows',
  'savepoint', 'schema', 'select', 'sequence', 'serial', 'serializable', 'session', 'session_user', 'set',
  'show', 'similar', 'smallint', 'some', 'start', 'symmetric',
  'table', 'tablesample', 'temp', 'temporary', 'text', 'then', 'ties', 'time', 'timestamp', 'timestamptz',
  'to', 'trailing', 'transaction', 'trigger', 'true', 'truncate', 'type',
  'unbounded', 'uncommitted', 'union', 'unique', 'unknown', 'update', 'use', 'user', 'using', 'uuid',
  'vacuum', 'values', 'varchar', 'variadic', 'varying', 'verbose', 'view', 'virtual',
  'when', 'where', 'window', 'with', 'within', 'without', 'work', 'write',
  'zone',
]);

/** Functions offered by completion and skipped by identifier inspections, lowercased. */
export const SQL_FUNCTIONS: ReadonlySet<string> = new Set([
  'abs', 'array_agg', 'avg', 'bool_and', 'bool_or', 'cast', 'ceil', 'ceiling', 'char_length', 'coalesce',
  'concat', 'concat_ws', 'count', 'current_date', 'current_time', 'current_timestamp', 'date', 'date_part',
  'date_trunc', 'datetime', 'extract', 'floor', 'format', 'generate_series', 'greatest', 'group_concat',
  'ifnull', 'initcap', 'json_agg', 'json_build_object', 'json_extract', 'json_object', 'jsonb_agg',
  'jsonb_build_object', 'lag', 'lead', 'least', 'left', 'length', 'lower', 'lpad', 'ltrim', 'max', 'md5',
  'min', 'mod', 'now', 'nullif', 'nvl', 'percent_rank', 'position', 'power', 'random', 'rank', 'regexp_replace',
  'repeat', 'replace', 'reverse', 'right', 'round', 'row_number', 'rpad', 'rtrim', 'sign', 'split_part', 'sqrt',
  'string_agg', 'strftime', 'substr', 'substring', 'sum', 'to_char', 'to_date', 'to_timestamp', 'trim', 'trunc',
  'unnest', 'upper', 'uuid_generate_v4', 'gen_random_uuid',
]);

export function isKeyword(word: string): boolean {
  return SQL_KEYWORDS.has(word.toLowerCase());
}
