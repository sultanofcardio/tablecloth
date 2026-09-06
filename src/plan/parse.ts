// Parsers from each dialect's EXPLAIN output into the shared plan model.
// Pure and vscode-free; exercised against captured server output in
// test/fixtures/plans.
import type { CellValue, DriverId } from '../core/types';
import { planNodes, type PlanNode, type QueryPlan } from './model';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function scalar(value: Json): string | undefined {
  if (value === null) return 'NULL';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v !== 'object' || v === null)) return value.map((v) => String(v)).join(', ');
  return undefined;
}

function pushProp(props: [string, string][], name: string, value: Json | undefined): void {
  if (value === undefined) return;
  const text = scalar(value);
  if (text !== undefined) props.push([name, text]);
}

/** `(status = 'shipped'::order_status)` -> `status = 'shipped'`: the planner's outer parens and casts go. */
function tidyCondition(text: string): string {
  let s = text.trim();
  if (s.startsWith('(') && s.endsWith(')') && balanced(s.slice(1, -1))) s = s.slice(1, -1);
  s = s.replace(
    /::(?:character varying|double precision|timestamp(?: with| without) time zone|time(?: with| without) time zone|bit varying|[a-z_][a-z0-9_.]*)(?:\(\d+(?:,\d+)?\))?(?:\[\])?/gi,
    '',
  );
  return s;
}

