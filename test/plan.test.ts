import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { explainRequest, supportsAnalyse } from '../src/plan/explain';
import { planNodes, planSize, type PlanNode } from '../src/plan/model';
import { parseMySqlAnalyzeTree, parseMySqlPlan, parsePlan, parsePostgresPlan, parseSqlitePlan } from '../src/plan/parse';

const fixture = (name: string) => readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'plans', name), 'utf8');

/** The tree as "op | detail" lines, indented by depth, for readable assertions. */
function outline(nodes: PlanNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.op}${n.detail ? ` | ${n.detail}` : ''}`, ...outline(n.children, depth + 1)]);
}

test('PostgreSQL EXPLAIN JSON becomes a tree with costs and row estimates', () => {
  const plan = parsePostgresPlan(fixture('postgres-plan.json'));
  assert.equal(plan.dialect, 'postgres');
  assert.equal(plan.analysed, false);
  assert.equal(plan.executionMs, undefined);
  assert.deepEqual(outline(plan.roots), [
    'Limit',
    '  Sort | sort key (count(*)) DESC',
    '    HashAggregate | group by c.email',
    '      Hash Join | o.customer_id = c.id',
    '        Seq Scan | orders o',
    '        Hash',
    '          Seq Scan | customers c',
  ]);
  const root = plan.roots[0]!;
  assert.equal(typeof root.cost, 'number');
  assert.equal(typeof root.startupCost, 'number');
  assert.equal(root.rows, 5);
  assert.equal(root.actualRows, undefined);
  const scan = [...planNodes(plan.roots)].find((n) => n.detail === 'orders o')!;
  assert.ok(scan.rows! > 100, 'the orders scan estimates its rows');
  assert.ok(scan.props.some(([k]) => k === 'Plan Width'), 'unhandled fields land in props');
  assert.ok(!scan.props.some(([k]) => k === 'Total Cost'), 'figures folded into the node do not repeat in props');
  assert.equal(planSize(plan), 7);
});

test('PostgreSQL EXPLAIN ANALYZE adds actual rows, time, loops, and rows removed by filters', () => {
  const plan = parsePostgresPlan(fixture('postgres-analyze.json'));
  assert.equal(plan.analysed, true);
  assert.ok(plan.executionMs! > 0 && plan.planningMs! > 0);
  const [root] = plan.roots;
  assert.equal(root!.op, 'Hash Join');
  assert.equal(root!.detail, 'o.customer_id = c.id');
  assert.equal(root!.actualRows, 400);
  assert.equal(root!.loops, 1);
  assert.ok(root!.timeMs! > 0 && root!.timeMs! < plan.executionMs!, 'the root node is faster than the whole statement');
  const heap = root!.children[0]!;
  assert.equal(heap.op, 'Bitmap Heap Scan');
  assert.match(heap.detail, /^orders o · status = 'shipped'/, 'the cast and outer parens are tidied away');
  const inner = [...planNodes(plan.roots)].find((n) => (n.loops ?? 1) > 1 || n.op === 'Hash')!;
  assert.ok(inner, 'a hash side exists');
  // a looped node reports its totals, not its per-loop average
  const looped = [...planNodes(plan.roots)].find((n) => (n.loops ?? 1) > 1);
  if (looped) assert.ok(looped.actualRows! >= looped.loops!);
});

test('a filter that removed rows says so in the detail once analysed', () => {
  const plan = parsePostgresPlan(
    JSON.stringify([
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          Alias: 'o',
          Filter: "((status)::text = 'shipped'::text)",
          'Rows Removed by Filter': 1588,
          'Total Cost': 48,
          'Plan Rows': 812,
          'Actual Rows': 812,
          'Actual Loops': 1,
          'Actual Total Time': 3.2,
        },
        'Execution Time': 4.1,
        'Planning Time': 0.3,
      },
    ]),
  );
  assert.deepEqual(outline(plan.roots), ["Seq Scan | orders o · filter (status) = 'shipped' · rows removed 1,588"]);
  assert.equal(plan.executionMs, 4.1);
});

test('MySQL EXPLAIN FORMAT=JSON becomes a tree of operations and table accesses', () => {
  const plan = parseMySqlPlan(fixture('mysql-plan.json'));
  assert.equal(plan.dialect, 'mysql');
  assert.equal(plan.analysed, false);
  assert.deepEqual(outline(plan.roots), [
    'Query block | #1',
    '  Sort',
    '    Group',
    '      Nested loop',
    "        Table scan | o · filter acme.o.status = 'shipped'",
    '        Single-row index lookup | c · using PRIMARY (acme.o.customer_id)',
  ]);
  const block = plan.roots[0]!;
  assert.equal(block.cost, 3.89);
  const scan = [...planNodes(plan.roots)].find((n) => n.op === 'Table scan')!;
  assert.equal(scan.rows, 2, 'rows produced per join');
  assert.equal(scan.cost, 2.95, 'prefix cost');
  assert.ok(scan.props.some(([k, v]) => k === 'filtered' && v === '10.00'));
});

test('MySQL unions and subqueries keep their query blocks', () => {
  const plan = parseMySqlPlan(fixture('mysql-union.json'));
  const lines = outline(plan.roots);
  assert.ok(lines[0]!.startsWith('Query block'));
  assert.ok(lines.some((l) => l.trim() === 'Union'), 'the union result is an operation of its own');
  assert.ok(lines.filter((l) => l.trim().startsWith('Query block')).length >= 3, 'each side of the union is a query block');
  assert.ok(lines.some((l) => /Table scan|Index|lookup/.test(l)), 'the table accesses are found under the blocks');
});

test('MySQL EXPLAIN ANALYZE text is a tree with estimates and actuals per line', () => {
  const plan = parseMySqlAnalyzeTree(fixture('mysql-analyze.txt'));
  assert.equal(plan.analysed, true);
  assert.deepEqual(outline(plan.roots), [
    'Limit | 5 row(s)',
    '  Sort | `count(*)` DESC, limit input to 5 row(s) per chunk',
    '    Table scan | <temporary>',
    '      Aggregate using temporary table',
    '        Nested loop inner join',
    "          Filter | (o.`status` = 'shipped')",
    '            Table scan | o',
    '          Single-row index lookup | c using PRIMARY (id=o.customer_id)',
  ]);
  const loop = [...planNodes(plan.roots)].find((n) => n.op === 'Nested loop inner join')!;
  assert.equal(loop.cost, 3.9);
  assert.equal(loop.rows, 2.7);
  assert.equal(loop.actualRows, 16);
  assert.equal(loop.loops, 1);
  assert.ok(Math.abs(loop.timeMs! - 0.0386) < 1e-9);
  const lookup = [...planNodes(plan.roots)].find((n) => n.op === 'Single-row index lookup')!;
  assert.equal(lookup.loops, 16);
  assert.equal(lookup.actualRows, 16, 'rows are summed over loops');
  assert.ok(Math.abs(lookup.timeMs! - 682e-6 * 16) < 1e-9, 'time is summed over loops');
  assert.ok(plan.executionMs! > 0);
});

test('a MySQL ANALYZE line whose trailing clause has a colon still names the operation', () => {
  const line =
    '-> Index range scan on orders using PRIMARY over (10 < id), with index condition: (orders.id > 10)  (cost=1.16 rows=9) (actual time=0.0312..0.0403 rows=9 loops=1)';
  const node = parseMySqlAnalyzeTree(line).roots[0]!;
  assert.equal(node.op, 'Index range scan');
  assert.equal(node.detail, 'orders using PRIMARY over (10 < id), with index condition: (orders.id > 10)');
  assert.equal(node.cost, 1.16);
  assert.equal(node.actualRows, 9);
});

test('a MySQL plan of a table named r_rows is not mistaken for an analysed one', () => {
  const raw = JSON.stringify({
    query_block: {
      select_id: 1,
      cost_info: { query_cost: '0.55' },
      table: {
        table_name: 'r_rows',
        access_type: 'ALL',
        rows_examined_per_scan: 3,
        rows_produced_per_join: 3,
        filtered: '100.00',
        cost_info: { read_cost: '0.25', eval_cost: '0.30', prefix_cost: '0.55', data_read_per_join: '48' },
      },
    },
  });
  const plan = parseMySqlPlan(raw);
  assert.equal(plan.analysed, false, 'no node carries runtime figures');
  assert.equal(plan.executionMs, undefined);
  assert.ok([...planNodes(plan.roots)].every((n) => n.actualRows === undefined && n.timeMs === undefined));
});

test('MariaDB EXPLAIN and ANALYZE FORMAT=JSON', () => {
  const plan = parseMySqlPlan(fixture('mariadb-plan.json'));
  assert.equal(plan.analysed, false);
  assert.deepEqual(outline(plan.roots), [
    'Query block | #1',
    '  Sort | by count(0) desc',
    '    Temporary table',
    '      Nested loop',
    '        Index scan | c · using email',
    "        Index lookup | o · using customer_id (acme.c.id) · filter o.status = 'shipped'",
  ]);
  const analysed = parseMySqlPlan(fixture('mariadb-analyze.json'));
  assert.equal(analysed.analysed, true);
  assert.ok(analysed.planningMs! > 0, 'query_optimization time is the planning time');
  assert.ok(analysed.executionMs! > 0);
  const lookup = [...planNodes(analysed.roots)].find((n) => n.op === 'Index lookup')!;
  assert.equal(lookup.loops, 3);
  assert.equal(lookup.actualRows, 27, 'r_rows is per loop, so 9 × 3');
  assert.ok(lookup.timeMs! > 0);
});

test('SQLite EXPLAIN QUERY PLAN rows nest by parent id', () => {
  const columns = ['id', 'parent', 'notused', 'detail'];
  const plan = parseSqlitePlan(columns, [
    [3, 0, 107, 'SEARCH orders USING INDEX orders_customer (customer_id=?)'],
    [7, 0, 0, 'LIST SUBQUERY 1'],
    [9, 7, 216, 'SCAN customers'],
    [16, 0, 0, 'USE TEMP B-TREE FOR GROUP BY'],
  ]);
  assert.equal(plan.dialect, 'sqlite');
  assert.equal(plan.analysed, false);
  assert.deepEqual(outline(plan.roots), [
    'SEARCH | orders USING INDEX orders_customer (customer_id=?)',
    'LIST SUBQUERY | 1',
    '  SCAN | customers',
    'USE TEMP B-TREE FOR GROUP BY',
  ]);
  assert.equal(plan.roots[0]!.cost, undefined);
  assert.equal(parsePlan('sqlite', 'sqlite', columns, [[1, 0, 0, 'SCAN t']]).roots[0]!.detail, 't');
});

test('parsePlan picks the parser from the shape', () => {
  assert.equal(parsePlan('postgres', 'json', ['QUERY PLAN'], [[fixture('postgres-plan.json')]]).roots[0]!.op, 'Limit');
  assert.equal(parsePlan('mysql', 'json', ['EXPLAIN'], [[fixture('mysql-plan.json')]]).roots[0]!.op, 'Query block');
  assert.equal(parsePlan('mysql', 'tree', ['EXPLAIN'], [[fixture('mysql-analyze.txt')]]).roots[0]!.op, 'Limit');
});

test('explainRequest wraps the statement per dialect and drops a trailing terminator', () => {
  assert.deepEqual(explainRequest('postgres', 'SELECT 1;', 'plan'), { sql: 'EXPLAIN (FORMAT JSON) SELECT 1', shape: 'json', executes: false });
  assert.deepEqual(explainRequest('postgres', 'SELECT 1 -- c\n;', 'analyse'), {
    sql: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1',
    shape: 'json',
    executes: true,
  });
  assert.deepEqual(explainRequest('mysql', 'SELECT 1', 'plan'), { sql: 'EXPLAIN FORMAT=JSON SELECT 1', shape: 'json', executes: false });
  assert.deepEqual(explainRequest('mysql', 'SELECT 1', 'analyse'), { sql: 'EXPLAIN ANALYZE SELECT 1', shape: 'tree', executes: true });
  assert.deepEqual(explainRequest('mysql', 'SELECT 1', 'analyse', true), { sql: 'ANALYZE FORMAT=JSON SELECT 1', shape: 'json', executes: true });
  assert.deepEqual(explainRequest('sqlite', 'SELECT 1;', 'analyse'), { sql: 'EXPLAIN QUERY PLAN SELECT 1', shape: 'sqlite', executes: false });
  assert.equal(supportsAnalyse('sqlite'), false);
  assert.equal(supportsAnalyse('postgres'), true);
});
