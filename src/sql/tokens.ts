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
  /** MySQL user or system variable (@name, @@session.name, @'quoted'); `value` is lowercased. */
  | 'variable'
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
  /** A quoted token or comment whose closing delimiter is missing, so it runs to the end of the input. */
  unterminated?: boolean;
}

const MULTI_CHAR_OPERATORS = [
  '!~~*',
  '<<=',
  '>>=',
  '<=>',
  '->>',
  '#>>',
  '!~*',
  '~~*',
  '!~~',
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
  '=>',
  '!~',
  '~*',
  '~~',
];

/** Characters PostgreSQL allows in operator names; a run of them is one operator. */
const PG_OPERATOR_CHARS = new Set(['+', '-', '*', '/', '<', '>', '=', '~', '!', '@', '#', '%', '^', '&', '|', '`', '?']);
/** An operator run may only end in + or - when it contains one of these. */
const PG_OPERATOR_SIGN_KEEPERS = new Set(['~', '!', '@', '#', '%', '^', '&', '|', '`', '?']);

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
 * Length of the prefix of a string literal starting at `i`: `E'`, `U&'`,
 * `X'`, `B'`, `N'` and MySQL charset introducers like `_utf8mb4'`. The quote
 * must follow the prefix directly, so `SELECT e 'x'` stays a word and a string.
 */
function stringPrefixLength(sql: string, i: number, dialect: DriverId): number {
  const ch = sql[i]!;
  const lower = ch.toLowerCase();
  if (sql[i + 1] === "'") {
    if (lower === 'x' || lower === 'b' || lower === 'n') return 1;
    if (lower === 'e' && dialect === 'postgres') return 1;
    return 0;
  }
  if (lower === 'u' && dialect === 'postgres' && sql[i + 1] === '&' && sql[i + 2] === "'") return 2;
  if (ch === '_' && dialect === 'mysql') {
    let j = i + 1;
    while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
    if (j > i + 1 && sql[j] === "'") return j - i;
  }
  return 0;
}

/**
 * End of a PostgreSQL operator starting at `i`: the longest run of operator
 * characters, stopped before a comment opener, and trimmed of trailing + or -
 * unless the run also contains a character from PG_OPERATOR_SIGN_KEEPERS.
 */
function pgOperatorEnd(sql: string, i: number): number {
  let j = i;
  while (j < sql.length && PG_OPERATOR_CHARS.has(sql[j]!)) {
    if (j > i && ((sql[j] === '-' && sql[j + 1] === '-') || (sql[j] === '/' && sql[j + 1] === '*'))) break;
    j++;
  }
  const run = sql.slice(i, j);
  if ([...run].some((c) => PG_OPERATOR_SIGN_KEEPERS.has(c))) return j;
  while (j - i > 1 && (sql[j - 1] === '+' || sql[j - 1] === '-')) j--;
  return j;
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

  const push = (kind: TokenKind, start: number, end: number, value?: string, unterminated?: boolean) => {
    const text = sql.slice(start, end);
    const token: Token = { kind, text, start, end, value: value ?? text };
    if (unterminated) token.unterminated = true;
    tokens.push(token);
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
      push('comment', i, j, undefined, depth > 0);
      i = j;
      continue;
    }

    // string literals, with any prefix (E'..', U&'..', X'..', B'..', N'..', _utf8mb4'..').
    // MySQL without ANSI_QUOTES, the default, reads "..." as a string literal too.
    const doubleQuotedString = ch === '"' && dialect === 'mysql';
    const prefix = isWordStart(ch) ? stringPrefixLength(sql, i, dialect) : 0;
    if (ch === "'" || doubleQuotedString || prefix > 0) {
      const quote = doubleQuotedString ? '"' : "'";
      const escapes = dialect === 'mysql' || (prefix === 1 && ch.toLowerCase() === 'e');
      const { end, closed } = skipQuoted(sql, i + prefix, quote, escapes);
      push('string', i, end, undefined, !closed);
      i = end;
      continue;
    }

    // MySQL user and system variables: @name, @@name, @'name', @`name`
    if (ch === '@' && dialect === 'mysql') {
      const at = next === '@' ? i + 2 : i + 1;
      const quote = sql[at];
      if (quote === "'" || quote === '"' || quote === '`') {
        const { end, closed } = skipQuoted(sql, at, quote, quote !== '`');
        push('variable', i, end, sql.slice(i, end).toLowerCase(), !closed);
        i = end;
        continue;
      }
      let j = at;
      while (j < len && /[A-Za-z0-9_$.]/.test(sql[j]!)) j++;
      if (j > at) {
        push('variable', i, j, sql.slice(i, j).toLowerCase());
        i = j;
        continue;
      }
    }

    // quoted identifiers: "name" on PostgreSQL and SQLite, `name` in MySQL,
    // whose "name" is a string literal and was lexed above
    if ((ch === '"' && dialect !== 'mysql') || (ch === '`' && dialect === 'mysql')) {
      const { end, closed } = skipQuoted(sql, i, ch, false);
      const inner = sql.slice(i + 1, end - (closed ? 1 : 0));
      push('ident', i, end, inner.replaceAll(ch + ch, ch), !closed);
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
          push('string', i, end, undefined, close === -1);
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

    // numbers, including 0x1F hex and 0b101 binary literals
    if (isDigit(ch) || (ch === '.' && isDigit(next))) {
      const match = /^0[xX][0-9A-Fa-f]+|^0[bB][01]+|^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(sql.slice(i));
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

    // operators: PostgreSQL allows user-defined ones, so any run of operator
    // characters is one token there; the other dialects have a fixed list
    if (dialect === 'postgres' && PG_OPERATOR_CHARS.has(ch)) {
      const end = pgOperatorEnd(sql, i);
      push('punct', i, end);
      i = end;
      continue;
    }
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

function skipQuoted(
  source: string,
  from: number,
  quote: string,
  backslashEscapes: boolean,
): { end: number; closed: boolean } {
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
      return { end: i + 1, closed: true };
    }
    i++;
  }
  return { end: len, closed: false };
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