function balanced(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function join(parts: (string | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.trim() !== '').join(' · ');
}

const formatInt = (n: number): string => Math.round(n).toLocaleString('en-US');

// ------------------------------------------------------------ PostgreSQL

const PG_CONDITIONS: [string, string][] = [
  ['Hash Cond', ''],
  ['Merge Cond', ''],
  ['Index Cond', ''],
  ['Recheck Cond', ''],
  ['Join Filter', 'join filter'],
  ['Filter', 'filter'],
  ['TID Cond', ''],
  ['One-Time Filter', 'one-time filter'],
];

/** Fields folded into the op/detail/figures, so the table view does not repeat them. */
const PG_HANDLED = new Set([
  'Node Type', 'Plans', 'Relation Name', 'Alias', 'Index Name', 'CTE Name', 'Function Name', 'Subplan Name',
  'Startup Cost', 'Total Cost', 'Plan Rows', 'Actual Startup Time', 'Actual Total Time', 'Actual Rows', 'Actual Loops',
  'Sort Key', 'Group Key', 'Rows Removed by Filter', 'Rows Removed by Join Filter', 'Rows Removed by Index Recheck',
  'Parent Relationship', 'Parallel Aware', 'Async Capable', 'Strategy', 'Join Type',
  ...PG_CONDITIONS.map(([key]) => key),
]);

/** The node name the text format prints: an Aggregate reads as HashAggregate or GroupAggregate. */
function pgOpName(node: { [key: string]: Json }): string {
  const type = typeof node['Node Type'] === 'string' ? node['Node Type'] : 'Node';
  const strategy = typeof node['Strategy'] === 'string' ? node['Strategy'] : undefined;
  if (type === 'Aggregate' && strategy) {
    const byStrategy: Record<string, string> = { Hashed: 'HashAggregate', Sorted: 'GroupAggregate', Mixed: 'MixedAggregate', Plain: 'Aggregate' };
    return byStrategy[strategy] ?? type;
  }
  if (type === 'SetOp' && strategy) return `${strategy}SetOp`;
  return type;
}

function pgNode(node: { [key: string]: Json }, analysed: boolean): PlanNode {
  const str = (key: string): string | undefined => {
    const v = node[key];
    return typeof v === 'string' ? v : undefined;
  };
  const relation = [str('Relation Name'), str('Alias')].filter(Boolean).join(' ') || undefined;
  const index = str('Index Name') ? `using ${str('Index Name')}` : undefined;
  const cte = str('CTE Name') ? `cte ${str('CTE Name')}` : undefined;
  const fn = str('Function Name');
  const subplan = str('Subplan Name');
  const conditions = PG_CONDITIONS.map(([key, label]) => {
    const v = str(key);
    if (!v) return undefined;
    const tidy = tidyCondition(v);
    return label ? `${label} ${tidy}` : tidy;
  });
  const sortKey = Array.isArray(node['Sort Key']) ? `sort key ${(node['Sort Key'] as Json[]).map(String).join(', ')}` : undefined;
  const groupKey = Array.isArray(node['Group Key']) ? `group by ${(node['Group Key'] as Json[]).map(String).join(', ')}` : undefined;
  const loops = num(node['Actual Loops']);
  const removed = ['Rows Removed by Filter', 'Rows Removed by Join Filter', 'Rows Removed by Index Recheck']
    .map((key) => num(node[key]))
    .filter((n): n is number => n !== undefined && n > 0);
  const removedText =
    analysed && removed.length > 0 ? `rows removed ${formatInt(removed.reduce((a, b) => a + b, 0) * (loops ?? 1))}` : undefined;
  const op = [pgOpName(node), str('Join Type') && str('Join Type') !== 'Inner' ? str('Join Type') : undefined]
    .filter(Boolean)
    .join(' ');

  const actualRows = num(node['Actual Rows']);
  const totalTime = num(node['Actual Total Time']);
  const props: [string, string][] = [];
  for (const [key, value] of Object.entries(node)) {
    if (PG_HANDLED.has(key)) continue;
    pushProp(props, key, value);
  }
  const children = Array.isArray(node['Plans']) ? (node['Plans'] as Json[]).map((child) => pgNode(child as { [key: string]: Json }, analysed)) : [];
  return {
    op,
    detail: join([relation, index, cte, fn, subplan, ...conditions, sortKey, groupKey, removedText]),
    cost: num(node['Total Cost']),
    startupCost: num(node['Startup Cost']),
    rows: num(node['Plan Rows']),
    actualRows: actualRows !== undefined ? actualRows * (loops ?? 1) : undefined,
    timeMs: totalTime !== undefined ? totalTime * (loops ?? 1) : undefined,
    loops,
    children,
    props,
  };
}

export function parsePostgresPlan(raw: string): QueryPlan {
  const parsed = JSON.parse(raw) as Json;
  const entries = (Array.isArray(parsed) ? parsed : [parsed]) as { [key: string]: Json }[];
  const roots: PlanNode[] = [];
  let executionMs: number | undefined;
  let planningMs: number | undefined;
  const analysed = entries.some((e) => e['Execution Time'] !== undefined || (e['Plan'] as { [key: string]: Json } | undefined)?.['Actual Rows'] !== undefined);
  for (const entry of entries) {
    const plan = entry['Plan'];
    if (plan && typeof plan === 'object' && !Array.isArray(plan)) roots.push(pgNode(plan, analysed));
    const exec = num(entry['Execution Time']);
    const planning = num(entry['Planning Time']);
    if (exec !== undefined) executionMs = (executionMs ?? 0) + exec;
    if (planning !== undefined) planningMs = (planningMs ?? 0) + planning;
  }
  return { dialect: 'postgres', analysed, roots, executionMs, planningMs, raw };
}

// ------------------------------------------------------------ MySQL / MariaDB JSON

/** JSON keys that are operations of their own, and how they read. */
const MYSQL_OPS: Record<string, string> = {
  query_block: 'Query block',
  nested_loop: 'Nested loop',
  ordering_operation: 'Sort',
  grouping_operation: 'Group',
  duplicates_removal: 'Distinct',
  windowing: 'Window',
  materialized_from_subquery: 'Materialize',
  buffer_result: 'Buffer result',
  union_result: 'Union',
  intersect_result: 'Intersect',
  except_result: 'Except',
  filesort: 'Sort',
  temporary_table: 'Temporary table',
  read_sorted_file: 'Read sorted file',
  'block-nl-join': 'Block nested loop',
  subqueries: 'Subqueries',
  optimized_away_subqueries: 'Optimized-away subqueries',
  query_specifications: 'Query specifications',
  having_subqueries: 'HAVING subqueries',
  order_by_subqueries: 'ORDER BY subqueries',
  group_by_subqueries: 'GROUP BY subqueries',
  select_list_subqueries: 'Select list subqueries',
  update_value_subqueries: 'Update value subqueries',
  attached_subqueries: 'Attached subqueries',
  insert_from: 'Insert from',
  table_function: 'Table function',
};

/** Keys whose value is a list of operations, folded into their parent (no node of their own). */
const MYSQL_TRANSPARENT = new Set(['subqueries', 'optimized_away_subqueries', 'query_specifications', 'having_subqueries', 'order_by_subqueries', 'group_by_subqueries', 'select_list_subqueries', 'update_value_subqueries', 'attached_subqueries']);

const MYSQL_ACCESS: Record<string, string> = {
  ALL: 'Table scan',
  index: 'Index scan',
  range: 'Index range scan',
  ref: 'Index lookup',
  ref_or_null: 'Index lookup',
  eq_ref: 'Single-row index lookup',
  const: 'Constant row',
  system: 'System row',
  fulltext: 'Full-text search',
  unique_subquery: 'Unique subquery lookup',
  index_subquery: 'Index subquery lookup',
  index_merge: 'Index merge',
};

const MYSQL_TABLE_HANDLED = new Set([
  'table_name', 'access_type', 'key', 'used_key_parts', 'ref', 'rows_examined_per_scan', 'rows_produced_per_join', 'rows',
  'cost_info', 'cost', 'attached_condition', 'loops', 'r_loops', 'r_rows', 'r_total_time_ms', 'r_table_time_ms', 'r_other_time_ms',
  'materialized_from_subquery', 'attached_subqueries', 'used_columns', 'possible_keys', 'key_length', 'r_engine_stats',
]);

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mysqlTime(node: { [key: string]: Json }): number | undefined {
  const total = num(node['r_total_time_ms']);
  if (total !== undefined) return total;
  const table = num(node['r_table_time_ms']);
  const other = num(node['r_other_time_ms']);
  if (table === undefined && other === undefined) return undefined;
  return (table ?? 0) + (other ?? 0);
}

function mysqlTableNode(table: { [key: string]: Json }): PlanNode {
  const access = typeof table['access_type'] === 'string' ? table['access_type'] : '';
  const key = typeof table['key'] === 'string' ? table['key'] : undefined;
  const ref = Array.isArray(table['ref']) ? (table['ref'] as Json[]).map(String).join(', ') : undefined;
  const condition = typeof table['attached_condition'] === 'string' ? `filter ${tidyCondition(table['attached_condition'].replace(/`/g, ''))}` : undefined;
  const costInfo = isObject(table['cost_info']) ? table['cost_info'] : undefined;
  const loops = num(table['r_loops']) ?? num(table['loops']);
  const rRows = num(table['r_rows']);
  const props: [string, string][] = [];
  for (const [k, v] of Object.entries(table)) {
    if (MYSQL_TABLE_HANDLED.has(k)) continue;
    pushProp(props, k, v);
  }
  if (costInfo) for (const [k, v] of Object.entries(costInfo)) pushProp(props, k, v);
  return {
    op: MYSQL_ACCESS[access] ?? (access ? `${access} access` : 'Table'),
    detail: join([String(table['table_name'] ?? ''), key ? `using ${key}${ref ? ` (${ref})` : ''}` : undefined, condition]),
    cost: num(costInfo?.['prefix_cost']) ?? num(table['cost']),
    rows: num(table['rows_produced_per_join']) ?? num(table['rows']),
    actualRows: rRows !== undefined ? rRows * (loops ?? 1) : undefined,
    timeMs: mysqlTime(table),
    loops,
    children: mysqlChildren(table),
    props,
  };
}

/** The child operations found among an object's keys, in document order. */
function mysqlChildren(obj: { [key: string]: Json }): PlanNode[] {
  const out: PlanNode[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'table' && isObject(value)) {
      out.push(mysqlTableNode(value));
    } else if (key === 'query_block' && isObject(value)) {
      out.push(mysqlOpNode(key, value));
    } else if (MYSQL_TRANSPARENT.has(key) && Array.isArray(value)) {
      for (const item of value) if (isObject(item)) out.push(...mysqlChildren(item));
    } else if (key in MYSQL_OPS && Array.isArray(value)) {
      const items = value.filter(isObject).flatMap((item) => mysqlChildren(item));
      out.push({ op: MYSQL_OPS[key]!, detail: '', children: items, props: [] });
    } else if (key in MYSQL_OPS && isObject(value)) {
      out.push(mysqlOpNode(key, value));
    }
  }
  return out;
}

const MYSQL_OP_HANDLED = new Set(['select_id', 'cost_info', 'cost', 'r_loops', 'r_total_time_ms', 'r_output_rows', 'sort_key', 'message']);

function mysqlOpNode(key: string, obj: { [key: string]: Json }): PlanNode {
  const props: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (MYSQL_OP_HANDLED.has(k) || k === 'table' || k in MYSQL_OPS) continue;
    pushProp(props, k, v);
  }
  const costInfo = isObject(obj['cost_info']) ? obj['cost_info'] : undefined;
  const loops = num(obj['r_loops']);
  const outputRows = num(obj['r_output_rows']);
  const detailParts: (string | undefined)[] = [];
  if (key === 'query_block' && obj['select_id'] !== undefined) detailParts.push(`#${String(obj['select_id'])}`);
  if (typeof obj['sort_key'] === 'string') detailParts.push(`by ${obj['sort_key']}`);
  if (typeof obj['message'] === 'string') detailParts.push(obj['message']);
  return {
    op: MYSQL_OPS[key] ?? key.replace(/_/g, ' '),
    detail: join(detailParts),
    cost: num(costInfo?.['query_cost']) ?? num(obj['cost']),
    actualRows: outputRows !== undefined ? outputRows * (loops ?? 1) : undefined,
    timeMs: mysqlTime(obj),
    loops,
    children: mysqlChildren(obj),
    props,
  };
}

