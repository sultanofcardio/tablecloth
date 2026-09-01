import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mysqlDriver } from '../../src/drivers/mysql';
import { wrapCount, wrapPaged } from '../../src/sql/paging';
import type { DataSourceConfig } from '../../src/core/types';

// Gated: set TABLECLOTH_MYSQL_PORT to run, e.g. against:
// docker run -e MYSQL_ROOT_PASSWORD=secret -e MYSQL_DATABASE=acme -p 13306:3306 mysql:8
const PORT = process.env.TABLECLOTH_MYSQL_PORT;

function config(readOnly = false): DataSourceConfig {
  return {
    id: 'mysql-test',
    name: 'mysql-test',
    driver: 'mysql',
    color: 'none',
    readOnly,
    autoSync: true,
    auth: 'userPassword',
    host: process.env.TABLECLOTH_MYSQL_HOST ?? '127.0.0.1',
    port: Number(PORT),
    database: process.env.TABLECLOTH_MYSQL_DB ?? 'acme',
    user: process.env.TABLECLOTH_MYSQL_USER ?? 'root',
  };
}

const secrets = { password: process.env.TABLECLOTH_MYSQL_PASSWORD ?? 'secret' };

test('mysql end to end', { skip: !PORT }, async (t) => {
  const session = await mysqlDriver.connect({ config: config(), secrets });
  assert.match(session.serverVersion, /^(MySQL|MariaDB) \d/);

  await t.test('schema setup', async () => {
    await session.query('DROP TABLE IF EXISTS orders');
    await session.query('DROP TABLE IF EXISTS customers');
    await session.query(`CREATE TABLE customers (
      id bigint AUTO_INCREMENT PRIMARY KEY,
      email varchar(120) NOT NULL UNIQUE
    )`);
    await session.query(`CREATE TABLE orders (
      id bigint AUTO_INCREMENT PRIMARY KEY,
      customer_id bigint NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending',
      total decimal(10,2) NOT NULL DEFAULT 0,
      CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
      INDEX idx_orders_status (status)
    )`);
    await session.query("INSERT INTO customers (email) VALUES ('a@example.com'), ('b@example.com')");
    // one multi-row insert to keep the test fast
    const values = Array.from({ length: 700 }, (_, i) => `(${(i % 2) + 1}, 'shipped', ${i + 1})`).join(',');
    const res = await session.query(`INSERT INTO orders (customer_id, status, total) VALUES ${values}`);
    assert.equal(res.affectedRows, 700);
  });

  await t.test('introspection', async () => {
    const catalog = await mysqlDriver.introspect(session, config(), false);
    const db = catalog.databases.find((d) => d.name === (process.env.TABLECLOTH_MYSQL_DB ?? 'acme'))!;
    assert.ok(db, 'configured database introspected');
    const schema = db.schemas[0]!;
    assert.equal(schema.implicit, true);
    const orders = schema.relations.find((r) => r.name === 'orders')!;
    assert.equal(orders.columns.find((c) => c.name === 'id')!.primaryKey, true);
    assert.equal(orders.columns.find((c) => c.name === 'customer_id')!.foreignKeyTarget, 'customers');
    assert.equal(orders.columns.find((c) => c.name === 'total')!.dataType, 'decimal(10,2)');
    assert.ok(orders.indexes.some((i) => i.name === 'idx_orders_status'));
  });

  await t.test('paging and count', async () => {
    const page = await session.query(
      wrapPaged('mysql', 'SELECT * FROM orders', { limit: 501, offset: 0, sort: { column: 'total', direction: 'desc' } }),
    );
    assert.equal(page.rows.length, 501);
    assert.equal(Number(page.rows[0]![3]), 700);
    const count = await session.query(wrapCount('mysql', 'SELECT * FROM orders'));
    assert.equal(Number(count.rows[0]![0]), 700);
  });

  await session.close();

  await t.test('read-only session blocks writes but allows reads', async () => {
    const ro = await mysqlDriver.connect({ config: config(true), secrets });
    const ok = await ro.query('SELECT count(*) FROM orders');
    assert.equal(Number(ok.rows[0]![0]), 700);
    await assert.rejects(() => ro.query("INSERT INTO customers (email) VALUES ('ro@example.com')"));
    await ro.close();
  });
});
