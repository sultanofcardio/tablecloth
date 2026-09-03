// SQL formatter in the IntelliJ style the product mimics: clause keywords on
// their own lines, AND/OR indented under WHERE, select lists on one line while
// they fit and aligned under the first item otherwise, subqueries as indented
// blocks, CREATE TABLE with aligned column definitions. Token-based, never
// drops a token, and idempotent.
import type { DriverId } from '../core/types';
import { splitStatements } from './splitter';
import { SQL_FUNCTIONS, SQL_KEYWORDS, tokenize, type Token } from './tokens';

export interface FormatOptions {
  keywordCase?: 'upper' | 'lower' | 'preserve';
  indent?: string;
  maxLineLength?: number;
}

interface Resolved {
  keywordCase: 'upper' | 'lower' | 'preserve';
  indent: string;
  maxLineLength: number;
}

/** A significant token with the comments that travel with it. */
interface Piece {
  kind: Token['kind'];
  text: string;
  lower: string;
  /** Comments on their own line(s) before this piece. */
  leading: string[];
  /** A comment on the same line after this piece. */
  trailing?: string;
}

const JOIN_WORDS = new Set(['join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'outer']);
const SINGLE_CLAUSES = new Set([
  'select',
  'from',
  'where',
  'having',
  'limit',
  'offset',
  'fetch',
  'window',
  'returning',
  'values',
  'set',
  'using',
  'union',
  'intersect',
  'except',
  'for',
]);
const LIST_CLAUSES = new Set(['select', 'group by', 'order by', 'returning', 'partition by']);
const CONDITION_CLAUSES = new Set(['where', 'having']);
const SET_CLAUSES = new Set(['union', 'union all', 'intersect', 'intersect all', 'except', 'except all']);
const BLOCK_OPENERS = new Set(['select', 'with', 'values']);
/** Keywords that keep a space before an opening paren (`IN (1, 2)`), unlike calls. */
const SPACE_BEFORE_PAREN = new Set([
  'in', 'values', 'exists', 'as', 'and', 'or', 'not', 'where', 'on', 'then', 'else', 'when', 'select', 'from', 'join',
  'set', 'key', 'references', 'using', 'over', 'filter', 'distinct', 'primary', 'unique', 'check', 'foreign', 'into',
  'table', 'index', 'by', 'like', 'ilike', 'between', 'is', 'having', 'returning', 'union', 'except', 'intersect',
  'all', 'any', 'some', 'lateral', 'with', 'insert', 'update', 'delete', 'create', 'add', 'constraint', 'default',
]);
const NO_SPACE_AFTER = new Set(['(', '.', '::', '$']);
const NO_SPACE_BEFORE = new Set([',', ')', ';', '::', '.']);
const OPERATORS = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '||', '->', '->>', '#>', '#>>', '@>', '<@', '&&', ':=', '<<', '>>']);
const CONSTRAINT_STARTS = new Set(['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude', 'like', 'index', 'key', 'period']);
/** Type names keep the case they were typed in, like IntelliJ's default style. */
const TYPE_WORDS = new Set([
  'bigint', 'smallint', 'integer', 'int', 'text', 'varchar', 'char', 'character', 'numeric', 'decimal', 'boolean',
  'real', 'double', 'float', 'date', 'time', 'timestamp', 'timestamptz', 'interval', 'json', 'jsonb', 'uuid',
  'serial', 'bit', 'blob', 'datetime', 'nchar', 'precision', 'varying', 'money', 'bytea', 'tinyint', 'mediumint',
  'year', 'enum', 'array', 'zone',
]);
const CASE_INLINE_LIMIT = 60;

function resolve(options?: FormatOptions): Resolved {
  return {
    keywordCase: options?.keywordCase ?? 'upper',
    indent: options?.indent ?? '    ',
    maxLineLength: options?.maxLineLength ?? 100,
  };
}

