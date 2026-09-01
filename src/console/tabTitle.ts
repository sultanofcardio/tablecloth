import { parseTableRefs } from '../complete/refs';
import type { ConsoleBinding } from '../core/types';
import { truncate } from '../core/util';

/**
 * IntelliJ's result-tab naming:
 *  - a comment directly above the statement names the tab,
 *  - else a single-table SELECT is named db.schema.table,
 *  - else "Result n".
 */
export function resultTabTitle(sql: string, binding: ConsoleBinding | undefined, nextNumber: () => number): string {
  const lineComment = /^\s*--\s?(.+)/.exec(sql);
  if (lineComment?.[1]?.trim()) return truncate(lineComment[1].trim(), 40);
  const blockComment = /^\s*\/\*+\s*([^\n]*?)\s*(?:\*+\/)?\s*$/m.exec(sql.split('\n')[0] ?? '');
  if (sql.trimStart().startsWith('/*') && blockComment?.[1]?.trim()) {
    return truncate(blockComment[1].trim(), 40);
  }

  const refs = parseTableRefs(sql);
  if (refs.length === 1) {
    const ref = refs[0]!;
    const parts = [binding?.database, ref.schema ?? binding?.schema, ref.table].filter(Boolean) as string[];
    return truncate(parts.join('.'), 60);
  }
  return `Result ${nextNumber()}`;
}
