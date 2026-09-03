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

/** A rendered list item; the trailing comment of its last piece is held back so a comma can precede it. */
interface Item {
  text: string;
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
const BLOCK_OPENERS = new Set(['select', 'with', 'values']);
/** Keywords that keep a space before an opening paren (`IN (1, 2)`), unlike calls. */
const SPACE_BEFORE_PAREN = new Set([
  'in', 'values', 'exists', 'as', 'and', 'or', 'not', 'where', 'on', 'then', 'else', 'when', 'select', 'from', 'join',
  'set', 'key', 'references', 'using', 'over', 'filter', 'distinct', 'primary', 'unique', 'check', 'foreign', 'into',
  'table', 'index', 'by', 'like', 'ilike', 'between', 'is', 'having', 'returning', 'union', 'except', 'intersect',
  'all', 'any', 'some', 'lateral', 'with', 'insert', 'update', 'delete', 'create', 'add', 'constraint', 'default',
]);
const NO_SPACE_AFTER = new Set(['(', '.', '::', '$', '[']);
const NO_SPACE_BEFORE = new Set([',', ')', ';', '::', '.', '[', ']']);
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

function isLineComment(text: string): boolean {
  return text.startsWith('--') || text.startsWith('#');
}

/** Whether the text ends in a line comment, so nothing may follow it on the same line. */
function endsWithLineComment(text: string | undefined, dialect: DriverId): boolean {
  if (!text) return false;
  const tokens = tokenize(text, dialect);
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last]!.kind === 'ws') last--;
  const token = tokens[last];
  return !!token && token.kind === 'comment' && isLineComment(token.text);
}

