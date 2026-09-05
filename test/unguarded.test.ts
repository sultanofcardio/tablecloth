import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countPlan, countProbe, findUnguardedWrites } from '../src/sql/unguarded';
import type { DriverId } from '../src/core/types';

const found = (sql: string, dialect: DriverId = 'postgres') =>
  findUnguardedWrites(sql, dialect).map((w) => [w.verb, sql.slice(w.start, w.end), w.table] as const);

test('DELETE and UPDATE with no WHERE are reported with the statement range and the table', () => {
  assert.deepEqual(found('DELETE FROM orders'), [['DELETE', 'DELETE FROM orders', { name: 'orders' }]]);
  assert.deepEqual(found('-- clear\nDELETE FROM orders;\n'), [['DELETE', 'DELETE FROM orders', { name: 'orders' }]]);
  assert.deepEqual(found("UPDATE public.orders SET status = 'x'"), [
    ['UPDATE', "UPDATE public.orders SET status = 'x'", { schema: 'public', name: 'orders' }],
  ]);
  assert.deepEqual(found('DELETE FROM "Programs" RETURNING id'), [['DELETE', 'DELETE FROM "Programs" RETURNING id', { name: 'Programs' }]]);
  assert.deepEqual(found('DELETE FROM ONLY orders'), [['DELETE', 'DELETE FROM ONLY orders', { name: 'orders' }]]);
  assert.deepEqual(found('UPDATE `orders` AS o SET o.total = 0', 'mysql'), [['UPDATE', 'UPDATE `orders` AS o SET o.total = 0', { name: 'orders' }]]);
  assert.deepEqual(found('UPDATE OR REPLACE orders SET total = 0', 'sqlite'), [['UPDATE', 'UPDATE OR REPLACE orders SET total = 0', { name: 'orders' }]]);
});

test('a WHERE at the statement level guards it, one inside a subquery does not', () => {
  assert.deepEqual(found('DELETE FROM orders WHERE id = 1'), []);
  assert.deepEqual(found('DELETE FROM orders WHERE TRUE'), []);
  assert.deepEqual(found("UPDATE orders SET status = 'x' WHERE 1 = 1"), []);
  assert.deepEqual(found('UPDATE orders o SET total = 0 FROM customers c WHERE c.id = o.customer_id'), []);
  assert.deepEqual(
    found('UPDATE orders SET total = (SELECT sum(amount) FROM lines WHERE lines.order_id = orders.id)').map((w) => w[0]),
    ['UPDATE'],
  );
  assert.deepEqual(found('DELETE FROM orders WHERE id IN (SELECT id FROM archived)'), []);
});

test("IntelliJ's exemptions: LIMIT, a conditioned JOIN, self-referencing SET", () => {
  assert.deepEqual(found('DELETE FROM orders LIMIT 10', 'mysql'), []);
  assert.deepEqual(found('UPDATE orders SET total = 0 ORDER BY id LIMIT 1', 'mysql'), []);
  assert.deepEqual(found('DELETE o FROM orders o JOIN customers c ON c.id = o.customer_id', 'mysql'), []);
  assert.deepEqual(found('UPDATE orders o JOIN customers c USING (id) SET o.total = 0', 'mysql'), []);
  assert.deepEqual(found('UPDATE orders o CROSS JOIN customers c SET o.total = 0', 'mysql').map((w) => w[0]), ['UPDATE']);
  assert.deepEqual(found('UPDATE counters SET hits = hits + 1'), []);
  assert.deepEqual(found('UPDATE counters SET hits = hits + 1, seen = greatest(seen, now())'), []);
  assert.deepEqual(found('UPDATE counters SET hits = hits + 1, reset = 0').map((w) => w[0]), ['UPDATE'], 'one plain assignment is still a bulk write');
  assert.deepEqual(found("UPDATE users SET name = 'x'").map((w) => w[0]), ['UPDATE']);
});

test('the verb inside a clause is not a statement', () => {
  for (const sql of [
    "INSERT INTO t (id) VALUES (1) ON DUPLICATE KEY UPDATE n = 1",
    'INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 1',
    'SELECT * FROM t FOR UPDATE',
    'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE WHEN NOT MATCHED THEN INSERT VALUES (1)',
    'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET n = 1',
    'CREATE TABLE t (id int REFERENCES p ON DELETE CASCADE ON UPDATE CASCADE)',
    'CREATE TRIGGER trg AFTER DELETE ON t FOR EACH ROW EXECUTE FUNCTION f()',
    'GRANT SELECT, DELETE, UPDATE ON t TO app',
    'CREATE POLICY p ON t FOR DELETE USING (true)',
    'EXPLAIN DELETE FROM t',
    'EXPLAIN (COSTS OFF) UPDATE t SET a = 1',
    'SELECT * FROM t WHERE kind = \'delete\'',
    'SELECT * FROM t -- delete from t\n',
  ]) {
    assert.deepEqual(found(sql, sql.includes('DUPLICATE') ? 'mysql' : 'postgres'), [], sql);
  }
});

