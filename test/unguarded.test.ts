import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUnguardedWrites } from '../src/sql/unguarded';
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
