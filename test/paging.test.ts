import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTrailingSemicolon, tableCountQuery, tableDistinctQuery, tablePageQuery, tableViewQuery, wrapCount, wrapDistinct, wrapPaged } from '../src/sql/paging';

test('stripTrailingSemicolon drops trailing semicolons, comments and whitespace only', () => {
  assert.equal(stripTrailingSemicolon('select 1; -- note'), 'select 1');
  assert.equal(stripTrailingSemicolon('select 1;;'), 'select 1');
  assert.equal(stripTrailingSemicolon('select 1 /* c */ ;'), 'select 1');
  assert.equal(stripTrailingSemicolon('select 1 -- note\n'), 'select 1');
  assert.equal(stripTrailingSemicolon('select 1;\n/* a */ -- b\n;\n'), 'select 1');
  assert.equal(stripTrailingSemicolon('select 1 # note', 'mysql'), 'select 1');
  // leading and inner text, including comments, strings and identifiers containing ; stay intact
  assert.equal(stripTrailingSemicolon("  -- head\nselect ';' as \"a;b\" /* mid */ from t;"), "  -- head\nselect ';' as \"a;b\" /* mid */ from t");
  assert.equal(stripTrailingSemicolon('select 1'), 'select 1');
  assert.equal(stripTrailingSemicolon('; -- nothing'), '');
});

test('console wrappers survive a trailing comment or repeated terminators', () => {
  assert.equal(
    wrapPaged('postgres', 'select 1; -- note', { limit: 11, offset: 0 }),
    'SELECT * FROM (\nselect 1\n) AS _tablecloth_q LIMIT 11 OFFSET 0',
  );
  assert.equal(wrapCount('mysql', 'select 1;; # note'), 'SELECT COUNT(*) FROM (\nselect 1\n) AS _tablecloth_q');
  assert.equal(
    wrapDistinct('sqlite', 'select 1 /* c */ ;', 'a', undefined, 5),
    'SELECT DISTINCT a FROM (\nselect 1\n) AS _tablecloth_q ORDER BY a LIMIT 5',
  );
});

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

test('WHERE and ORDER BY text apply to table pages, counts, and distinct lists', () => {
  assert.equal(
    tablePageQuery('postgres', 'public', 'orders', { limit: 501, offset: 0, where: "status = 'shipped'", orderBy: 'created_at DESC' }),
    `SELECT * FROM "public"."orders" WHERE status = 'shipped' ORDER BY created_at DESC LIMIT 501`,
  );
  assert.equal(tableCountQuery('sqlite', undefined, 'orders', 'total > 1'), 'SELECT COUNT(*) FROM "orders" WHERE total > 1');
  assert.equal(
    tableDistinctQuery('postgres', 'public', 'orders', 'status', "total > 1", 201),
    `SELECT DISTINCT status FROM "public"."orders" WHERE total > 1 ORDER BY status LIMIT 201`,
  );
  assert.equal(tableViewQuery('mysql', 'acme', 'orders', { where: '', orderBy: 'id' }), 'SELECT * FROM `acme`.`orders` ORDER BY id');
});

test('console wrappers carry the filter text on the wrapper, and ORDER BY text beats the legacy sort', () => {
  assert.equal(
    wrapPaged('postgres', 'SELECT * FROM t;', { limit: 11, offset: 0, where: 'a = 1', orderBy: 'b DESC', sort: { column: 'z', direction: 'asc' } }),
    'SELECT * FROM (\nSELECT * FROM t\n) AS _tablecloth_q WHERE a = 1 ORDER BY b DESC LIMIT 11 OFFSET 0',
  );
  assert.equal(wrapCount('postgres', 'SELECT * FROM t', 'a = 1'), 'SELECT COUNT(*) FROM (\nSELECT * FROM t\n) AS _tablecloth_q WHERE a = 1');
  assert.equal(
    wrapDistinct('postgres', 'SELECT * FROM t', 'Display Name', undefined, 5),
    'SELECT DISTINCT "Display Name" FROM (\nSELECT * FROM t\n) AS _tablecloth_q ORDER BY "Display Name" LIMIT 5',
  );
});
