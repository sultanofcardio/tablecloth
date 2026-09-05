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
    return tokens.slice(stmtStart + 1, i).some((t) => t.kind === 'word' && (t.value === 'analyze' || t.value === 'analyse'));
  }
  return false;
}

/** The plainly written target table right after the verb, if any. */
function targetTable(tokens: Token[], i: number): UnguardedWrite['table'] {
  let j = i + 1;
  while (tokens[j]?.kind === 'word' && VERB_MODIFIERS.has(tokens[j]!.value)) j++;
  const first = tokens[j];
  const name = nameOf(first);
  if (!name || (first!.kind === 'word' && first!.value === 'set')) return undefined;
  if (tokens[j + 1]?.text === '.') {
    const second = nameOf(tokens[j + 2]);
    return second ? { schema: name, name: second } : undefined;
  }
  return { name };
}

/**
 * Whether every assignment in an UPDATE's SET clause reads the column it
 * writes (`SET counter = counter + 1`): a deliberate whole-table change,
 * which IntelliJ leaves alone.
 */
function selfReferencing(setTokens: Token[]): boolean {
  const assignments: Token[][] = [[]];
  let depth = 0;
  for (const t of setTokens) {
    if (t.text === '(') depth++;
    else if (t.text === ')') depth = Math.max(0, depth - 1);
    if (t.text === ',' && depth === 0) {
      assignments.push([]);
      continue;
    }
    assignments[assignments.length - 1]!.push(t);
  }
  if (assignments.every((a) => a.length === 0)) return false;
  return assignments.every((assignment) => {
    const eq = assignment.findIndex((t) => t.text === '=');
    if (eq <= 0) return false;
    const column = nameOf(assignment[eq - 1])?.toLowerCase();
    if (!column) return false;
    return assignment.slice(eq + 1).some((t) => nameOf(t)?.toLowerCase() === column);
  });
}

function analyze(tokens: Token[], i: number): UnguardedWrite | undefined {
  const verb = tokens[i]!;
  let depth = 0;
  let guarded = false;
  let limited = false;
  let joined = false;
  let lastJoinConditioned = false;
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
      else if (t.value === 'join') {
        joined = true;
        lastJoinConditioned = false;
      } else if ((t.value === 'on' || t.value === 'using') && joined) lastJoinConditioned = true;
      else if (t.value === 'set' && setStart < 0) setStart = j + 1;
      else if (setStart >= 0 && setEnd < 0 && SET_CLAUSE_ENDS.has(t.value)) setEnd = j;
    }
    end = t.end;
  }
  if (guarded || limited || (joined && lastJoinConditioned)) return undefined;
  if (verb.value === 'update') {
    if (setStart < 0) return undefined; // not a complete statement yet
    if (selfReferencing(tokens.slice(setStart, setEnd < 0 ? stop : setEnd))) return undefined;
  }
  return {
    verb: verb.value === 'delete' ? 'DELETE' : 'UPDATE',
    start: verb.start,
    end,
    table: targetTable(tokens, i),
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
