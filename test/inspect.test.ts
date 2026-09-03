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

test('closestName', () => {
  assert.equal(closestName('order_cnt', ['order_count', 'email']), 'order_count');
  assert.equal(closestName('stauts', ['status', 'total']), 'status');
  assert.equal(closestName('zzz', ['status', 'total']), undefined);
  assert.equal(closestName('cust', ['customers', 'orders']), 'customers');
});
