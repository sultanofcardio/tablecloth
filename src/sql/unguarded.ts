// DELETE and UPDATE statements with no WHERE clause: the safety net behind
// the "without WHERE" inspection and the pre-execution warning. Pure and
// vscode-free, shared by the console webview and the extension host.
import type { DriverId } from '../core/types';
import { significant, tokenize, type Token } from './tokens';

export interface UnguardedWrite {
  verb: 'DELETE' | 'UPDATE';
  /** Offsets of the statement, from its verb to its last token. */
  start: number;
  end: number;
  /** The target table as written, when the statement names one plainly. */
  table?: { schema?: string; name: string };
}

/** Words allowed between the verb and the table name across the dialects. */
const VERB_MODIFIERS = new Set([
  'from', 'only', 'low_priority', 'quick', 'ignore',
  'or', 'replace', 'rollback', 'abort', 'fail',
]);

/** Words that end the SET clause of an UPDATE at parenthesis depth 0. */
const SET_CLAUSE_ENDS = new Set(['from', 'where', 'limit', 'order', 'returning']);

/** Words that end a statement's relation list. */
const FROM_LIST_ENDS = new Set(['set', 'where', 'order', 'limit', 'group', 'having', 'returning']);

/** The words that join a relation onto the list before them. */
const JOIN_WORDS = new Set(['join', 'straight_join']);

/** Words that open a parenthesized group reading rows of its own. */
const SUBQUERY_STARTS = new Set(['select', 'with', 'values', 'table']);

/** Words that can only be a clause of their own, never a table's alias. */
const NOT_ALIAS = new Set([
  'set', 'where', 'from', 'using', 'returning', 'limit', 'order', 'group', 'having', 'values',
  'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'straight_join', 'on', 'select', 'union', 'as',
]);

/** Words EXPLAIN takes before the statement it explains. */
const EXPLAIN_OPTIONS = new Set([
  'analyze', 'analyse', 'verbose', 'costs', 'settings', 'generic_plan', 'buffers', 'serialize', 'wal',
  'timing', 'summary', 'memory', 'format', 'text', 'xml', 'json', 'yaml', 'true', 'false', 'on', 'off', 'none',
]);

function nameOf(token: Token | undefined): string | undefined {
  if (!token) return undefined;
  if (token.kind === 'ident') return token.value;
  if (token.kind === 'word') return token.text;
  return undefined;
}

/** Whether the token at `j` is the given keyword. */
function isWord(tokens: Token[], j: number, value: string): boolean {
  const t = tokens[j];
  return t?.kind === 'word' && t.value === value;
}

/**
 * Whether the '(' at `open` starts a CTE body: `AS (`, with Postgres's
 * optional `MATERIALIZED` / `NOT MATERIALIZED` hint in between.
 */
function opensCteBody(tokens: Token[], open: number): boolean {
  let j = open - 1;
  if (isWord(tokens, j, 'materialized')) j--;
  if (isWord(tokens, j, 'not')) j--;
  return isWord(tokens, j, 'as');
}

/**
 * Whether the DELETE/UPDATE word at `i` begins a statement that will run:
 * the head of the text, the body of a CTE (`WITH x AS (DELETE …)`), the
 * statement after a WITH prologue, or the target of EXPLAIN ANALYZE, which
 * executes it. Anything else (ON DUPLICATE KEY UPDATE, FOR UPDATE, WHEN
 * MATCHED THEN DELETE, ON DELETE CASCADE, GRANT DELETE …) is a clause.
 */
function isStatementHead(tokens: Token[], i: number, stmtStart: number, depth: number): boolean {
  const prev = tokens[i - 1];
  if (!prev || prev.text === ';') return true;
  if (prev.text === '(') return opensCteBody(tokens, i - 1);
  if (depth !== 0) return false;
  const first = tokens[stmtStart];
  if (first?.kind !== 'word') return false;
  if (first.value === 'with') return prev.text === ')';
  if (first.value === 'explain') {
    const target = explainTarget(tokens, stmtStart);
    if (target === undefined || target > i) return false;
    return target === i || isStatementHead(tokens, i, target, depth);
  }
  return false;
}

