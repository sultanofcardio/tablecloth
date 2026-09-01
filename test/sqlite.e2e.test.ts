import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteDriver } from '../src/drivers/sqlite';
import { tablePageQuery, wrapCount, wrapPaged } from '../src/sql/paging';
import type { DataSourceConfig } from '../src/core/types';

function config(file: string, readOnly = false): DataSourceConfig {
  return {
    id: 'test',
    name: 'test',
    driver: 'sqlite',
    color: 'none',
    readOnly,
    autoSync: true,
    auth: 'none',
    file,
  };
}

const dir = mkdtempSync(join(tmpdir(), 'tablecloth-'));
const dbFile = join(dir, 'test.db');

test('sqlite end to end: DDL, introspection, paging, read-only', async (t) => {
  const session = await sqliteDriver.connect({ config: config(dbFile), secrets: {} });
  assert.match(session.serverVersion, /^SQLite \d/);

  await t.test('create schema and data', async () => {
    await session.query(`CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT
    )`);
    await session.query(`CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL DEFAULT 'pending',
      total REAL NOT NULL DEFAULT 0
    )`);
    await session.query('CREATE INDEX idx_orders_status ON orders (status)');
    await session.query('CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100');
    const insert = await session.query(
      "INSERT INTO customers (id, email, name) VALUES (1, 'ada@example.com', 'Ada'), (2, 'grace@example.com', NULL)",
    );
    assert.equal(insert.affectedRows, 2);
    for (let i = 1; i <= 1200; i++) {
      await session.query(`INSERT INTO orders (customer_id, status, total) VALUES (${(i % 2) + 1}, 'shipped', ${i})`);
    }
  });

  await t.test('introspection model', async () => {
    const catalog = await sqliteDriver.introspect(session, config(dbFile), false);
    assert.equal(catalog.databases.length, 1);
    const schema = catalog.databases[0]!.schemas[0]!;
    const names = schema.relations.map((r) => `${r.kind}:${r.name}`);
    assert.deepEqual(names, ['view:big_orders', 'table:customers', 'table:orders']);

    const orders = schema.relations.find((r) => r.name === 'orders')!;
    const id = orders.columns.find((c) => c.name === 'id')!;
    assert.equal(id.primaryKey, true);
    const fk = orders.columns.find((c) => c.name === 'customer_id')!;
    assert.equal(fk.foreignKeyTarget, 'customers');
    const status = orders.columns.find((c) => c.name === 'status')!;
    assert.equal(status.nullable, false);
    assert.equal(status.default, "'pending'");
    assert.deepEqual(
      orders.indexes.map((i) => i.name),
      ['idx_orders_status'],
    );
    assert.deepEqual(orders.indexes[0]!.columns, ['status']);
  });

  await t.test('table paging with sort, more-detection, count', async () => {
    const page1 = await session.query(
      tablePageQuery('sqlite', undefined, 'orders', { limit: 501, offset: 0, sort: { column: 'total', direction: 'desc' } }),
    );
    assert.equal(page1.rows.length, 501); // 500 + the has-more probe row
    assert.equal(page1.rows[0]![3], 1200);

    const page3 = await session.query(
      tablePageQuery('sqlite', undefined, 'orders', { limit: 501, offset: 1000, sort: { column: 'total', direction: 'desc' } }),
    );
    assert.equal(page3.rows.length, 200);
    assert.equal(page3.rows[0]![3], 200);

    const count = await session.query(wrapCount('sqlite', 'SELECT * FROM orders'));
    assert.equal(count.rows[0]![0], 1200);
  });

  await t.test('console query wrapping', async () => {
    const wrapped = await session.query(
      wrapPaged('sqlite', 'SELECT customer_id, count(*) AS n FROM orders GROUP BY customer_id;', {
        limit: 10,
        offset: 0,
        sort: { column: 'n', direction: 'desc' },
      }),
    );
    assert.equal(wrapped.rows.length, 2);
    assert.equal(wrapped.columns.map((c) => c.name).join(','), 'customer_id,n');
  });

  await session.close();
});

test('sqlite manual transaction rolls back', async () => {
  const session = await sqliteDriver.connect({ config: config(dbFile), secrets: {} });
  await session.query('BEGIN');
  await session.query("INSERT INTO customers (id, email) VALUES (50, 'tx@example.com')");
  const inside = await session.query("SELECT count(*) AS n FROM customers WHERE id = 50");
  assert.equal(inside.rows[0]![0], 1);
  await session.query('ROLLBACK');
  const after = await session.query("SELECT count(*) AS n FROM customers WHERE id = 50");
  assert.equal(after.rows[0]![0], 0);
  await session.close();
});

test('sqlite read-only session rejects writes', async () => {
  const session = await sqliteDriver.connect({ config: config(dbFile, true), secrets: {} });
  const read = await session.query('SELECT count(*) AS n FROM orders');
  assert.equal(read.rows[0]![0], 1200);
  await assert.rejects(() => session.query("INSERT INTO customers (id, email) VALUES (99, 'x@example.com')"));
  await session.close();
});
