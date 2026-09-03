import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DataSourceConfig, QueryResult } from '../src/core/types';
import type { DbSession } from '../src/drivers/driver';
import { postgresDriver } from '../src/drivers/postgres';

const config: DataSourceConfig = {
  id: 'pg',
  name: 'pg',
  driver: 'postgres',
  color: 'none',
  readOnly: false,
  autoSync: false,
  auth: 'none',
  database: 'shop',
};

/**
 * A PostgreSQL server of the given release. pg_attribute grew attidentity in
 * 10 and attgenerated in 12; older servers answer a query that reads them with
 * "column ... does not exist", which is what this stands in for.
 */
class FakePostgres implements DbSession {
  readonly dialect = 'postgres' as const;
  constructor(readonly serverVersion: string, private readonly major: number) {}

  async query(): Promise<QueryResult> {
    throw new Error('not used');
  }

  async queryRaw(sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
    if (this.major < 12 && sql.includes('attgenerated')) {
      throw new Error('column a.attgenerated does not exist');
    }
    if (this.major < 10 && sql.includes('attidentity')) {
      throw new Error('column a.attidentity does not exist');
    }
    const modern = this.major >= 12;
    if (sql.includes('FROM pg_namespace')) return rows([['public']]);
    if (sql.includes('FROM pg_class c')) return rows([['public', 'orders', 'r']]);
    if (sql.includes('FROM pg_attribute a')) {
      return rows([
        ['public', 'orders', 'id', 'integer', true, "nextval('orders_id_seq'::regclass)", false, false],
        ['public', 'orders', 'total_cents', 'bigint', false, null, false, modern],
      ]);
    }
    if (sql.includes('current_database')) return rows([['shop']]);
    return rows([]);
  }

  async close(): Promise<void> {}
}

function rows(values: unknown[][]): { columns: string[]; rows: unknown[][] } {
  return { columns: [], rows: values };
}

test('PostgreSQL 11 introspects without the columns that only exist from 12', async () => {
  const catalog = await postgresDriver.introspect(new FakePostgres('PostgreSQL 11.19', 11), config, false);
  const orders = catalog.databases[0]!.schemas[0]!.relations[0]!;
  assert.equal(orders.name, 'orders');
  assert.deepEqual(
    orders.columns.map((c) => [c.name, c.autoIncrement ?? false, c.generated ?? false]),
    [
      ['id', true, false],
      ['total_cents', false, false],
    ],
  );
});

test('PostgreSQL 12 and later still report generated columns', async () => {
  const catalog = await postgresDriver.introspect(new FakePostgres('PostgreSQL 16.2', 16), config, false);
  const orders = catalog.databases[0]!.schemas[0]!.relations[0]!;
  assert.deepEqual(
    orders.columns.map((c) => [c.name, c.generated ?? false]),
    [
      ['id', false],
      ['total_cents', true],
    ],
  );
});
