import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DataSourceConfig } from '../src/core/types';
import type { DbSession } from '../src/drivers/driver';
import type { SessionManager } from '../src/drivers/sessions';
import { TableTxControl } from '../src/ui/providers';

const config: DataSourceConfig = {
  id: 'ds',
  name: 'test',
  driver: 'postgres',
  color: 'none',
  readOnly: false,
  autoSync: false,
  auth: 'none',
};

test('returning table isolation to default replaces the customized session', async () => {
  const closed: string[] = [];
  const sessions = {
    closeSession: async (_id: string, suffix: string) => {
      closed.push(suffix);
    },
  } as SessionManager;
  const control = new TableTxControl(sessions, config, 'table:one', () => undefined);
  await control.pick('iso|serializable');
  const statements: string[] = [];
  const session = {
    dialect: 'postgres',
    serverVersion: 'test',
    query: async (sql: string) => {
      statements.push(sql);
      return { columns: [], rows: [], affectedRows: 0, hasRows: false };
    },
    queryRaw: async () => ({ columns: [], rows: [] }),
    close: async () => undefined,
  } satisfies DbSession;
  await control.ensureIsolation(session);
  await control.pick('iso|default');
  await control.ensureIsolation(session);
  assert.deepEqual(closed, ['table:one', 'table:one']);
  assert.deepEqual(statements, ['SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE']);
  assert.equal(control.state().isolation, 'default');
});