test('statements inside WITH and EXPLAIN ANALYZE run, so they count', () => {
  assert.deepEqual(found('WITH gone AS (DELETE FROM orders RETURNING id) SELECT count(*) FROM gone'), [
    ['DELETE', 'DELETE FROM orders RETURNING id', { name: 'orders' }],
  ]);
  assert.deepEqual(found('WITH ids AS (SELECT id FROM archived) DELETE FROM orders'), [
    ['DELETE', 'DELETE FROM orders', { name: 'orders' }],
  ]);
  assert.deepEqual(found('WITH ids AS (SELECT id FROM archived) DELETE FROM orders WHERE id IN (SELECT id FROM ids)'), []);
  assert.deepEqual(found('EXPLAIN ANALYZE DELETE FROM orders').map((w) => w[0]), ['DELETE']);
  assert.deepEqual(found('EXPLAIN (ANALYZE, BUFFERS) UPDATE orders SET total = 0').map((w) => w[0]), ['UPDATE']);
});

test('several statements in one text, each on its own', () => {
  const sql = 'DELETE FROM a WHERE id = 1;\nDELETE FROM b;\nUPDATE c SET x = 1;\nUPDATE d SET x = 1 WHERE y = 2';
  assert.deepEqual(
    found(sql).map(([verb, text]) => [verb, text]),
    [
      ['DELETE', 'DELETE FROM b'],
      ['UPDATE', 'UPDATE c SET x = 1'],
    ],
  );
});

test('an UPDATE still being typed is not reported until it has a SET clause', () => {
  assert.deepEqual(found('UPDATE orders'), []);
  assert.deepEqual(found('UPDATE orders SET'), [['UPDATE', 'UPDATE orders SET', { name: 'orders' }]]);
  assert.deepEqual(found('DELETE'), [['DELETE', 'DELETE', undefined]]);
});

test('the row count is bounded server-side per dialect and never opens a transaction', () => {
  const outside = countPlan('postgres', 'public.orders', { inTransaction: false });
  assert.deepEqual(outside.before, ['SET statement_timeout = 3000']);
  assert.equal(outside.count, 'SELECT count(*) FROM public.orders');
  assert.deepEqual(outside.after, ['SET statement_timeout = DEFAULT']);

  const mysql = countPlan('mysql', '`shop`.`orders`', { inTransaction: false });
  assert.deepEqual(mysql.before, []);
  assert.equal(mysql.count, 'SELECT /*+ MAX_EXECUTION_TIME(3000) */ count(*) FROM `shop`.`orders`');
  assert.deepEqual(mysql.after, []);

  // MariaDB parses the MySQL hint as a plain comment and would run unbounded
  const mariadb = countPlan('mysql', '`shop`.`orders`', { inTransaction: false, mariadb: true });
  assert.deepEqual(mariadb.before, []);
  assert.equal(mariadb.count, 'SET STATEMENT max_statement_time=3 FOR SELECT count(*) FROM `shop`.`orders`');
  assert.deepEqual(mariadb.after, []);

  const sqlite = countPlan('sqlite', '"orders"', { inTransaction: false });
  assert.deepEqual(sqlite.before, []);
  assert.equal(sqlite.count, 'SELECT count(*) FROM "orders"');
  assert.deepEqual(sqlite.after, []);

  for (const plan of [outside, mysql, mariadb, sqlite]) {
    assert.equal([...plan.before, plan.count, ...plan.after].some((sql) => /^(BEGIN|START|COMMIT|ROLLBACK)\b/i.test(sql)), false);
  }
});