/** Format a script: each statement laid out, statements separated by a blank line. */
export function formatSql(sql: string, dialect: DriverId, options?: FormatOptions): string {
  const opts = resolve(options);
  const statements = splitStatements(sql, dialect);
  if (statements.length === 0) return sql.trim().length === 0 ? '' : sql;
  const parts: string[] = [];
  for (const stmt of statements) {
    const terminated = /^\s*;/.test(sql.slice(stmt.end));
    const formatter = new Formatter(dialect, opts);
    let text = formatter.statement(stmt.sql);
    if (terminated) text += text.endsWith('\n') ? ';' : ';';
    parts.push(text);
  }
  const trailingNewline = /\n\s*$/.test(sql) ? '\n' : '';
  return parts.join('\n\n') + trailingNewline;
}

class Formatter {
  constructor(
    private readonly dialect: DriverId,
    private readonly opts: Resolved,
  ) {}

  // ------------------------------------------------------------ pieces

  private pieces(text: string): { pieces: Piece[]; tail: string[] } {
    const tokens = tokenize(text, this.dialect);
    const pieces: Piece[] = [];
    let pendingLeading: string[] = [];
    let sawNewlineSinceLast = true;
    for (const token of tokens) {
      if (token.kind === 'ws') {
        if (token.text.includes('\n')) sawNewlineSinceLast = true;
        continue;
      }
      if (token.kind === 'comment') {
        const last = pieces[pieces.length - 1];
        if (last && !sawNewlineSinceLast) {
          last.trailing = last.trailing ? `${last.trailing} ${token.text.trim()}` : token.text.trim();
        } else {
          pendingLeading.push(token.text.trim());
        }
        if (token.text.startsWith('--') || token.text.startsWith('#')) sawNewlineSinceLast = true;
        continue;
      }
      pieces.push({ kind: token.kind, text: token.text, lower: token.value, leading: pendingLeading });
      pendingLeading = [];
      sawNewlineSinceLast = false;
    }
    return { pieces, tail: pendingLeading };
  }

  private word(piece: Piece, next?: Piece, prev?: Piece): string {
    if (piece.kind !== 'word') return piece.text;
    if (this.opts.keywordCase === 'preserve') return piece.text;
    if (!SQL_KEYWORDS.has(piece.lower) && piece.lower !== 'language') return piece.text;
    if (TYPE_WORDS.has(piece.lower)) return piece.text;
    if (prev?.text === '.') return piece.text;
    // a keyword that is also a function keeps its typed case when it is called
    if (next?.text === '(' && SQL_FUNCTIONS.has(piece.lower)) return piece.text;
    return this.opts.keywordCase === 'upper' ? piece.text.toUpperCase() : piece.text.toLowerCase();
  }

  // ------------------------------------------------------------ entry

  statement(text: string): string {
    const { pieces, tail } = this.pieces(text);
    let body: string;
    if (pieces.length === 0) {
      body = '';
    } else {
      const first = pieces[0]!.lower;
      const second = pieces[1]?.lower;
      if (first === 'create' && (second === 'table' || ((second === 'temp' || second === 'temporary' || second === 'unlogged') && pieces[2]?.lower === 'table'))) {
        body = this.createTable(pieces, '');
      } else if (
        first === 'select' ||
        first === 'with' ||
        first === 'insert' ||
        first === 'update' ||
        first === 'delete' ||
        first === 'values' ||
        (first === '(' && pieces[1] && BLOCK_OPENERS.has(pieces[1].lower))
      ) {
        body = this.query(pieces, '');
      } else {
        body = this.inline(pieces, '');
      }
    }
    const lines: string[] = [];
    if (body) lines.push(body);
    for (const comment of tail) lines.push(comment);
    return lines.join('\n');
  }

  // ------------------------------------------------------------ helpers