export function parseMySqlPlan(raw: string): QueryPlan {
  const parsed = JSON.parse(raw) as Json;
  if (!isObject(parsed)) throw new Error('Unexpected EXPLAIN output');
  const optimization = isObject(parsed['query_optimization']) ? parsed['query_optimization'] : undefined;
  const roots = mysqlChildren(parsed);
  const planningMs = num(optimization?.['r_total_time_ms']);
  const analysed = planningMs !== undefined || [...planNodes(roots)].some((n) => n.actualRows !== undefined || n.timeMs !== undefined);
  const executionMs = analysed ? roots.map((r) => r.timeMs ?? 0).reduce((a, b) => a + b, 0) : undefined;
  return {
    dialect: 'mysql',
    analysed,
    roots,
    executionMs: executionMs !== undefined && executionMs > 0 ? executionMs : undefined,
    planningMs,
    raw,
  };
}

// ------------------------------------------------------------ MySQL EXPLAIN ANALYZE tree

const TREE_LINE = /^(\s*)->\s*(.*?)\s*$/;
const TREE_FIGURES = /\s*\(((?:cost=|actual time=)[^)]*)\)/g;

/**
 * MySQL 8's `EXPLAIN ANALYZE` prints an indented tree:
 * `-> Filter: (o.status = 'shipped')  (cost=2.95 rows=2.7) (actual time=0.02..0.025 rows=16 loops=1)`.
 */
