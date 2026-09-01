import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableCountQuery, tablePageQuery, wrapCount, wrapPaged } from '../src/sql/paging';

test('wrapPaged wraps and pages', () => {
  const sql = wrapPaged('postgres', 'SELECT * FROM orders;', { limit: 501, offset: 0 });
  assert.match(sql, /^SELECT \* FROM \(\nSELECT \* FROM orders\n\) AS _tablecloth_q LIMIT 501 OFFSET 0$/);
});

test('wrapPaged applies sort on the wrapper', () => {
  const sql = wrapPaged('mysql', 'SELECT a, b FROM t', {
    limit: 11,
    offset: 20,
    sort: { column: 'a', direction: 'desc' },
  });
  assert.match(sql, /ORDER BY `a` DESC LIMIT 11 OFFSET 20$/);
});

test('wrapPaged with null limit omits paging', () => {
  const sql = wrapPaged('postgres', 'SELECT 1', { limit: null, offset: 0 });
  assert.ok(!sql.includes('LIMIT'));
});

test('wrapCount counts the full result', () => {
  assert.match(wrapCount('sqlite', 'SELECT * FROM t;'), /^SELECT COUNT\(\*\) FROM \(\nSELECT \* FROM t\n\) AS _tablecloth_q$/);
});

test('tablePageQuery quotes per dialect', () => {
  assert.equal(
    tablePageQuery('postgres', 'public', 'orders', { limit: 501, offset: 500, sort: { column: 'id', direction: 'asc' } }),
    'SELECT * FROM "public"."orders" ORDER BY "id" ASC LIMIT 501 OFFSET 500',
  );
  assert.equal(
    tablePageQuery('mysql', 'acme', 'orders', { limit: 11, offset: 0 }),
    'SELECT * FROM `acme`.`orders` LIMIT 11',
  );
  assert.equal(tablePageQuery('sqlite', undefined, 'orders', { limit: null, offset: 0 }), 'SELECT * FROM "orders"');
});

test('tableCountQuery', () => {
  assert.equal(tableCountQuery('postgres', 'public', 'x'), 'SELECT COUNT(*) FROM "public"."x"');
});