test('inside an open transaction the count runs under a savepoint that is always undone', () => {
  const pg = countPlan('postgres', 'public.orders', { inTransaction: true });
  assert.deepEqual(pg.before, ['SAVEPOINT tablecloth_count', 'SET LOCAL statement_timeout = 3000']);
  assert.equal(pg.count, 'SELECT count(*) FROM public.orders');
  assert.deepEqual(pg.after, ['ROLLBACK TO SAVEPOINT tablecloth_count', 'RELEASE SAVEPOINT tablecloth_count']);

  const mysql = countPlan('mysql', 'orders', { inTransaction: true });
  assert.deepEqual(mysql.before, ['SAVEPOINT tablecloth_count']);
  assert.equal(mysql.count, 'SELECT /*+ MAX_EXECUTION_TIME(3000) */ count(*) FROM orders');
  assert.deepEqual(mysql.after, ['ROLLBACK TO SAVEPOINT tablecloth_count', 'RELEASE SAVEPOINT tablecloth_count']);

  const mariadb = countPlan('mysql', 'orders', { inTransaction: true, mariadb: true });
  assert.deepEqual(mariadb.before, ['SAVEPOINT tablecloth_count']);
  assert.equal(mariadb.count, 'SET STATEMENT max_statement_time=3 FOR SELECT count(*) FROM orders');
  assert.deepEqual(mariadb.after, ['ROLLBACK TO SAVEPOINT tablecloth_count', 'RELEASE SAVEPOINT tablecloth_count']);

  const sqlite = countPlan('sqlite', 'orders', { inTransaction: true });
  assert.deepEqual(sqlite.before, ['SAVEPOINT tablecloth_count']);
  assert.deepEqual(sqlite.after, ['ROLLBACK TO SAVEPOINT tablecloth_count', 'RELEASE SAVEPOINT tablecloth_count']);
});

test("the count puts back the session's own statement_timeout instead of the server default", () => {
  assert.equal(countProbe('postgres', false), 'SHOW statement_timeout');
  // inside a transaction SET LOCAL is undone by the savepoint, so nothing is read
  assert.equal(countProbe('postgres', true), undefined);
  assert.equal(countProbe('mysql', false), undefined);
  assert.equal(countProbe('sqlite', false), undefined);

  const kept = countPlan('postgres', 'public.orders', { inTransaction: false, statementTimeout: '10min' });
  assert.deepEqual(kept.before, ['SET statement_timeout = 3000']);
  assert.deepEqual(kept.after, ["SET statement_timeout = '10min'"]);
  assert.deepEqual(countPlan('postgres', 'public.orders', { inTransaction: false, statementTimeout: '0' }).after, [
    "SET statement_timeout = '0'",
  ]);
  assert.deepEqual(countPlan('postgres', 'public.orders', { inTransaction: false, statementTimeout: "it's" }).after, [
    "SET statement_timeout = 'it''s'",
  ]);
});

test('a data-modifying CTE is a statement head even with a materialization hint', () => {
  assert.deepEqual(found('WITH gone AS MATERIALIZED (DELETE FROM orders RETURNING id) SELECT count(*) FROM gone'), [
    ['DELETE', 'DELETE FROM orders RETURNING id', { name: 'orders' }],
  ]);
  assert.deepEqual(found('WITH gone AS NOT MATERIALIZED (DELETE FROM orders RETURNING id) SELECT count(*) FROM gone'), [
    ['DELETE', 'DELETE FROM orders RETURNING id', { name: 'orders' }],
  ]);
  assert.deepEqual(
    found('WITH bumped AS MATERIALIZED (UPDATE orders SET total = 0 WHERE id = 1 RETURNING id) SELECT * FROM bumped'),
    [],
  );
});

test('an assignment is exempt only when it reads the target\'s own column', () => {
  // the classic forgotten join condition: every row of orders is rewritten
  assert.deepEqual(found('UPDATE orders o SET status = c.status FROM customers c'), [
    ['UPDATE', 'UPDATE orders o SET status = c.status FROM customers c', { name: 'orders' }],
  ]);
  assert.deepEqual(found('UPDATE orders SET total = archive.total FROM archive'), [
    ['UPDATE', 'UPDATE orders SET total = archive.total FROM archive', { name: 'orders' }],
  ]);
  assert.deepEqual(found('UPDATE orders o SET total = o.total * 2'), []);
  assert.deepEqual(found('UPDATE public.orders SET total = orders.total + 1'), []);
  assert.deepEqual(found('UPDATE `orders` o SET o.total = o.total + 1', 'mysql'), []);
});

test('EXPLAIN ANALYZE covers only the statement it runs, not a verb in its clauses', () => {
  assert.deepEqual(found('EXPLAIN ANALYZE INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 1'), []);
  assert.deepEqual(
    found('EXPLAIN ANALYZE MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE WHEN NOT MATCHED THEN INSERT VALUES (1)'),
    [],
  );
  assert.deepEqual(found('EXPLAIN ANALYZE SELECT * FROM orders FOR UPDATE'), []);
  assert.deepEqual(found('EXPLAIN ANALYZE DELETE FROM orders').map((w) => w[0]), ['DELETE']);
  assert.deepEqual(found('EXPLAIN (ANALYZE, BUFFERS) UPDATE orders SET total = 0').map((w) => w[0]), ['UPDATE']);
});