export function parseMySqlAnalyzeTree(raw: string): QueryPlan {
  const roots: PlanNode[] = [];
  const stack: { indent: number; node: PlanNode }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = TREE_LINE.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    let text = m[2]!;
    const node: PlanNode = { op: '', detail: '', children: [], props: [] };
    text = text.replace(TREE_FIGURES, (_all, body: string) => {
      const fields = Object.fromEntries(
        body
          .replace(/^actual time=/, 'time=')
          .split(/\s+/)
          .map((pair) => pair.split('=') as [string, string]),
      );
      if (fields['cost'] !== undefined) {
        node.cost = num(fields['cost']);
        node.rows = num(fields['rows']);
      } else {
        const loops = num(fields['loops']) ?? 1;
        const time = fields['time']?.split('..');
        const last = num(time?.[time.length - 1]);
        node.loops = loops;
        const rows = num(fields['rows']);
        node.actualRows = rows !== undefined ? rows * loops : undefined;
        node.timeMs = last !== undefined ? last * loops : undefined;
      }
      return '';
    });
    text = text.trim();
    const colon = text.indexOf(': ');
    const on = text.indexOf(' on ');
    if (on > 0 && (colon < 0 || on < colon)) {
      node.op = text.slice(0, on);
      node.detail = text.slice(on + 4);
    } else if (colon > 0) {
      node.op = text.slice(0, colon);
      node.detail = text.slice(colon + 2);
    } else {
      node.op = text;
    }
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1]!.node.children.push(node);
    stack.push({ indent, node });
  }
  const executionMs = roots.map((r) => r.timeMs ?? 0).reduce((a, b) => a + b, 0);
  return { dialect: 'mysql', analysed: true, roots, executionMs: executionMs > 0 ? executionMs : undefined, raw };
}

