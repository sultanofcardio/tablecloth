import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCompletions, identifierInsertText } from '../src/complete/core';
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
          routines: [{ name: 'add_one', kind: 'function', args: '(integer)' }],
          relations: [
            {
              name: 'orders',
              kind: 'table',
              indexes: [],
              columns: [
                { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true },
                {
                  name: 'customer_id',
                  dataType: 'bigint',
                  nullable: false,
                  primaryKey: false,
                  foreignKeyTarget: 'customers',
                },
                { name: 'status', dataType: 'text', nullable: false, primaryKey: false },
              ],
            },
            {
              name: 'customers',
              kind: 'table',
              indexes: [],
              columns: [
                { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true },
                { name: 'email', dataType: 'varchar(120)', nullable: false, primaryKey: false },
              ],
            },
            { name: 'shipped', kind: 'view', indexes: [], columns: [] },
            {
              name: 'Channel',
              kind: 'table',
              indexes: [],
              columns: [{ name: 'displayName', dataType: 'text', nullable: true, primaryKey: false }],
            },
          ],
        },
      ],
    },
  ],
};

function labels(text: string, offset = text.length): string[] {
  return computeCompletions(catalog, 'postgres', text, offset).map((e) => e.label);
}

test('after FROM, tables and schemas are offered', () => {
  const got = labels('SELECT * FROM ');
  assert.ok(got.includes('orders'));
  assert.ok(got.includes('customers'));
  assert.ok(got.includes('shipped'));
  assert.ok(got.includes('public'));
});

test('alias-qualified position offers that table\'s columns', () => {
  const got = labels('SELECT o. FROM orders o', 'SELECT o.'.length);
  assert.deepEqual(got, ['id', 'customer_id', 'status']);
});

test('schema-qualified position offers its relations', () => {
  const got = labels('SELECT * FROM public.');
  assert.deepEqual(got.sort(), ['Channel', 'customers', 'orders', 'shipped']);
});

test('general position ranks in-statement columns first', () => {
  const entries = computeCompletions(catalog, 'postgres', 'SELECT  FROM orders', 'SELECT '.length);
  assert.equal(entries[0]?.kind, 'column');
  assert.ok(entries.some((e) => e.kind === 'routine' && e.label === 'add_one'));
  const firstTable = entries.findIndex((e) => e.kind === 'table');
  const firstColumn = entries.findIndex((e) => e.kind === 'column');
  assert.ok(firstColumn < firstTable, 'columns sort before tables');
});

test('columns carry PK/FK details', () => {
  const entries = computeCompletions(catalog, 'postgres', 'SELECT o. FROM orders o', 'SELECT o.'.length);
  assert.match(entries.find((e) => e.label === 'id')!.detail!, /PK/);
  assert.match(entries.find((e) => e.label === 'customer_id')!.detail!, /FK → customers/);
});

test('mixed-case names complete with quotes where the dialect needs them', () => {
  const entries = computeCompletions(catalog, 'postgres', 'SELECT * FROM ', 'SELECT * FROM '.length);
  const channel = entries.find((e) => e.label === 'Channel')!;
  assert.equal(channel.insertText, '"Channel"', 'postgres folds unquoted names; completion must quote');
  assert.equal(entries.find((e) => e.label === 'orders')!.insertText, undefined);

  const cols = computeCompletions(catalog, 'postgres', 'SELECT c. FROM "Channel" c', 'SELECT c.'.length);
  assert.equal(cols.find((e) => e.label === 'displayName')!.insertText, '"displayName"');
});

test('identifierInsertText per dialect', () => {
  assert.equal(identifierInsertText('postgres', 'orders'), undefined);
  assert.equal(identifierInsertText('postgres', 'Channel'), '"Channel"');
  assert.equal(identifierInsertText('sqlite', 'order items'), '"order items"');
  assert.equal(identifierInsertText('mysql', 'Channel'), undefined, 'bare mixed case is fine in MySQL');
  assert.equal(identifierInsertText('mysql', 'order-items'), '`order-items`');
});

test('blank line between statements still completes from the whole catalog', () => {
  const text = 'SELECT * FROM orders;\n\nSELECT * FROM customers;';
  const got = computeCompletions(catalog, 'postgres', text, text.indexOf('\n\n') + 1);
  assert.ok(got.some((e) => e.label === 'orders'));
});