  private matchingParen(pieces: Piece[], open: number): number {
    let depth = 0;
    for (let i = open; i < pieces.length; i++) {
      const p = pieces[i]!;
      if (p.text === '(') depth++;
      else if (p.text === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return pieces.length - 1;
  }

  /** Split at depth-0 pieces matching `isSep`; separators are dropped unless `keep`. */
  private splitTop(pieces: Piece[], isSep: (p: Piece, i: number, arr: Piece[]) => boolean, keep = false): Piece[][] {
    const groups: Piece[][] = [[]];
    let depth = 0;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      if (p.text === '(') depth++;
      if (p.text === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && p.text !== ')' && isSep(p, i, pieces)) {
        groups.push(keep ? [p] : []);
        continue;
      }
      groups[groups.length - 1]!.push(p);
    }
    return groups;
  }

  private isClauseStart(pieces: Piece[], i: number): number {
    const p = pieces[i]!;
    if (p.kind !== 'word') return 0;
    const next = pieces[i + 1];
    if ((p.lower === 'group' || p.lower === 'order' || p.lower === 'partition') && next?.lower === 'by') return 2;
    if (SINGLE_CLAUSES.has(p.lower)) {
      // "UNION ALL", "EXCEPT ALL"; and FOR only as FOR UPDATE / FOR SHARE
      if (p.lower === 'for') return next && (next.lower === 'update' || next.lower === 'share' || next.lower === 'no') ? 1 : 0;
      if ((p.lower === 'union' || p.lower === 'intersect' || p.lower === 'except') && next && (next.lower === 'all' || next.lower === 'distinct')) return 2;
      return 1;
    }
    if (JOIN_WORDS.has(p.lower)) {
      // consume the whole join phrase: LEFT OUTER JOIN, CROSS JOIN, NATURAL LEFT JOIN
      let j = i;
      while (j < pieces.length && JOIN_WORDS.has(pieces[j]!.lower) && pieces[j]!.lower !== 'join') j++;
      if (pieces[j]?.lower === 'join') return j - i + 1;
      return 0;
    }
    return 0;
  }

  // ------------------------------------------------------------ inline rendering

  /** Render pieces on one logical line; nested subqueries and long CASEs become blocks. */
  private inline(pieces: Piece[], indent: string, seed: Piece[] = []): string {
    let out = '';
    let lineStart = true;
    let prev: Piece | undefined = seed[seed.length - 1];
    let prevPrev: Piece | undefined = seed[seed.length - 2];
    const append = (text: string, spaceBefore: boolean) => {
      if (!lineStart && spaceBefore && !out.endsWith(' ') && !out.endsWith('\n')) out += ' ';
      out += text;
      lineStart = false;
    };
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      const next = pieces[i + 1];
      if (i === 0) lineStart = true;
      for (const comment of p.leading) {
        out += (out.length > 0 && !out.endsWith('\n') ? '\n' : '') + indent + comment + '\n' + indent;
        lineStart = true;
      }

      if (p.text === '(' && next && BLOCK_OPENERS.has(next.lower)) {
        const close = this.matchingParen(pieces, i);
        const inner = pieces.slice(i + 1, close);
        const block = '(\n' + this.query(inner, indent + this.opts.indent) + '\n' + indent + ')';
        append(block, this.spaceBefore(p, prev, prevPrev));
        prevPrev = prev;
        prev = pieces[close] ?? p;
        i = close;
        continue;
      }

      if (p.kind === 'word' && p.lower === 'case') {
        const end = this.matchingCaseEnd(pieces, i);
        const inner = pieces.slice(i, end + 1);
        const flat = this.flat(inner);
        const text = flat.length <= CASE_INLINE_LIMIT ? flat : this.caseBlock(inner, indent);
        append(text, this.spaceBefore(p, prev, prevPrev));
        prevPrev = prev;
        prev = pieces[end] ?? p;
        i = end;
        continue;
      }

      append(this.word(p, next, prev), this.spaceBefore(p, prev, prevPrev));
      if (p.trailing) {
        out += ' ' + p.trailing + '\n' + indent;
        lineStart = true;
      }
      prevPrev = prev;
      prev = p;
    }
    // a trailing comment on the last piece must not leave a dangling continuation line
    return out.replace(/\n[ \t]*$/, '').replace(/[ \t]+$/g, '');
  }