// ------------------------------------------------------------ SQLite

/** `EXPLAIN QUERY PLAN` rows: id, parent, notused, detail. */
export function parseSqlitePlan(columns: string[], rows: CellValue[][]): QueryPlan {
  const col = (name: string) => columns.findIndex((c) => c.toLowerCase() === name);
  const idIndex = col('id');
  const parentIndex = col('parent');
  const detailIndex = col('detail');
  const byId = new Map<number, PlanNode>();
  const roots: PlanNode[] = [];
  const raw: string[] = [];
  for (const row of rows) {
    const id = num(row[idIndex]) ?? roots.length;
    const parent = num(row[parentIndex]) ?? 0;
    const detail = String(row[detailIndex] ?? '');
    raw.push(detail);
    const m = /^(SCAN|SEARCH|LIST SUBQUERY|SCALAR SUBQUERY|CORRELATED SCALAR SUBQUERY|CO-ROUTINE|MATERIALIZE|COMPOUND QUERY|UNION ALL|UNION|EXCEPT|INTERSECT|MULTI-INDEX OR|RIGHT-JOIN|BLOOM FILTER ON)\s+(.*)$/.exec(detail);
    const node: PlanNode = { op: m ? m[1]! : detail, detail: m ? m[2]! : '', children: [], props: [] };
    byId.set(id, node);
    const parentNode = byId.get(parent);
    if (parentNode && parent !== id) parentNode.children.push(node);
    else roots.push(node);
  }
  return { dialect: 'sqlite', analysed: false, roots, raw: raw.join('\n') };
}

/** Parse whatever a driver returned for an EXPLAIN into the shared model. */
export function parsePlan(dialect: DriverId, shape: 'json' | 'tree' | 'sqlite', columns: string[], rows: CellValue[][]): QueryPlan {
  if (shape === 'sqlite') return parseSqlitePlan(columns, rows);
  const text = rows.map((row) => String(row[0] ?? '')).join('\n');
  if (shape === 'tree') return parseMySqlAnalyzeTree(text);
  return dialect === 'postgres' ? parsePostgresPlan(text) : parseMySqlPlan(text);
}