/**
 * Where the statement EXPLAIN runs begins, when the options say it runs at
 * all: `EXPLAIN (ANALYZE, BUFFERS) UPDATE …` executes, plain `EXPLAIN UPDATE …`
 * only plans. Undefined when no ANALYZE option is present.
 */
function explainTarget(tokens: Token[], stmtStart: number): number | undefined {
  let analyzed = false;
  let j = stmtStart + 1;
  for (; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.text === '(' || t.text === ')' || t.text === ',') continue;
    if (t.kind !== 'word' || !EXPLAIN_OPTIONS.has(t.value)) break;
    if (t.value === 'analyze' || t.value === 'analyse') analyzed = true;
  }
  return analyzed ? j : undefined;
}

interface WriteTarget {
  /** The target table as written, when the statement names one plainly. */
  table?: { schema?: string; name: string };
  /** The names that target answers to in the statement: its table name and its alias. */
  names: Set<string>;
  /** The alias it was given, lowercased. */
  alias?: string;
  /** Where this occurrence of the relation starts, which tells two instances of one table apart. */
  at?: number;
}

const NO_TARGET: WriteTarget = { names: new Set() };

/** Read `[schema.]table [[AS] alias]` at `j`. */
function tableAt(tokens: Token[], j: number): WriteTarget {
  const first = tokens[j];
  const name = nameOf(first);
  if (!name || (first!.kind === 'word' && first!.value === 'set')) return NO_TARGET;
  let table: { schema?: string; name: string } = { name };
  let k = j + 1;
  if (tokens[j + 1]?.text === '.') {
    const second = nameOf(tokens[j + 2]);
    if (!second) return NO_TARGET;
    table = { schema: name, name: second };
    k = j + 3;
  }
  const names = new Set([table.name.toLowerCase()]);
  if (isWord(tokens, k, 'as')) k++;
  const aliasToken = tokens[k];
  const written = nameOf(aliasToken);
  const alias = written && !(aliasToken!.kind === 'word' && NOT_ALIAS.has(aliasToken!.value)) ? written.toLowerCase() : undefined;
  if (alias) names.add(alias);
  return { table, names, alias, at: j };
}

/** Every relation the statement names between `start` and `stop`, in order. */
function relationOccurrences(tokens: Token[], start: number, stop: number): WriteTarget[] {
  const out: WriteTarget[] = [];
  let depth = 0;
  let inList = false;
  for (let j = start; j < stop; j++) {
    const t = tokens[j]!;
    if (t.text === '(') {
      depth++;
      continue;
    }
    if (t.text === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (t.text === ',') {
      if (inList) {
        const relation = tableAt(tokens, j + 1);
        if (relation.table) out.push(relation);
      }
      continue;
    }
    if (t.kind !== 'word') continue;
    if (t.value === 'from' || t.value === 'using' || JOIN_WORDS.has(t.value)) {
      const relation = tableAt(tokens, j + 1);
      if (relation.table) out.push(relation);
      inList = true;
    } else if (t.value === 'set' || FROM_LIST_ENDS.has(t.value)) {
      inList = false;
    }
  }
  return out;
}

/** The relations of a FROM/USING list at `start`, comma- and JOIN-separated. */
function relationsIn(tokens: Token[], start: number): WriteTarget[] {
  const out: WriteTarget[] = [];
  let depth = 0;
  let expect = true;
  for (let j = start; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.text === '(') {
      depth++;
      continue;
    }
    if (t.text === ')') {
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    if (t.text === ';') break;
    if (expect) {
      const relation = tableAt(tokens, j);
      if (relation.table) out.push(relation);
      expect = false;
      continue;
    }
    if (t.text === ',' || (t.kind === 'word' && JOIN_WORDS.has(t.value))) {
      expect = true;
      continue;
    }
    if (t.kind === 'word' && FROM_LIST_ENDS.has(t.value)) break;
  }
  return out;
}

/** Whether the relation list at `start` names more than one relation. */
function listsMoreThanOne(tokens: Token[], start: number): boolean {
  let depth = 0;
  for (let j = start; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.text === '(') depth++;
    else if (t.text === ')') {
      if (depth === 0) return false;
      depth--;
    } else if (depth !== 0) continue;
    else if (t.text === ';') return false;
    else if (t.text === ',') return true;
    else if (t.kind === 'word' && (FROM_LIST_ENDS.has(t.value) || t.value === 'using' || JOIN_WORDS.has(t.value))) return false;
  }
  return false;
}

