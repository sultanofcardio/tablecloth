import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postgresDriver } from '../../src/drivers/postgres';
import { SessionManager } from '../../src/drivers/sessions';
import { wrapCount, wrapPaged } from '../../src/sql/paging';
import type { DataSourceConfig } from '../../src/core/types';

// Gated: set TABLECLOTH_PG_PORT (and optionally _HOST/_USER/_PASSWORD/_DB) to run,
// e.g. against: docker run -e POSTGRES_PASSWORD=secret -p 15432:5432 postgres:16
const PORT = process.env.TABLECLOTH_PG_PORT;

function config(readOnly = false): DataSourceConfig {
  return {
    id: 'pg-test',
    name: 'pg-test',
    driver: 'postgres',
    color: 'none',
    readOnly,
    autoSync: true,
    auth: 'userPassword',
    host: process.env.TABLECLOTH_PG_HOST ?? '127.0.0.1',
    port: Number(PORT),
    database: process.env.TABLECLOTH_PG_DB ?? 'postgres',
    user: process.env.TABLECLOTH_PG_USER ?? 'postgres',
  };
}

const secrets = { password: process.env.TABLECLOTH_PG_PASSWORD ?? 'secret' };

test('postgres end to end', { skip: !PORT }, async (t) => {
  const session = await postgresDriver.connect({ config: config(), secrets });
  assert.match(session.serverVersion, /^PostgreSQL \d/);

  await t.test('schema setup', async () => {
    await session.query('DROP SCHEMA IF EXISTS tc_test CASCADE');
    await session.query('CREATE SCHEMA tc_test');
    await session.query("CREATE TYPE tc_test.order_status AS ENUM ('pending','shipped','delivered')");
    await session.query(`CREATE TABLE tc_test.customers (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email varchar(120) NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await session.query(`CREATE TABLE tc_test.orders (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      customer_id bigint NOT NULL REFERENCES tc_test.customers(id),
      status tc_test.order_status NOT NULL DEFAULT 'pending',
      total numeric(10,2) NOT NULL DEFAULT 0
    )`);
    await session.query('CREATE INDEX idx_tc_orders_status ON tc_test.orders (status)');
    await session.query('CREATE VIEW tc_test.shipped AS SELECT * FROM tc_test.orders WHERE status = \'shipped\'');
    await session.query(
      'CREATE FUNCTION tc_test.add_one(n integer) RETURNS integer AS $$ SELECT n + 1 $$ LANGUAGE sql',
    );
    await session.query("INSERT INTO tc_test.customers (email) SELECT 'u' || g || '@example.com' FROM generate_series(1, 3) g");
    await session.query(
      "INSERT INTO tc_test.orders (customer_id, status, total) SELECT (g % 3) + 1, 'shipped', g FROM generate_series(1, 700) g",
    );
  });

  await t.test('introspection', async () => {
    const cfg = { ...config(), schemas: ['tc_test'] };
    const catalog = await postgresDriver.introspect(session, cfg, false);
    const schema = catalog.databases[0]!.schemas.find((s) => s.name === 'tc_test')!;
    assert.ok(schema, 'tc_test schema introspected');

    const orders = schema.relations.find((r) => r.name === 'orders')!;
    assert.equal(orders.kind, 'table');
    assert.equal(orders.columns.find((c) => c.name === 'id')!.primaryKey, true);
    assert.equal(orders.columns.find((c) => c.name === 'customer_id')!.foreignKeyTarget, 'customers');
    assert.equal(orders.columns.find((c) => c.name === 'status')!.dataType, 'tc_test.order_status');
    assert.equal(orders.columns.find((c) => c.name === 'total')!.dataType, 'numeric(10,2)');
    assert.ok(orders.indexes.some((i) => i.name === 'idx_tc_orders_status'));

    assert.ok(schema.relations.some((r) => r.name === 'shipped' && r.kind === 'view'));
    assert.ok(schema.routines.some((r) => r.name === 'add_one' && r.kind === 'function'));
    const enumType = schema.enums.find((e) => e.name === 'order_status')!;
    assert.deepEqual(enumType.values, ['pending', 'shipped', 'delivered']);
    assert.ok(schema.sequences.length >= 1, 'identity sequences listed');
    assert.ok(catalog.databases[0]!.allSchemaNames.includes('public'));
  });

  await t.test('paging and count', async () => {
    const page = await session.query(
      wrapPaged('postgres', 'SELECT * FROM tc_test.orders', {
        limit: 501,
        offset: 0,
        sort: { column: 'total', direction: 'desc' },
      }),
    );
    assert.equal(page.rows.length, 501);
    assert.equal(Number(page.rows[0]![3]), 700);
    const count = await session.query(wrapCount('postgres', 'SELECT * FROM tc_test.orders'));
    assert.equal(Number(count.rows[0]![0]), 700);
  });

  await t.test('multi-statement text yields the last row set, not a broken empty result', async () => {
    // statements are split upstream; this guards the driver when several still arrive as one string
    const res = await session.query("SELECT 1 AS a; SELECT 'two' AS b");
    assert.deepEqual(
      res.columns.map((c) => c.name),
      ['b'],
    );
    assert.deepEqual(res.rows, [['two']]);
    assert.equal(res.hasRows, true);
  });

  await t.test('timestamps come back as wire text', async () => {
    const res = await session.query("SELECT now()::timestamptz AS ts, current_date AS d");
    assert.equal(typeof res.rows[0]![0], 'string');
    assert.equal(typeof res.rows[0]![1], 'string');
  });

  await t.test('affected rows reported for DML', async () => {
    const res = await session.query("UPDATE tc_test.orders SET status = 'delivered' WHERE total <= 10");
    assert.equal(res.hasRows, false);
    assert.equal(res.affectedRows, 10);
  });

  await session.close();

  await t.test('read-only session blocks writes but allows reads', async () => {
    const ro = await postgresDriver.connect({ config: config(true), secrets });
    const ok = await ro.query('SELECT count(*) FROM tc_test.orders');
    assert.equal(Number(ok.rows[0]![0]), 700);
    await assert.rejects(
      () => ro.query("INSERT INTO tc_test.customers (email) VALUES ('ro@example.com')"),
      /read-only/i,
    );
    await ro.close();
  });

  await t.test('missing password surfaces a readable error, not the SASL one', async () => {
    await assert.rejects(
      () => postgresDriver.connect({ config: config(), secrets: {} }),
      /asked for a password/,
    );
  });

  await t.test('search_path is per session: consoles resolve unqualified names in their schema', async () => {
    const manager = new SessionManager({ getSecrets: async () => secrets, showSystemSchemas: () => false });
    const cfg = config();
    try {
      await manager.run(cfg, (s) => s.query('SET search_path TO tc_test'), 'consoleA');
      const scoped = await manager.run(cfg, (s) => s.query('SELECT count(*) FROM orders'), 'consoleA');
      assert.equal(Number(scoped.rows[0]![0]), 700, 'unqualified name resolves in the console schema');
      await assert.rejects(
        () => manager.run(cfg, (s) => s.query('SELECT count(*) FROM orders')),
        /does not exist/,
        'the main session keeps its own search_path',
      );
    } finally {
      await manager.disconnectAll();
    }
  });

  await t.test('console sessions are isolated: manual tx invisible to the main session', async () => {
    const manager = new SessionManager({ getSecrets: async () => secrets, showSystemSchemas: () => false });
    const cfg = config();
    try {
      await manager.run(cfg, (s) => s.query('BEGIN'), 'consoleA');
      await manager.run(
        cfg,
        (s) => s.query("INSERT INTO tc_test.customers (email) VALUES ('txiso@example.com')"),
        'consoleA',
      );
      const fromMain = await manager.run(cfg, (s) =>
        s.query("SELECT count(*) FROM tc_test.customers WHERE email = 'txiso@example.com'"),
      );
      assert.equal(Number(fromMain.rows[0]![0]), 0, 'uncommitted insert is invisible to the main session');
      await manager.run(cfg, (s) => s.query('ROLLBACK'), 'consoleA');
      const after = await manager.run(cfg, (s) =>
        s.query("SELECT count(*) FROM tc_test.customers WHERE email = 'txiso@example.com'"),
      );
      assert.equal(Number(after.rows[0]![0]), 0);
    } finally {
      await manager.disconnectAll();
    }
  });
});
