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
  if (prev.text === '(') return tokens[i - 2]?.kind === 'word' && tokens[i - 2]!.value === 'as';
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
  const tokens = significant(tokenize(sql, dialect));
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
