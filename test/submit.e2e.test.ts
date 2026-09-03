import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteDriver } from '../src/drivers/sqlite';
import { buildChangeStatements, makeEditTarget } from '../src/edit/changeSet';
import { runChangeBatch } from '../src/ui/providers';
import { generateDdl } from '../src/sql/ddl';
import type { DataSourceConfig } from '../src/core/types';

function config(file: string): DataSourceConfig {
  return { id: 'submit', name: 'submit', driver: 'sqlite', color: 'none', readOnly: false, autoSync: true, auth: 'none', file };
}

const dir = mkdtempSync(join(tmpdir(), 'tablecloth-submit-'));
const dbFile = join(dir, 'submit.db');

test('a reviewed change set runs atomically against SQLite', async (t) => {
  const session = await sqliteDriver.connect({ config: config(dbFile), secrets: {} });
  await session.query(`CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    total REAL NOT NULL DEFAULT 0,
    note TEXT
  )`);
  await session.query("INSERT INTO orders (customer_id, status, total, note) VALUES (88, 'shipped', 129.9, NULL), (12, 'shipped', 84, 'gift wrap'), (57, 'shipped', 312.45, NULL)");
  const catalog = await sqliteDriver.introspect(session, config(dbFile), false);
  const rel = catalog.databases[0]!.schemas[0]!.relations.find((r) => r.name === 'orders')!;
  const pageColumns = rel.columns.map((c) => ({ name: c.name, dataType: c.dataType, numeric: /int|real/i.test(c.dataType) }));
  const target = makeEditTarget('sqlite', '"orders"', rel.columns, pageColumns, false);
  assert.equal(target.columns[0]!.autoIncrement, true, 'INTEGER PRIMARY KEY is the rowid alias');

  await t.test('update, delete, insert commit together', async () => {
    const page = await session.query('SELECT * FROM orders ORDER BY id');
    const statements = buildChangeStatements(target, page.rows, {
      updates: { 0: { 2: { kind: 'value', text: 'delivered' } } },
      deletes: [2],
      inserts: [{ id: 'n', cells: { 1: { kind: 'value', text: '5' }, 4: { kind: 'null' } } }],
    });
    assert.deepEqual(
      statements.map((s) => s.sql),
      [
        "UPDATE \"orders\" SET status = 'delivered' WHERE id = 1;",
        'DELETE FROM "orders" WHERE id = 3;',
        'INSERT INTO "orders" (customer_id, note) VALUES (5, NULL);',
      ],
    );
    await runChangeBatch(session, statements, { joinOpenTransaction: false, commit: true });
    const after = await session.query('SELECT id, customer_id, status FROM orders ORDER BY id');
    // without AUTOINCREMENT, SQLite hands the new row the freed rowid 3
    assert.deepEqual(after.rows, [
      [1, 88, 'delivered'],
      [2, 12, 'shipped'],
      [3, 5, 'pending'],
    ]);
  });

  await t.test('a statement matching more than one row rolls the whole batch back', async () => {
    await session.query("UPDATE orders SET status = 'shipped'");
    const wholeRow = makeEditTarget('sqlite', '"orders"', rel.columns, [{ name: 'status' }], false);
    assert.equal(wholeRow.wholeRowKey, true);
    const statements = buildChangeStatements(wholeRow, [['shipped']], { updates: {}, deletes: [0], inserts: [] });
    const before = await session.query('SELECT count(*) FROM orders');
    await assert.rejects(
      () => runChangeBatch(session, statements, { joinOpenTransaction: false, commit: true }),
      /matched 3 rows instead of exactly 1/,
    );
    const afterCount = await session.query('SELECT count(*) FROM orders');
    assert.deepEqual(afterCount.rows, before.rows, 'nothing changed');
  });

  await t.test('inside an open transaction the batch uses a savepoint and leaves the transaction usable', async () => {
    await session.query('BEGIN');
    const bad = buildChangeStatements(target, [[999, 1, 'x', 1, null]], { updates: {}, deletes: [0], inserts: [] });
    await assert.rejects(() => runChangeBatch(session, bad, { joinOpenTransaction: true, commit: false }));
    // the transaction is still open and usable
    await session.query("INSERT INTO orders (customer_id) VALUES (7)");
    await session.query('ROLLBACK');
    const count = await session.query('SELECT count(*) FROM orders');
    assert.deepEqual(count.rows, [[3]]);
  });

  await t.test('DDL for the table and its indexes', async () => {
    await session.query('CREATE INDEX idx_orders_status ON orders (status)');
    const ddl = await generateDdl(session, { kind: 'table', name: 'orders' });
    assert.match(ddl, /^CREATE TABLE orders \(/);
    assert.match(ddl, /CREATE INDEX idx_orders_status ON orders \(status\);\n$/);
    await assert.rejects(() => generateDdl(session, { kind: 'table', name: 'nope' }), /was not found/);
  });

  await session.close();
});
