// Statement parameters the IntelliJ way: `:name` and `${name}` everywhere,
// `?` in MySQL and SQLite, `$1` in PostgreSQL. Values are prompted for and
// bound through the driver, never spliced into the text.
import type { DriverId } from '../core/types';
import { tokenize } from './tokens';

export interface ParameterRef {
  /** Display name: the bare name, or "?1", "?2" for positional marks. */
  name: string;
  start: number;
  end: number;
}

export function findParameters(sql: string, dialect: DriverId): ParameterRef[] {
  const refs: ParameterRef[] = [];
  let positional = 0;
  for (const token of tokenize(sql, dialect)) {
    if (token.kind !== 'param') continue;
    const name = token.value === '?' ? `?${++positional}` : token.value;
    refs.push({ name, start: token.start, end: token.end });
  }
  return refs;
}

/** Distinct parameter names in order of first appearance. */
export function parameterNames(refs: ParameterRef[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const ref of refs) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    names.push(ref.name);
  }
  return names;
}

export interface BoundStatement {
  text: string;
  values: unknown[];
}

/**
 * Rewrite the statement with driver placeholders and line the values up:
 * PostgreSQL gets `$n` per distinct name (a name used twice binds once),
 * MySQL and SQLite get one `?` per occurrence.
 */
export function bindParameters(
  sql: string,
  dialect: DriverId,
  refs: ParameterRef[],
  values: Record<string, string | null>,
): BoundStatement {
  if (refs.length === 0) return { text: sql, values: [] };
  const names = parameterNames(refs);
  let text = '';
  let last = 0;
  const bound: unknown[] = [];
  if (dialect === 'postgres') {
    for (const ref of refs) {
      text += sql.slice(last, ref.start) + `$${names.indexOf(ref.name) + 1}`;
      last = ref.end;
    }
    for (const name of names) bound.push(values[name] ?? null);
  } else {
    for (const ref of refs) {
      text += sql.slice(last, ref.start) + '?';
      last = ref.end;
      bound.push(values[ref.name] ?? null);
    }
  }
  text += sql.slice(last);
  return { text, values: bound };
}