/**
 * A statement that writes several of the relations it lists, or one this
 * detector cannot pin down: the dialog names no table, but the list still has a
 * head, so a JOIN onto it can be seen to restrict what is written.
 */
function unnamedTarget(relations: WriteTarget[]): WriteTarget {
  const head = relations[0];
  return head ? { names: new Set(), at: head.at } : NO_TARGET;
}

/**
 * MySQL's `DELETE alias[, alias] FROM tables …`: the word after the verb is a
 * target, not a table, and it is the FROM list that says which table it stands
 * for. One target that resolves there names its table; anything else names no
 * table rather than naming an alias.
 */
function multiTableDelete(tokens: Token[], start: number): WriteTarget {
  const target = nameOf(tokens[start])?.toLowerCase();
  let depth = 0;
  let from = -1;
  let several = false;
  for (let j = start; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.text === '(') depth++;
    else if (t.text === ')') depth = Math.max(0, depth - 1);
    else if (depth !== 0) continue;
    else if (t.text === ';') break;
    else if (t.text === ',') several = true;
    else if (t.kind === 'word' && t.value === 'from') {
      from = j;
      break;
    }
  }
  if (from < 0) return NO_TARGET;
  const relations = relationsIn(tokens, from + 1);
  if (several || !target) return unnamedTarget(relations);
  return relations.find((relation) => relation.names.has(target)) ?? unnamedTarget(relations);
}

/**
 * MySQL's multi-table UPDATE writes to whichever relation its SET clause
 * qualifies, not to the first one listed. One qualifier shared by every
 * assignment names the target; mixed or unqualified assignments name none.
 */
function qualifiedUpdateTarget(relations: WriteTarget[], setTokens: Token[]): WriteTarget {
  const assignments = splitAssignments(setTokens).filter((a) => a.length > 0);
  if (assignments.length === 0) return unnamedTarget(relations);
  const qualifiers = new Set<string>();
  for (const assignment of assignments) {
    const eq = assignment.findIndex((t) => t.text === '=');
    if (eq <= 0 || assignment[eq - 2]?.text !== '.') return unnamedTarget(relations);
    const qualifier = nameOf(assignment[eq - 3]);
    if (!qualifier) return unnamedTarget(relations);
    qualifiers.add(qualifier.toLowerCase());
  }
  if (qualifiers.size !== 1) return unnamedTarget(relations);
  const [only] = [...qualifiers];
  return relations.find((relation) => relation.names.has(only!)) ?? unnamedTarget(relations);
}

/** Where a DELETE's USING list starts, when it has one: the joins live there, not in the target list. */
function usingList(tokens: Token[], start: number): number | undefined {
  let depth = 0;
  for (let j = start; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.text === '(') depth++;
    else if (t.text === ')') {
      if (depth === 0) return undefined;
      depth--;
    } else if (depth !== 0) continue;
    else if (t.text === ';') return undefined;
    else if (t.kind === 'word' && t.value === 'using') return j + 1;
    else if (t.kind === 'word' && FROM_LIST_ENDS.has(t.value)) return undefined;
  }
  return undefined;
}

/** Where the statement's relation list starts: past LOW_PRIORITY, IGNORE, FROM and the other modifiers. */
function afterVerbModifiers(tokens: Token[], i: number): number {
  let j = i + 1;
  while (tokens[j]?.kind === 'word' && VERB_MODIFIERS.has(tokens[j]!.value)) j++;
  return j;
}

