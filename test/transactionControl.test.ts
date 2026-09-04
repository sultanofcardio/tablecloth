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

function recordingSessions(): { sessions: SessionManager; runs: { suffix: string | undefined; statements: string[] }[] } {
  const runs: { suffix: string | undefined; statements: string[] }[] = [];
  const sessions = {
    closeSession: async () => undefined,
    run: async (_config: DataSourceConfig, fn: (session: DbSession) => Promise<unknown>, suffix?: string) => {
      const statements: string[] = [];
      runs.push({ suffix, statements });
      const session = {
        dialect: 'postgres',
        serverVersion: 'test',
        query: async (sql: string) => {
          statements.push(sql);
          return { columns: [], rows: [], affectedRows: 1, hasRows: false };
        },
        queryRaw: async () => ({ columns: [], rows: [] }),
        close: async () => undefined,
      } satisfies DbSession;
      return fn(session);
    },
  } as unknown as SessionManager;
  return { sessions, runs };
}

test('auto mode submits on the editor\'s own session under the chosen isolation', async () => {
  const { sessions, runs } = recordingSessions();
  const control = new TableTxControl(sessions, config, 'table:one', () => undefined);
  await control.pick('iso|serializable');
  assert.equal(control.suffix(), 'table:one', 'reads and writes never touch the shared main session');
  await control.submit([{ kind: 'update', row: 0, sql: 'UPDATE t SET a = 1 WHERE id = 1;' }]);
  assert.deepEqual(runs.map((r) => r.suffix), ['table:one']);
  assert.deepEqual(runs[0]!.statements, [
    'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    'BEGIN',
    'UPDATE t SET a = 1 WHERE id = 1;',
    'COMMIT',
  ]);
  assert.equal(control.state().inTx, false);
});

test('manual mode keeps the transaction open on the same dedicated session', async () => {
  const { sessions, runs } = recordingSessions();
  const control = new TableTxControl(sessions, config, 'table:two', () => undefined);
  await control.pick('mode|manual');
  await control.submit([{ kind: 'delete', row: 0, sql: 'DELETE FROM t WHERE id = 1;' }]);
  assert.equal(control.state().inTx, true);
  assert.deepEqual(runs[0]!.statements, ['BEGIN', 'SAVEPOINT tablecloth_submit', 'DELETE FROM t WHERE id = 1;', 'RELEASE SAVEPOINT tablecloth_submit']);
  await control.commit();
  assert.deepEqual(runs.map((r) => r.suffix), ['table:two', 'table:two']);
  assert.deepEqual(runs[1]!.statements, ['COMMIT']);
  assert.equal(control.state().inTx, false);
});