test("MySQL's multi-table DELETE names the table, not the target alias", () => {
  assert.deepEqual(found('DELETE o FROM orders o', 'mysql'), [['DELETE', 'DELETE o FROM orders o', { name: 'orders' }]]);
  assert.deepEqual(found('DELETE o FROM shop.orders AS o', 'mysql'), [
    ['DELETE', 'DELETE o FROM shop.orders AS o', { schema: 'shop', name: 'orders' }],
  ]);
  assert.deepEqual(found('DELETE o.* FROM orders o', 'mysql'), [['DELETE', 'DELETE o.* FROM orders o', { name: 'orders' }]]);
  // more than one target, or more than one table to delete from: name neither
  assert.deepEqual(found('DELETE a, b FROM a JOIN b', 'mysql'), [['DELETE', 'DELETE a, b FROM a JOIN b', undefined]]);
  assert.deepEqual(found('DELETE a FROM a, b', 'mysql'), [['DELETE', 'DELETE a FROM a, b', { name: 'a' }]]);
  assert.deepEqual(found('DELETE FROM t1, t2 USING t1, t2', 'mysql'), [['DELETE', 'DELETE FROM t1, t2 USING t1, t2', undefined]]);
  assert.deepEqual(found('DELETE x FROM orders o', 'mysql'), [['DELETE', 'DELETE x FROM orders o', undefined]]);
});

test('a conditioned JOIN exempts the statement only when it restricts the target', () => {
  // the join is between two other tables: every row of orders is still rewritten
  assert.deepEqual(found("UPDATE orders SET status = 'x' FROM customers c JOIN regions r ON r.id = c.region_id"), [
    ['UPDATE', "UPDATE orders SET status = 'x' FROM customers c JOIN regions r ON r.id = c.region_id", { name: 'orders' }],
  ]);
  assert.deepEqual(found('DELETE FROM orders USING customers c JOIN regions r ON r.id = c.region_id'), [
    ['DELETE', 'DELETE FROM orders USING customers c JOIN regions r ON r.id = c.region_id', { name: 'orders' }],
  ]);
  assert.deepEqual(found('UPDATE orders o JOIN customers c ON c.id = o.customer_id SET o.total = 0', 'mysql'), []);
  assert.deepEqual(found('DELETE o FROM orders o JOIN customers c ON c.id = o.customer_id', 'mysql'), []);
  assert.deepEqual(
    found('UPDATE orders o JOIN customers c ON c.id = o.customer_id JOIN regions r ON r.id = c.region_id SET o.total = 0', 'mysql'),
    [],
  );
  // any conditioned join that restricts the target is enough, not just the last one
  assert.deepEqual(
    found('UPDATE orders o SET total = 0 FROM customers c JOIN order_lines l ON l.order_id = o.id JOIN regions r ON r.id = c.region_id'),
    [],
  );
  assert.deepEqual(found('UPDATE orders o JOIN customers c ON c.id = o.customer_id CROSS JOIN regions r SET o.total = 0', 'mysql'), []);
});

test('a join is read for what it restricts, not for names that look like the target', () => {
  // a column spelled like the target table is not a reference to it
  assert.deepEqual(
    found("UPDATE orders SET status = 'x' FROM customers c JOIN regions r ON r.id = c.orders").map((w) => w[0]),
    ['UPDATE'],
  );
  // the target's own table joined again under another alias restricts nothing
  assert.deepEqual(
    found("UPDATE orders SET status = 'x' FROM customers c JOIN orders o2 ON o2.id = c.id").map((w) => w[0]),
    ['UPDATE'],
  );
  assert.deepEqual(found('UPDATE orders o JOIN customers c USING (id) SET o.total = 0', 'mysql'), []);
});

test('an assignment reading a subquery is not reading its own column', () => {
  assert.deepEqual(found('UPDATE orders SET total = (SELECT total FROM defaults)'), [
    ['UPDATE', 'UPDATE orders SET total = (SELECT total FROM defaults)', { name: 'orders' }],
  ]);
  assert.deepEqual(
    found('UPDATE orders SET total = (SELECT max(total) FROM archive), note = note').map((w) => w[0]),
    ['UPDATE'],
  );
  assert.deepEqual(found('UPDATE orders SET total = coalesce(total, 0)'), []);
  assert.deepEqual(found('UPDATE counters SET hits = hits + 1'), []);
  // grouping parentheses, casts and unary minus still read the target's own row
  assert.deepEqual(found('UPDATE counters SET hits = (hits + 1)'), []);
  assert.deepEqual(found('UPDATE counters SET hits = -(hits)'), []);
  assert.deepEqual(found('UPDATE counters SET hits = (hits + 1)::int'), []);
});
