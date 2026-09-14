import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mysqlDriver } from '../../src/drivers/mysql';
import { postgresDriver } from '../../src/drivers/postgres';
import type { DataSourceConfig } from '../../src/core/types';

// Gated on a real RDS or Aurora endpoint with IAM authentication turned on and
// a signed-in AWS profile (aws sso login first). PostgreSQL:
//   TABLECLOTH_RDS_IAM_HOST, _USER (the role granted rds_iam), _PROFILE, _DB, optional _PORT and _REGION
// MySQL, the same names with _MYSQL_ in them:
//   TABLECLOTH_RDS_IAM_MYSQL_HOST, _USER (created with AWSAuthenticationPlugin), _PROFILE, _DB, ...
// Each half connects twice: the second connect proves a fresh token is minted every time.
const PG_HOST = process.env.TABLECLOTH_RDS_IAM_HOST;
const MYSQL_HOST = process.env.TABLECLOTH_RDS_IAM_MYSQL_HOST;

function config(driver: 'postgres' | 'mysql', prefix: string, host: string, defaultPort: number): DataSourceConfig {
  const env = (name: string) => process.env[`${prefix}_${name}`];
  return {
    id: `rds-iam-${driver}`,
    name: `rds-iam-${driver}`,
    driver,
    color: 'none',
    readOnly: true,
    autoSync: true,
    auth: 'awsIam',
    host,
    port: Number(env('PORT') ?? defaultPort),
    database: env('DB'),
    user: env('USER'),
    aws: { profile: env('PROFILE'), region: env('REGION') },
    ssl: { mode: 'require' },
  };
}

test('postgres over RDS IAM', { skip: !PG_HOST }, async () => {
  const cfg = config('postgres', 'TABLECLOTH_RDS_IAM', PG_HOST!, 5432);
  const first = await postgresDriver.connect({ config: cfg, secrets: {} });
  try {
    assert.match(first.serverVersion, /^PostgreSQL \d/);
    const res = await first.queryRaw('SHOW server_version');
    assert.ok(res.rows[0]?.[0], 'the session answers a query');
  } finally {
    await first.close();
  }
  const second = await postgresDriver.connect({ config: cfg, secrets: {} });
  await second.close();
});

test('mysql over RDS IAM', { skip: !MYSQL_HOST }, async () => {
  const cfg = config('mysql', 'TABLECLOTH_RDS_IAM_MYSQL', MYSQL_HOST!, 3306);
  const first = await mysqlDriver.connect({ config: cfg, secrets: {} });
  try {
    assert.match(first.serverVersion, /^(MySQL|MariaDB) \d/);
    const res = await first.queryRaw('SELECT CURRENT_USER()');
    assert.ok(res.rows[0]?.[0], 'the session answers a query');
  } finally {
    await first.close();
  }
  const second = await mysqlDriver.connect({ config: cfg, secrets: {} });
  await second.close();
});
