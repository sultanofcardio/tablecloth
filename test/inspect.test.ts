import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closestName, inspectSql } from '../src/inspect/core';
import type { CatalogModel } from '../src/core/types';

const catalog: CatalogModel = {
  serverVersion: 'PostgreSQL 17',
  introspectedAt: Date.now(),
  databases: [
    {
      name: 'acme',
      allSchemaNames: ['public', 'audit'],
      schemas: [
        {
          name: 'public',
          implicit: false,
          sequences: [],
          enums: [],
          routines: [],
          relations: [
            {
              name: 'orders',
              kind: 'table',
              indexes: [],
              columns: [
                { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true },
                { name: 'customer_id', dataType: 'bigint', nullable: false, primaryKey: false, foreignKeyTarget: 'customers' },
                { name: 'status', dataType: 'text', nullable: false, primaryKey: false },
                { name: 'total', dataType: 'numeric', nullable: false, primaryKey: false },
              ],
            },
            {
              name: 'customers',
              kind: 'table',
              indexes: [],
              columns: [
                { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true },
                { name: 'email', dataType: 'text', nullable: false, primaryKey: false },
              ],
            },
            {
              name: 'Programs',
              kind: 'table',
              indexes: [],
              columns: [
                { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true },
                { name: 'channelId', dataType: 'bigint', nullable: false, primaryKey: false },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const messages = (sql: string) => inspectSql(catalog, 'postgres', sql, 'public').map((i) => i.message);

test('resolved statements produce nothing', () => {
  assert.deepEqual(messages('SELECT o.id, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = \'x\''), []);
  assert.deepEqual(messages('SELECT id, status, count(*) AS n FROM orders GROUP BY id, status ORDER BY n DESC'), []);
  assert.deepEqual(messages("INSERT INTO orders (customer_id, status) VALUES (1, 'new')"), []);
  assert.deepEqual(messages('UPDATE orders SET status = DEFAULT WHERE id = 1'), []);
  assert.deepEqual(messages('SELECT extract(year FROM created) FROM generate_series(1, 3) g'), []);
});

test('the mock-up: an ORDER BY alias typo gets a Change-to fix', () => {
  const sql = 'SELECT c.email, count(*) AS order_count\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nGROUP BY c.email\nORDER BY order_cnt DESC;';
  const found = inspectSql(catalog, 'postgres', sql, 'public');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.message, "Unable to resolve column 'order_cnt'");
  assert.equal(sql.slice(found[0]!.start, found[0]!.end), 'order_cnt');
  assert.equal(found[0]!.fix?.replacement, 'order_count');
});

test('unresolved tables and qualified columns', () => {
  const tables = inspectSql(catalog, 'postgres', 'SELECT * FROM ordrs o WHERE o.id = 1', 'public');
  assert.deepEqual(tables.map((i) => [i.message, i.fix?.replacement]), [["Unable to resolve table 'ordrs'", 'orders']]);

  const columns = inspectSql(catalog, 'postgres', 'SELECT o.stauts FROM orders o', 'public');
  assert.deepEqual(columns.map((i) => [i.message, i.fix?.replacement]), [["Unable to resolve column 'stauts' in orders", 'status']]);
});

test('CTEs, subqueries, other schemas, and multi-table statements stay quiet', () => {
  assert.deepEqual(messages('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent'), []);
  assert.deepEqual(messages('SELECT * FROM (SELECT id FROM orders) AS q WHERE q.id > 1'), []);
  assert.deepEqual(messages('SELECT * FROM audit.log'), [], 'schema known but not introspected');
  assert.deepEqual(messages('SELECT * FROM other_schema.thing'), [], 'schema unknown entirely');
  assert.deepEqual(
    messages('SELECT mystery FROM orders o JOIN customers c ON c.id = o.customer_id'),
    ["Unable to resolve column 'mystery'"],
    'bare names are checked against every joined table',
  );
  assert.deepEqual(messages('SELECT email, status FROM orders o JOIN customers c ON c.id = o.customer_id'), []);
});

test('offsets are absolute across statements', () => {
  const sql = 'SELECT 1;\nSELECT bogus FROM orders';
  const found = inspectSql(catalog, 'postgres', sql, 'public');
  assert.equal(found.length, 1);
  assert.equal(sql.slice(found[0]!.start, found[0]!.end), 'bogus');
});

test('quick fixes write the suggestion so it resolves: the token\'s own quotes, or the dialect\'s', () => {
  const fixes = (sql: string, dialect: 'postgres' | 'mysql' = 'postgres') =>
    inspectSql(catalog, dialect, sql, 'public').map((i) => [i.fix?.title, i.fix?.replacement]);
  assert.deepEqual(fixes('SELECT * FROM "Progrms"'), [["Change to 'Programs'", '"Programs"']], 'a quoted typo stays quoted');
  assert.deepEqual(fixes('SELECT * FROM progrms'), [["Change to 'Programs'", '"Programs"']], 'Postgres folds a bare name');
  assert.deepEqual(fixes('SELECT * FROM progrms', 'mysql'), [["Change to 'Programs'", 'Programs']], 'MySQL keeps a bare name\'s case');
  assert.deepEqual(fixes('SELECT * FROM `Progrms`', 'mysql'), [["Change to 'Programs'", '`Programs`']]);
  assert.deepEqual(fixes('SELECT * FROM ordrs'), [["Change to 'orders'", 'orders']], 'a lowercase name stays bare');

  assert.deepEqual(fixes('SELECT p.chanelId FROM "Programs" p'), [["Change to 'channelId'", '"channelId"']]);
  assert.deepEqual(fixes('SELECT p."chanelId" FROM "Programs" p'), [["Change to 'channelId'", '"channelId"']]);
  assert.deepEqual(fixes('SELECT chanelId FROM "Programs"'), [["Change to 'channelId'", '"channelId"']]);
  assert.deepEqual(fixes('SELECT "chanelId" FROM "Programs"'), [["Change to 'channelId'", '"channelId"']]);
  assert.deepEqual(fixes('SELECT o.stauts FROM orders o'), [["Change to 'status'", 'status']]);
});

test('IS DISTINCT FROM and ON DUPLICATE KEY UPDATE do not introduce tables', () => {
  assert.deepEqual(messages('SELECT * FROM orders WHERE status IS DISTINCT FROM total'), []);
  assert.deepEqual(messages('SELECT * FROM orders o WHERE o.status IS NOT DISTINCT FROM o.total'), []);
  assert.deepEqual(messages('SELECT * FROM orders WHERE status IS DISTINCT FROM totl'), ["Unable to resolve column 'totl'"], 'the operand is still a column');
  assert.deepEqual(
    inspectSql(catalog, 'mysql', "INSERT INTO orders (id, status) VALUES (1, 'x') ON DUPLICATE KEY UPDATE status = 'y'", 'public').map((i) => i.message),
    [],
  );
  assert.deepEqual(messages('SELECT * FROM typo'), ["Unable to resolve table 'typo'"], 'an ordinary FROM is still checked');
});

test('implicit select-list aliases resolve later in the statement', () => {
  assert.deepEqual(messages('SELECT count(*) cnt FROM orders GROUP BY status ORDER BY cnt DESC'), []);
  assert.deepEqual(messages('SELECT status s, total * 2 doubled FROM orders ORDER BY s, doubled'), []);
  assert.deepEqual(messages('SELECT count(*) "Cnt" FROM orders ORDER BY "Cnt"'), []);
  const found = inspectSql(catalog, 'postgres', 'SELECT count(*) cnt FROM orders ORDER BY cn', 'public');
  assert.deepEqual(found.map((i) => [i.message, i.fix?.replacement]), [["Unable to resolve column 'cn'", 'cnt']]);
});

test('closestName', () => {
  assert.equal(closestName('order_cnt', ['order_count', 'email']), 'order_count');
  assert.equal(closestName('stauts', ['status', 'total']), 'status');
  assert.equal(closestName('zzz', ['status', 'total']), undefined);
  assert.equal(closestName('cust', ['customers', 'orders']), 'customers');
});
