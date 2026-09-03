import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ColumnModel, DataSourceConfig } from '../src/core/types';
import type { SessionManager } from '../src/drivers/sessions';
import { buildChangeStatements } from '../src/edit/changeSet';
import { TableGridProvider } from '../src/ui/providers';

const config: DataSourceConfig = {
  id: 'ds',
  name: 'test',
  driver: 'postgres',
  color: 'none',
  readOnly: false,
  autoSync: false,
  auth: 'none',
};

const catalogColumns: ColumnModel[] = [
  { name: 'id', dataType: 'integer', nullable: false, primaryKey: true },
  { name: 'a', dataType: 'text', nullable: true, primaryKey: false },
  { name: 'b', dataType: 'text', nullable: true, primaryKey: false },
  { name: 'c', dataType: 'text', nullable: true, primaryKey: false },
];

function provider(): TableGridProvider {
  return new TableGridProvider('postgres', 'public', 't', ['id'], '"public"."t"', {} as SessionManager, config, {
    tableColumns: catalogColumns,
    referencing: [],
    panelKey: 'k',
    onTxChange: () => undefined,
  });
}

test('the table editor maps each fetched page onto the catalog by column name', () => {
  const page = { columns: [{ name: 'id', numeric: true }, { name: 'b' }, { name: 'c' }], rows: [[1, 'bee', 'sea']], offset: 0, hasMore: false, durationMs: 0 };
  const target = provider().editing!.targetFor(page);
  assert.deepEqual(
    target.columns.map((c) => [c.name, c.key, c.readOnly]),
    [
      ['id', true, false],
      ['b', false, false],
      ['c', false, false],
    ],
  );
  const statements = buildChangeStatements(target, page.rows, { updates: { 0: { 2: { kind: 'value', text: 'lake' } } }, deletes: [], inserts: [] });
  assert.deepEqual(
    statements.map((s) => s.sql),
    [`UPDATE "public"."t" SET c = 'lake' WHERE id = 1;`],
  );
});

test('a live column the catalog does not know stays read-only until the next introspection', () => {
  const page = { columns: [{ name: 'id', numeric: true }, { name: 'phone' }, { name: 'a' }], rows: [[1, '555', 'x']], offset: 0, hasMore: false, durationMs: 0 };
  const target = provider().editing!.targetFor(page);
  assert.deepEqual(target.columns.map((c) => [c.name, c.readOnly]), [['id', false], ['phone', true], ['a', false]]);
  assert.equal(target.wholeRowKey, false);
});