/** The table the statement writes to, and the names it answers to. */
function parseTarget(tokens: Token[], i: number, setTokens: Token[]): WriteTarget {
  const j = afterVerbModifiers(tokens, i);
  const sawFrom = tokens.slice(i + 1, j).some((t) => t.value === 'from');
  if (tokens[i]!.value === 'delete') {
    // `DELETE alias FROM …` names its target first; `DELETE FROM t1, t2 USING …` deletes from every table listed
    if (!sawFrom) return multiTableDelete(tokens, j);
    if (listsMoreThanOne(tokens, j)) return unnamedTarget(relationsIn(tokens, usingList(tokens, j) ?? j));
  } else {
    const relations = relationsIn(tokens, j);
    if (relations.length > 1) return qualifiedUpdateTarget(relations, setTokens);
  }
  return tableAt(tokens, j);
}

/**
 * The relations an ON/USING condition qualifies a column with, up to the next
 * join or clause. Only qualifiers count: a column that happens to be spelled
 * like a table (`c.orders`) says nothing about which rows the join keeps.
 */
function conditionQualifiers(tokens: Token[], start: number, stop: number): Set<string> {
  const names = new Set<string>();
  let depth = 0;
  for (let j = start; j < stop; j++) {
    const t = tokens[j]!;
    if (t.text === '(') {
      depth++;
      continue;
    }
    if (t.text === ')') {
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (depth === 0 && t.kind === 'word' && (JOIN_WORDS.has(t.value) || t.value === 'set' || t.value === 'where' || FROM_LIST_ENDS.has(t.value))) {
      break;
    }
    if (tokens[j + 1]?.text !== '.') continue;
    const name = nameOf(t);
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

/**
 * Whether any JOIN with an ON/USING condition restricts the write target, the
 * exemption IntelliJ makes. The join has to involve the target itself: it joins
 * onto the relation list that very occurrence heads, or its condition qualifies
 * a column with the name that occurrence answers to. A second instance of the
 * same table (`FROM orders o2`) is another row source, and a join between two
 * other tables
 * (`UPDATE orders SET … FROM customers c JOIN regions r ON r.id = c.region_id`)
 * still leaves every row of the target in play.
 */
function joinConstrainsTarget(tokens: Token[], start: number, stop: number, target: WriteTarget): boolean {
  const isTarget = (relation: WriteTarget) => target.at !== undefined && relation.at === target.at;
  const others = relationOccurrences(tokens, start, stop).filter((relation) => !isTarget(relation));
  const bare = target.table?.name.toLowerCase();
  // the target answers to its alias; to its bare name only when nothing else in the statement does
  const referred = new Set<string>();
  if (target.alias) referred.add(target.alias);
  else if (bare && !others.some((relation) => relation.names.has(bare))) referred.add(bare);
  const hits = (names: Set<string>) => [...names].some((name) => referred.has(name));
  let depth = 0;
  let chainIsTarget = isTarget(tableAt(tokens, start));
  let pendingJoin = -1;
  let constrained = false;
  for (let j = start; j < stop; j++) {
    const t = tokens[j]!;
    if (t.text === '(') {
      depth++;
      continue;
    }
    if (t.text === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (t.text === ',') {
      chainIsTarget = isTarget(tableAt(tokens, j + 1));
      pendingJoin = -1;
      continue;
    }
    if (t.kind !== 'word') continue;
    if (JOIN_WORDS.has(t.value)) {
      pendingJoin = j;
    } else if (pendingJoin >= 0 && (t.value === 'on' || t.value === 'using')) {
      // the condition holds both sides of the join, so either one being the target is enough
      constrained ||= chainIsTarget || isTarget(tableAt(tokens, pendingJoin + 1)) || hits(conditionQualifiers(tokens, j + 1, stop));
      pendingJoin = -1;
    } else if (t.value === 'from' || t.value === 'using') {
      chainIsTarget = isTarget(tableAt(tokens, j + 1));
      pendingJoin = -1;
    }
  }
  return constrained;
}

/** The SET clause split into its assignments, on the commas that separate them. */
function splitAssignments(setTokens: Token[]): Token[][] {
  const assignments: Token[][] = [[]];
  let depth = 0;
  for (const t of setTokens) {
    if (t.text === '(' || t.text === '[') depth++;
    else if (t.text === ')' || t.text === ']') depth = Math.max(0, depth - 1);
    if (t.text === ',' && depth === 0) {
      assignments.push([]);
      continue;
    }
    assignments[assignments.length - 1]!.push(t);
  }
  return assignments;
}

/**
 * Which tokens of an assignment's right-hand side read the target's own row.
 * Grouping parentheses, function arguments and casts do; a subquery reads
 * another table, so `SET total = (SELECT total FROM defaults)` reads nothing
 * of the target's.
 */
function readsOwnRow(read: Token[]): boolean[] {
  const own = new Array<boolean>(read.length).fill(false);
  const groups: boolean[] = [];
  for (let k = 0; k < read.length; k++) {
    const t = read[k]!;
    if (t.text === '(') {
      const opens = read[k + 1];
      const subquery = opens?.kind === 'word' && SUBQUERY_STARTS.has(opens.value);
      groups.push(!subquery && (groups[groups.length - 1] ?? true));
      continue;
    }
    if (t.text === ')') {
      groups.pop();
      continue;
    }
    own[k] = groups[groups.length - 1] ?? true;
  }
  return own;
}

/**
 * Whether every assignment in an UPDATE's SET clause reads the column it
 * writes (`SET counter = counter + 1`): a deliberate whole-table change,
 * which IntelliJ leaves alone. It has to be the target's own column, so
 * `SET status = c.status FROM customers c` is still a whole-table rewrite.
 */
function selfReferencing(setTokens: Token[], targetNames: Set<string>): boolean {
  const assignments = splitAssignments(setTokens);
  if (assignments.every((a) => a.length === 0)) return false;
  return assignments.every((assignment) => {
    const eq = assignment.findIndex((t) => t.text === '=');
    if (eq <= 0) return false;
    const column = nameOf(assignment[eq - 1])?.toLowerCase();
    if (!column) return false;
    const read = assignment.slice(eq + 1);
    const own = readsOwnRow(read);
    return read.some((t, k) => {
      if (!own[k] || nameOf(t)?.toLowerCase() !== column) return false;
      if (read[k - 1]?.text !== '.') return true;
      const qualifier = nameOf(read[k - 2])?.toLowerCase();
      return !!qualifier && targetNames.has(qualifier);
    });
  });
}

function analyze(tokens: Token[], i: number): UnguardedWrite | undefined {
  const verb = tokens[i]!;
  let depth = 0;
  let guarded = false;
  let limited = false;
  let setStart = -1;
  let setEnd = -1;
  let end = verb.end;
  let stop = tokens.length;
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.text === '(') {
      depth++;
    } else if (t.text === ')') {
      if (depth === 0) {
        stop = j; // the CTE body closed
        break;
      }
      depth--;
    } else if (t.text === ';' && depth === 0) {
      stop = j;
      break;
    } else if (depth === 0 && t.kind === 'word') {
      if (t.value === 'where') guarded = true;
      else if (t.value === 'limit') limited = true;
      else if (t.value === 'set' && setStart < 0) setStart = j + 1;
      else if (setStart >= 0 && setEnd < 0 && SET_CLAUSE_ENDS.has(t.value)) setEnd = j;
    }
    end = t.end;
  }
  if (guarded || limited) return undefined;
  const setClause = setStart < 0 ? [] : tokens.slice(setStart, setEnd < 0 ? stop : setEnd);
  const target = parseTarget(tokens, i, setClause);
  if (joinConstrainsTarget(tokens, afterVerbModifiers(tokens, i), stop, target)) return undefined;
  if (verb.value === 'update') {
    if (setStart < 0) return undefined; // not a complete statement yet
    if (selfReferencing(setClause, target.names)) return undefined;
  }
  return {
    verb: verb.value === 'delete' ? 'DELETE' : 'UPDATE',
    start: verb.start,
    end,
    table: target.table,
  };
}

/**
 * The DELETE and UPDATE statements in `sql` that carry no WHERE clause and
 * would touch every row. Like IntelliJ, a LIMIT, a JOIN with a condition, and
 * an UPDATE whose every assignment reads its own column are left alone.
 */
export function findUnguardedWrites(sql: string, dialect: DriverId): UnguardedWrite[] {
  return unguardedWritesIn(significant(tokenize(sql, dialect)));
}

/** The same detector for a caller that already tokenized the statement. */
export function unguardedWritesIn(tokens: Token[]): UnguardedWrite[] {
  const out: UnguardedWrite[] = [];
  let depth = 0;
  let stmtStart = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.text === '(') {
      depth++;
      continue;
    }
    if (t.text === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (t.text === ';' && depth === 0) {
      stmtStart = i + 1;
      continue;
    }
    if (t.kind !== 'word' || (t.value !== 'delete' && t.value !== 'update')) continue;
    if (!isStatementHead(tokens, i, stmtStart, depth)) continue;
    const write = analyze(tokens, i);
    if (write) out.push(write);
  }
  return out;
}

/** Server-side bound on the row count shown in the warning, in milliseconds. */
export const COUNT_TIMEOUT_MS = 3000;

const COUNT_SAVEPOINT = 'tablecloth_count';

export interface CountPlanOptions {
  /** Whether a transaction is already open on the session the count will run on. */
  inTransaction: boolean;
  /** MariaDB ignores MySQL's MAX_EXECUTION_TIME hint and needs a SET STATEMENT prefix. */
  mariadb?: boolean;
  /** The session's own statement_timeout, as read by `countProbe`, to put back afterwards. */
  statementTimeout?: string;
}

/**
 * The setting the bounded count has to read before it overwrites it, when the
 * plan will change the session rather than a transaction. Undefined when the
 * count leaves the session alone.
 */
export function countProbe(dialect: DriverId, inTransaction: boolean): string | undefined {
  return dialect === 'postgres' && !inTransaction ? 'SHOW statement_timeout' : undefined;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * How to count the rows a DELETE or UPDATE without WHERE would touch, on the
 * session the statement will run on, without disturbing it. The count is
 * bounded so a safety prompt cannot stall the console: Postgres gets a
 * statement timeout, MySQL the optimizer hint, MariaDB (which ignores that
 * hint) a SET STATEMENT prefix, SQLite nothing (it counts in process). While a
 * transaction is open the count runs under a savepoint that is rolled back
 * afterwards, so it sees the transaction's uncommitted rows and leaves neither
 * the timeout setting nor an aborted transaction behind. Outside one, Postgres
 * restores the session's own statement_timeout, which the user may have set.
 * `after` runs whether the count succeeded or not, best effort.
 */
export function countPlan(
  dialect: DriverId,
  qualifiedTable: string,
  options: CountPlanOptions,
): { before: string[]; count: string; after: string[] } {
  let count = `SELECT count(*) FROM ${qualifiedTable}`;
  if (dialect === 'mysql') {
    count = options.mariadb
      ? `SET STATEMENT max_statement_time=${COUNT_TIMEOUT_MS / 1000} FOR ${count}`
      : `SELECT /*+ MAX_EXECUTION_TIME(${COUNT_TIMEOUT_MS}) */ count(*) FROM ${qualifiedTable}`;
  }
  if (options.inTransaction) {
    const before = [`SAVEPOINT ${COUNT_SAVEPOINT}`];
    if (dialect === 'postgres') before.push(`SET LOCAL statement_timeout = ${COUNT_TIMEOUT_MS}`);
    return {
      before,
      count,
      after: [`ROLLBACK TO SAVEPOINT ${COUNT_SAVEPOINT}`, `RELEASE SAVEPOINT ${COUNT_SAVEPOINT}`],
    };
  }
  if (dialect === 'postgres') {
    const restore = options.statementTimeout ? quoteLiteral(options.statementTimeout) : 'DEFAULT';
    return { before: [`SET statement_timeout = ${COUNT_TIMEOUT_MS}`], count, after: [`SET statement_timeout = ${restore}`] };
  }
  return { before: [], count, after: [] };
}