  /** Everything on one line, comments folded in (used for width checks and short CASEs). */
  private flat(pieces: Piece[]): string {
    let out = '';
    let prev: Piece | undefined;
    let prevPrev: Piece | undefined;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      const text = this.word(p, pieces[i + 1], prev);
      if (out.length > 0 && this.spaceBefore(p, prev, prevPrev)) out += ' ';
      out += text;
      if (p.trailing) out += ' ' + p.trailing;
      prevPrev = prev;
      prev = p;
    }
    return out;
  }

  private spaceBefore(p: Piece, prev: Piece | undefined, prevPrev: Piece | undefined): boolean {
    if (!prev) return false;
    if (NO_SPACE_BEFORE.has(p.text)) return false;
    if (NO_SPACE_AFTER.has(prev.text)) return false;
    if (p.text === '(') {
      if (prev.kind === 'ident') return this.identTakesSpace(prevPrev);
      if (prev.kind === 'word') {
        if (SPACE_BEFORE_PAREN.has(prev.lower)) return true;
        if (SQL_FUNCTIONS.has(prev.lower)) return false;
        if (SQL_KEYWORDS.has(prev.lower)) return true;
        return this.identTakesSpace(prevPrev);
      }
      return prev.kind === 'punct' && prev.text !== ')';
    }
    // unary minus: after an operator, an opening paren, a comma, or a keyword
    if (p.kind === 'number' && prev.text === '-') {
      if (!prevPrev) return false;
      if (OPERATORS.has(prevPrev.text) || prevPrev.text === '(' || prevPrev.text === ',') return false;
      if (prevPrev.kind === 'word' && SQL_KEYWORDS.has(prevPrev.lower)) return false;
    }
    if (prev.text === '-' && p.kind === 'number') return true;
    return true;
  }

  /** `INSERT INTO t (a)` keeps the space; `t(a)` would read as a call. */
  private identTakesSpace(prevPrev: Piece | undefined): boolean {
    if (!prevPrev) return false;
    return prevPrev.kind === 'word' && ['into', 'table', 'references', 'on', 'update', 'from', 'join', 'exists', 'index', 'view', 'type'].includes(prevPrev.lower);
  }

  private matchingCaseEnd(pieces: Piece[], start: number): number {
    let depth = 0;
    for (let i = start; i < pieces.length; i++) {
      const p = pieces[i]!;
      if (p.kind !== 'word') continue;
      if (p.lower === 'case') depth++;
      else if (p.lower === 'end') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return pieces.length - 1;
  }

  private caseBlock(inner: Piece[], indent: string): string {
    const deeper = indent + this.opts.indent;
    const head = inner[0]!;
    const end = inner[inner.length - 1]!;
    const middle = inner.slice(1, -1);
    // CASE expr WHEN ... : anything before the first WHEN stays on the CASE line
    const firstWhen = middle.findIndex((p) => p.kind === 'word' && p.lower === 'when');
    const subject = firstWhen > 0 ? middle.slice(0, firstWhen) : [];
    const branches = this.splitTop(firstWhen >= 0 ? middle.slice(firstWhen) : middle, (p) => p.kind === 'word' && (p.lower === 'when' || p.lower === 'else'), true);
    const lines: string[] = [this.word(head) + (subject.length ? ' ' + this.inline(subject, deeper) : '')];
    for (const branch of branches) {
      if (branch.length === 0) continue;
      lines.push(deeper + this.inline(branch, deeper));
    }
    lines.push(indent + this.word(end));
    return lines.join('\n');
  }

  // ------------------------------------------------------------ queries

  /** SELECT / INSERT / UPDATE / DELETE / WITH / VALUES laid out clause by clause. */
  private query(pieces: Piece[], indent: string): string {
    const segments: { head: Piece[]; body: Piece[] }[] = [];
    let current = { head: [] as Piece[], body: [] as Piece[] };
    let depth = 0;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      if (p.text === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && p.text !== '(') {
        let len = this.isClauseStart(pieces, i);
        // statement heads: INSERT INTO, DELETE FROM, UPDATE, WITH
        if (i === 0) {
          if (p.lower === 'insert' && pieces[1]?.lower === 'into') len = 2;
          else if (p.lower === 'delete' && pieces[1]?.lower === 'from') len = 2;
          else if (p.lower === 'insert' || p.lower === 'update' || p.lower === 'with' || p.lower === 'delete') len = 1;
        }
        if (len > 0) {
          if (current.head.length > 0 || current.body.length > 0) segments.push(current);
          current = { head: pieces.slice(i, i + len), body: [] };
          i += len - 1;
          continue;
        }
      }
      if (p.text === '(') depth++;
      current.body.push(p);
    }
    if (current.head.length > 0 || current.body.length > 0) segments.push(current);

    const lines: string[] = [];
    for (const segment of segments) {
      const headPieces = segment.head;
      const headKey = headPieces.map((h) => h.lower).join(' ');
      const leading = headPieces[0]?.leading ?? segment.body[0]?.leading ?? [];
      for (const comment of leading) lines.push(indent + comment);
      if (headPieces[0]) headPieces[0].leading = [];
      const headText = headPieces.map((h, i) => this.word(h, headPieces[i + 1] ?? segment.body[0], headPieces[i - 1])).join(' ');
      let text: string;
      if (headKey === '') {
        text = this.inline(segment.body, indent);
      } else if (headKey === 'with') {
        text = this.withClause(headText, segment.body, indent);
      } else if (headKey === 'select' || headKey === 'select distinct') {
        text = this.list(this.selectHead(headText, segment), indent);
      } else if (LIST_CLAUSES.has(headKey)) {
        text = this.list({ headText, body: segment.body }, indent);
      } else if (CONDITION_CLAUSES.has(headKey)) {
        text = this.conditions(headText, segment.body, indent);
      } else if (headKey.endsWith('join')) {
        text = this.join(headText, segment.body, indent);
      } else if (headKey === 'set') {
        text = this.setClause(headText, segment.body, indent);
      } else if (headKey === 'values') {
        text = this.valuesClause(headText, segment.body, indent);
      } else if (SET_CLAUSES.has(headKey)) {
        text = headText + (segment.body.length ? ' ' + this.inline(segment.body, indent, headPieces) : '');
      } else {
        text = headText + (segment.body.length ? ' ' + this.inline(segment.body, indent, headPieces) : '');
      }
      lines.push(indent + text);
    }
    return lines.join('\n');
  }

  /** SELECT DISTINCT / SELECT ALL travel with the head so the list aligns after them. */
  private selectHead(headText: string, segment: { head: Piece[]; body: Piece[] }): { headText: string; body: Piece[] } {
    const first = segment.body[0];
    if (first && first.kind === 'word' && (first.lower === 'distinct' || first.lower === 'all') && segment.body[1]?.lower !== 'on') {
      return { headText: `${headText} ${this.word(first)}`, body: segment.body.slice(1) };
    }
    return { headText, body: segment.body };
  }

  /** A comma list: one line when it fits, else one item per line aligned under the first. */
  private list(input: { headText: string; body: Piece[] }, indent: string): string {
    const { headText, body } = input;
    if (body.length === 0) return headText;
    const items = this.splitTop(body, (p) => p.text === ',').map((item) => this.inline(item, indent + ' '.repeat(headText.length + 1)));
    // a trailing comment inside the list ends the line, so anything after it must wrap
    const commentInside = items.slice(0, -1).some((item) => item.includes('\n') || /(^|\s)(--|#)/.test(item));
    const oneLine = `${headText} ${items.join(', ')}`;
    const fits = items.length === 1 || (!commentInside && !oneLine.includes('\n') && (indent + oneLine).length <= this.opts.maxLineLength);
    if (fits) return oneLine;
    const pad = ' '.repeat(headText.length + 1);
    return `${headText} ${items.map((item, i) => (i === 0 ? item : indent + pad + item)).join(',\n')}`;
  }

  /** WHERE a\n  AND b\n   OR c */
  private conditions(headText: string, body: Piece[], indent: string): string {
    if (body.length === 0) return headText;
    const parts = this.splitTop(body, (p) => p.kind === 'word' && (p.lower === 'and' || p.lower === 'or'), true);
    const lines: string[] = [];
    for (const [i, part] of parts.entries()) {
      if (part.length === 0) continue;
      if (i === 0) {
        lines.push(`${headText} ${this.inline(part, indent)}`);
        continue;
      }
      const connector = part[0]!;
      const rest = part.slice(1);
      const kw = this.word(connector);
      const lead = connector.lower === 'or' ? '   ' : '  ';
      lines.push(`${indent}${lead}${kw} ${this.inline(rest, indent + lead + ' '.repeat(kw.length + 1))}`);
    }
    return lines.join('\n');
  }

  /** JOIN t alias ON cond [AND cond] */
  private join(headText: string, body: Piece[], indent: string): string {
    const onIndex = this.splitIndex(body, (p) => p.kind === 'word' && (p.lower === 'on' || p.lower === 'using'));
    if (onIndex < 0) return `${headText} ${this.inline(body, indent)}`;
    const target = body.slice(0, onIndex);
    const connector = body[onIndex]!;
    const cond = body.slice(onIndex + 1);
    const prefix = `${headText} ${this.inline(target, indent)} ${this.word(connector)}`;
    if (connector.lower === 'using') return `${prefix} ${this.inline(cond, indent)}`;
    return this.conditions(prefix, cond, indent);
  }

  private splitIndex(pieces: Piece[], isMatch: (p: Piece) => boolean): number {
    let depth = 0;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      if (p.text === '(') depth++;
      else if (p.text === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0 && isMatch(p)) return i;
    }
    return -1;
  }

  /** SET a = 1,\n    b = 2 */
  private setClause(headText: string, body: Piece[], indent: string): string {
    const items = this.splitTop(body, (p) => p.text === ',');
    const pad = ' '.repeat(headText.length + 1);
    return `${headText} ${items.map((item, i) => (i === 0 ? '' : indent + pad) + this.inline(item, indent + pad)).join(',\n')}`;
  }

  /** VALUES (..),\n       (..) */
  private valuesClause(headText: string, body: Piece[], indent: string): string {
    const items = this.splitTop(body, (p) => p.text === ',');
    const pad = ' '.repeat(headText.length + 1);
    return `${headText} ${items.map((item, i) => (i === 0 ? '' : indent + pad) + this.inline(item, indent + pad)).join(',\n')}`;
  }

  /** WITH a AS (\n    …\n),\nb AS (\n    …\n) */
  private withClause(headText: string, body: Piece[], indent: string): string {
    const ctes = this.splitTop(body, (p) => p.text === ',');
    const rendered = ctes.map((cte) => this.inline(cte, indent));
    return `${headText} ${rendered.join(',\n' + indent)}`;
  }

  // ------------------------------------------------------------ CREATE TABLE

  private createTable(pieces: Piece[], indent: string): string {
    const open = pieces.findIndex((p) => p.text === '(');
    if (open < 0) return this.inline(pieces, indent);
    const close = this.matchingParen(pieces, open);
    const head = this.inline(pieces.slice(0, open), indent);
    const defs = this.splitTop(pieces.slice(open + 1, close), (p) => p.text === ',');
    const rest = pieces.slice(close + 1);
    const deeper = indent + this.opts.indent;

    const columns = defs.map((def) => {
      const first = def[0];
      const isColumn = !!first && (first.kind === 'ident' || (first.kind === 'word' && !CONSTRAINT_STARTS.has(first.lower)));
      return { isColumn, name: isColumn ? this.word(first!, def[1]) : '', rest: isColumn ? def.slice(1) : def, leading: first?.leading ?? [] };
    });
    const width = Math.max(0, ...columns.filter((c) => c.isColumn).map((c) => c.name.length));
    const lines: string[] = [head, `${indent}(`];
    columns.forEach((column, i) => {
      for (const comment of column.leading) lines.push(deeper + comment);
      if (column.rest[0]) column.rest[0].leading = [];
      const body = this.inline(column.rest, deeper);
      const text = column.isColumn ? `${column.name.padEnd(width)}${body ? ' ' + body : ''}` : body;
      lines.push(`${deeper}${text}${i < columns.length - 1 ? ',' : ''}`);
    });
    lines.push(`${indent})${rest.length ? ' ' + this.inline(rest, indent) : ''}`);
    return lines.join('\n');
  }
}