function present(comments: (string | undefined)[]): string[] {
  return comments.filter((c): c is string => !!c);
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
    if (terminated) text += endsWithLineComment(text, dialect) ? '\n;' : ';';
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
        if (isLineComment(token.text)) sawNewlineSinceLast = true;
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

  private endsLine(comment: string | undefined): boolean {
    return endsWithLineComment(comment, this.dialect);
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

  /**
   * Split at depth-0 pieces matching `isSep`. Separators are dropped unless
   * `keep`; a dropped separator's comments move to the neighbouring pieces so
   * none is lost: its trailing comment onto the piece before it, its leading
   * comments (and the trailing one when it cannot join) onto the piece after.
   */
  private splitTop(pieces: Piece[], isSep: (p: Piece, i: number, arr: Piece[]) => boolean, keep = false): Piece[][] {
    const groups: Piece[][] = [[]];
    let depth = 0;
    let pending: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      let p = pieces[i]!;
      if (p.text === '(') depth++;
      if (p.text === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && p.text !== ')' && isSep(p, i, pieces)) {
        if (keep) {
          groups.push([p]);
          continue;
        }
        const group = groups[groups.length - 1]!;
        const last = group[group.length - 1];
        const carried = [...p.leading];
        if (p.trailing) {
          if (last && carried.length === 0 && !this.endsLine(last.trailing)) {
            group[group.length - 1] = { ...last, trailing: present([last.trailing, p.trailing]).join(' ') };
          } else {
            carried.push(p.trailing);
          }
        }
        pending.push(...carried);
        groups.push([]);
        continue;
      }
      if (pending.length > 0) {
        p = { ...p, leading: [...pending, ...p.leading] };
        pending = [];
      }
      groups[groups.length - 1]!.push(p);
    }
    if (pending.length > 0) {
      // comments after a final separator with nothing behind it stay with the last piece
      const group = groups.slice().reverse().find((g) => g.length > 0);
      const last = group?.[group.length - 1];
      if (group && last) group[group.length - 1] = { ...last, trailing: present([last.trailing, ...pending]).join(' ') };
    }
    return groups;
  }

  /** The first piece's own-line comments, taken off so a caller can place them after a head word. */
  private detachLeading(pieces: Piece[]): { pieces: Piece[]; comments: string[] } {
    const first = pieces[0];
    if (!first || first.leading.length === 0) return { pieces, comments: [] };
    return { pieces: [{ ...first, leading: [] }, ...pieces.slice(1)], comments: first.leading };
  }

  /**
   * `head rest`, with comments between them: block comments stay inline,
   * and after a line comment the rest continues on the next line
   * aligned after the head so the comment cannot swallow it.
   */
  private headed(head: string, comments: string[], rest: string, indent: string): string {
    const pad = ' '.repeat(head.length - head.lastIndexOf('\n'));
    const continuation = (head.includes('\n') ? '' : indent) + pad;
    let out = head;
    let atLineStart = false;
    for (const comment of comments) {
      out += (atLineStart ? continuation : ' ') + comment;
      atLineStart = this.endsLine(comment);
      if (atLineStart) out += '\n';
    }
    if (rest) out += (atLineStart ? continuation : ' ') + rest;
    else if (atLineStart) out = out.slice(0, -1);
    return out;
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
        if (out.length > 0 && !lineStart) out += '\n' + indent;
        out += comment + '\n' + indent;
        lineStart = true;
      }

      let last: Piece = p;
      if (p.text === '(' && next && BLOCK_OPENERS.has(next.lower)) {
        const close = this.matchingParen(pieces, i);
        const closer = pieces[close]!;
        const balanced = close > i && closer.text === ')';
        const inner = pieces.slice(i + 1, balanced ? close : pieces.length);
        const deeper = indent + this.opts.indent;
        let block = this.headed('(', present([p.trailing]), '', '') + '\n' + this.query(inner, deeper);
        if (balanced) {
          for (const comment of closer.leading) block += '\n' + deeper + comment;
          block += '\n' + indent + ')';
        }
        append(block, this.spaceBefore(p, prev, prevPrev));
        last = balanced ? closer : { ...pieces[pieces.length - 1]!, trailing: undefined };
        i = balanced ? close : pieces.length - 1;
      } else if (p.kind === 'word' && p.lower === 'case' && this.matchingCaseEnd(pieces, i) > i) {
        const end = this.matchingCaseEnd(pieces, i);
        const ender = pieces[end]!;
        const inner = [{ ...p, leading: [] }, ...pieces.slice(i + 1, end), { ...ender, trailing: undefined }];
        const forceBlock = inner.some((q) => q.leading.length > 0 || this.endsLine(q.trailing));
        const flat = forceBlock ? '' : this.flat(inner);
        const text = !forceBlock && flat.length <= CASE_INLINE_LIMIT ? flat : this.caseBlock(inner, indent);
        append(text, this.spaceBefore(p, prev, prevPrev));
        last = ender;
        i = end;
      } else {
        append(this.word(p, next, prev), this.spaceBefore(p, prev, prevPrev));
      }

      if (last.trailing) {
        out += ' ' + last.trailing;
        if (this.endsLine(last.trailing)) {
          out += '\n' + indent;
          lineStart = true;
        }
      }
      prevPrev = prev;
      prev = last;
    }
    // a trailing comment on the last piece must not leave a dangling continuation line
    return out.replace(/\n[ \t]*$/, '').replace(/[ \t]+$/g, '');
  }

  /** Everything on one line, block comments folded in (used for short CASEs without line comments). */
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
        if (TYPE_WORDS.has(prev.lower)) return false;
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
      if (prevPrev.kind === 'punct' && prevPrev.text !== ')' && prevPrev.text !== ']') return false;
      if (prevPrev.kind === 'word' && SQL_KEYWORDS.has(prevPrev.lower)) return false;
    }
    return true;
  }

  /** `INSERT INTO t (a)` keeps the space; `t(a)` would read as a call, which is what a name after FROM or JOIN is. */
  private identTakesSpace(prevPrev: Piece | undefined): boolean {
    if (!prevPrev) return false;
    return prevPrev.kind === 'word' && ['into', 'table', 'references', 'on', 'update', 'exists', 'index', 'view', 'type'].includes(prevPrev.lower);
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
    const subject = this.detachLeading(firstWhen > 0 ? middle.slice(0, firstWhen) : []);
    const branches = this.splitTop(firstWhen >= 0 ? middle.slice(firstWhen) : middle, (p) => p.kind === 'word' && (p.lower === 'when' || p.lower === 'else'), true);
    const lines: string[] = [this.headed(this.word(head), present([head.trailing, ...subject.comments]), this.inline(subject.pieces, deeper), indent)];
    for (const branch of branches) {
      if (branch.length === 0) continue;
      lines.push(deeper + this.inline(branch, deeper));
    }
    for (const comment of end.leading) lines.push(deeper + comment);
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
      const headKey = segment.head.map((h) => h.lower).join(' ');
      let head = segment.head;
      let body = segment.body;
      // SELECT DISTINCT / SELECT ALL travel with the head so the list aligns after them
      const first = body[0];
      if (headKey === 'select' && first?.kind === 'word' && (first.lower === 'distinct' || first.lower === 'all') && body[1]?.lower !== 'on') {
        head = [...head, first];
        body = body.slice(1);
      }
      // own-line comments before the clause go above it
      const owner = head[0] ?? body[0];
      for (const comment of owner?.leading ?? []) lines.push(indent + comment);
      if (head[0]) head = [{ ...head[0], leading: [] }, ...head.slice(1)];
      else body = this.detachLeading(body).pieces;
      const headText = head.map((h, i) => this.word(h, head[i + 1] ?? body[0], head[i - 1])).join(' ');
      const comments = present(head.map((h) => h.trailing));
      if (head.length > 0) {
        const detached = this.detachLeading(body);
        body = detached.pieces;
        comments.push(...detached.comments);
      }
      let text: string;
      if (headKey === '') {
        text = this.inline(body, indent);
      } else if (headKey === 'with') {
        text = this.stack(headText, comments, this.items(body, indent), indent, '');
      } else if (LIST_CLAUSES.has(headKey)) {
        text = this.list(headText, comments, body, indent);
      } else if (CONDITION_CLAUSES.has(headKey)) {
        text = this.conditions(headText, comments, body, indent);
      } else if (headKey.endsWith('join')) {
        text = this.join(headText, comments, body, indent);
      } else if (headKey === 'set' || headKey === 'values') {
        text = this.stack(headText, comments, this.items(body, indent + ' '.repeat(headText.length + 1)), indent);
      } else {
        text = this.headed(headText, comments, this.inline(body, indent, head), indent);
      }
      lines.push(indent + text);
    }
    return lines.join('\n');
  }

  /** Render one comma-list item, holding back the trailing comment of its last piece. */
  private item(pieces: Piece[], indent: string): Item {
    const last = pieces[pieces.length - 1];
    if (!last?.trailing) return { text: this.inline(pieces, indent) };
    return { text: this.inline([...pieces.slice(0, -1), { ...last, trailing: undefined }], indent), trailing: last.trailing };
  }

  private items(body: Piece[], indent: string): Item[] {
    return this.splitTop(body, (p) => p.text === ',').map((item) => this.item(item, indent));
  }

  private itemText(item: Item, last: boolean): string {
    return item.text + (last ? '' : ',') + (item.trailing ? ' ' + item.trailing : '');
  }

  /** Items one per line, continuation lines at `indent + pad` (aligned under the first item by default). */
  private stack(head: string, comments: string[], items: Item[], indent: string, pad = ' '.repeat(head.length + 1)): string {
    const body = items.map((item, i) => (i === 0 ? '' : indent + pad) + this.itemText(item, i === items.length - 1)).join('\n');
    return this.headed(head, comments, body, indent);
  }

  /** A comma list: one line when it fits, else one item per line aligned under the first. */
  private list(head: string, comments: string[], body: Piece[], indent: string): string {
    if (body.length === 0) return this.headed(head, comments, '', indent);
    const pad = ' '.repeat(head.length + 1);
    const items = this.items(body, indent + pad);
    const oneLine = items.map((item, i) => this.itemText(item, i === items.length - 1)).join(' ');
    // a line comment inside the list ends the line, so anything after it must wrap
    const commentInside = items.slice(0, -1).some((item) => this.endsLine(item.trailing));
    const fits = items.length === 1 || (!commentInside && !oneLine.includes('\n') && (indent + head + ' ' + oneLine).length <= this.opts.maxLineLength);
    if (fits) return this.headed(head, comments, oneLine, indent);
    return this.stack(head, comments, items, indent);
  }

  /** WHERE a\n  AND b\n   OR c; the AND of a BETWEEN stays on its line. */
  private conditions(head: string, comments: string[], body: Piece[], indent: string): string {
    if (body.length === 0) return this.headed(head, comments, '', indent);
    let inBetween = false;
    const parts = this.splitTop(
      body,
      (p) => {
        if (p.kind !== 'word') return false;
        if (p.lower === 'between') {
          inBetween = true;
          return false;
        }
        if (p.lower === 'and' && inBetween) {
          inBetween = false;
          return false;
        }
        return p.lower === 'and' || p.lower === 'or';
      },
      true,
    );
    const lines: string[] = [];
    for (const [i, part] of parts.entries()) {
      if (i === 0) {
        const first = this.detachLeading(part);
        lines.push(this.headed(head, [...comments, ...first.comments], this.inline(first.pieces, indent), indent));
        continue;
      }
      if (part.length === 0) continue;
      const connector = part[0]!;
      const rest = this.detachLeading(part.slice(1));
      const kw = this.word(connector);
      const lead = connector.lower === 'or' ? '   ' : '  ';
      for (const comment of connector.leading) lines.push(indent + lead + comment);
      lines.push(this.headed(indent + lead + kw, present([connector.trailing, ...rest.comments]), this.inline(rest.pieces, indent + lead + ' '.repeat(kw.length + 1)), ''));
    }
    return lines.join('\n');
  }

  /** JOIN t alias ON cond [AND cond] */
  private join(head: string, comments: string[], body: Piece[], indent: string): string {
    const onIndex = this.splitIndex(body, (p) => p.kind === 'word' && (p.lower === 'on' || p.lower === 'using'));
    if (onIndex < 0) return this.headed(head, comments, this.inline(body, indent), indent);
    const target = this.item(body.slice(0, onIndex), indent);
    const connector = body[onIndex]!;
    const cond = this.detachLeading(body.slice(onIndex + 1));
    const prefix = `${this.headed(head, comments, target.text, indent)} ${this.word(connector)}`;
    const onComments = present([target.trailing, ...connector.leading, connector.trailing, ...cond.comments]);
    if (connector.lower === 'using') return this.headed(prefix, onComments, this.inline(cond.pieces, indent), indent);
    return this.conditions(prefix, onComments, cond.pieces, indent);
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

  // ------------------------------------------------------------ CREATE TABLE

  /** Index just past `CREATE [TEMP] TABLE [IF NOT EXISTS] schema.name`. */
  private createTableNameEnd(pieces: Piece[]): number {
    let i = pieces.findIndex((p) => p.kind === 'word' && p.lower === 'table') + 1;
    if (pieces[i]?.lower === 'if' && pieces[i + 1]?.lower === 'not' && pieces[i + 2]?.lower === 'exists') i += 3;
    if (pieces[i] && (pieces[i]!.kind === 'word' || pieces[i]!.kind === 'ident')) i++;
    while (pieces[i]?.text === '.' && pieces[i + 1]) i += 2;
    return i;
  }

  private createTable(pieces: Piece[], indent: string): string {
    const open = this.createTableNameEnd(pieces);
    const after = pieces[open];
    if (after?.lower === 'as') {
      return this.inline(pieces.slice(0, open + 1), indent) + '\n' + this.query(pieces.slice(open + 1), indent);
    }
    if (after?.text !== '(') return this.inline(pieces, indent);
    const close = this.matchingParen(pieces, open);
    const closer = pieces[close]!;
    const balanced = close > open && closer.text === ')';
    const head = this.inline(pieces.slice(0, open), indent);
    const defs = this.splitTop(pieces.slice(open + 1, balanced ? close : pieces.length), (p) => p.text === ',');
    const deeper = indent + this.opts.indent;

    const lines: string[] = [head];
    for (const comment of after.leading) lines.push(indent + comment);
    lines.push(this.headed(`${indent}(`, present([after.trailing]), '', ''));

    const columns = defs.map((def) => {
      const last = def[def.length - 1];
      const body = last?.trailing ? [...def.slice(0, -1), { ...last, trailing: undefined }] : def;
      const first = body[0];
      const isColumn = !!first && (first.kind === 'ident' || (first.kind === 'word' && !CONSTRAINT_STARTS.has(first.lower)));
      return { isColumn, first, body, name: isColumn ? this.word(first!, body[1]) : '', trailing: last?.trailing };
    });
    const width = Math.max(0, ...columns.filter((c) => c.isColumn).map((c) => c.name.length));
    columns.forEach((column, i) => {
      for (const comment of column.first?.leading ?? []) lines.push(deeper + comment);
      const suffix = (i < columns.length - 1 ? ',' : '') + (column.trailing ? ' ' + column.trailing : '');
      if (column.isColumn) {
        const rest = this.detachLeading(column.body.slice(1));
        const comments = present([column.first!.trailing, ...rest.comments]);
        const name = rest.pieces.length > 0 || comments.length > 0 ? column.name.padEnd(width) : column.name;
        lines.push(this.headed(deeper + name, comments, this.inline(rest.pieces, deeper), '') + suffix);
      } else {
        lines.push(deeper + this.inline(this.detachLeading(column.body).pieces, deeper) + suffix);
      }
    });
    if (balanced) {
      for (const comment of closer.leading) lines.push(deeper + comment);
      const rest = this.detachLeading(pieces.slice(close + 1));
      lines.push(this.headed(`${indent})`, present([closer.trailing, ...rest.comments]), this.inline(rest.pieces, indent), ''));
    }
    return lines.join('\n');
  }
}
