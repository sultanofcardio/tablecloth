// How each dialect is asked for a plan, and which result cell carries it.
// Pure and vscode-free.
import type { DriverId } from '../core/types';
import { stripTrailingTerminators } from '../sql/tokens';

export type ExplainMode = 'plan' | 'analyse';

export interface ExplainRequest {
  /** The statement to run; the plan comes back as rows. */
  sql: string;
  /**
   * What the rows hold: one cell with a JSON document, one cell with MySQL's
   * indented tree text, or SQLite's (id, parent, notused, detail) rows.
   */
  shape: 'json' | 'tree' | 'sqlite';
  /** The statement is executed to get the figures, so DML must be rolled back. */
  executes: boolean;
}

/**
 * The EXPLAIN form for a statement. MariaDB has no EXPLAIN ANALYZE; its
 * ANALYZE statement returns the same JSON with r_* runtime fields. SQLite has
 * no analyse at all, so `analyse` there is the plan.
 */
export function explainRequest(dialect: DriverId, sql: string, mode: ExplainMode, mariadb = false): ExplainRequest {
  const body = stripTrailingTerminators(sql, dialect).trim();
  switch (dialect) {
    case 'postgres':
      return mode === 'analyse'
        ? { sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${body}`, shape: 'json', executes: true }
        : { sql: `EXPLAIN (FORMAT JSON) ${body}`, shape: 'json', executes: false };
    case 'mysql':
      if (mode === 'analyse') {
        return mariadb
          ? { sql: `ANALYZE FORMAT=JSON ${body}`, shape: 'json', executes: true }
          : { sql: `EXPLAIN ANALYZE ${body}`, shape: 'tree', executes: true };
      }
      return { sql: `EXPLAIN FORMAT=JSON ${body}`, shape: 'json', executes: false };
    case 'sqlite':
      return { sql: `EXPLAIN QUERY PLAN ${body}`, shape: 'sqlite', executes: false };
  }
}

/** Whether the dialect can report runtime figures at all. */
export function supportsAnalyse(dialect: DriverId): boolean {
  return dialect !== 'sqlite';
}
