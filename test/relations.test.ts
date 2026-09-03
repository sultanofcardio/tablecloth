import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRelation, referencingColumns, resolveForeignKey } from '../src/edit/relations';
import type { CatalogModel } from '../src/core/types';

const catalog: CatalogModel = {
  serverVersion: 'PostgreSQL 17',
  introspectedAt: 0,
  databases: [
    {
      name: 'acme',
      allSchemaNames: ['public', 'billing'],
      schemas: [
        {
          name: 'public',
          implicit: false,
          sequences: [],
          enums: [],
          routines: [],
          relations: [
            {
              name: 'customers',
              kind: 'table',
              indexes: [],
              columns: [{ name: 'id', dataType: 'bigint', nullable: false, primaryKey: true }],
            },
            {
              name: 'orders',
              kind: 'table',
              indexes: [],
              columns: [
                { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true },
                { name: 'customer_id', dataType: 'bigint', nullable: false, primaryKey: false, foreignKeyTarget: 'customers', foreignKeyColumn: 'id' },
              ],
            },
          ],
        },
        {
          name: 'billing',
          implicit: false,
          sequences: [],
          enums: [],
          routines: [],
          relations: [
            {
              name: 'invoices',
              kind: 'table',
              indexes: [],
              columns: [
                { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true },
                { name: 'order_id', dataType: 'bigint', nullable: false, primaryKey: false, foreignKeyTarget: 'public.orders' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test('findRelation prefers the named schema, then public, then anything', () => {
  assert.equal(findRelation(catalog, 'billing', 'invoices')?.schema.name, 'billing');
  assert.equal(findRelation(catalog, undefined, 'orders')?.schema.name, 'public');
  assert.equal(findRelation(catalog, undefined, 'invoices')?.schema.name, 'billing');
  assert.equal(findRelation(catalog, 'public', 'nothing'), undefined);
  assert.equal(findRelation(catalog, undefined, 'ORDERS')?.relation.name, 'orders', 'case-insensitive');
});

test('resolveForeignKey follows the target and falls back to the primary key', () => {
  const orders = findRelation(catalog, 'public', 'orders')!.relation;
  const fk = resolveForeignKey(catalog, 'public', orders.columns[1]!);
  assert.equal(fk?.relation.name, 'customers');
  assert.equal(fk?.column, 'id');
  const invoices = findRelation(catalog, 'billing', 'invoices')!.relation;
  const cross = resolveForeignKey(catalog, 'billing', invoices.columns[1]!);
  assert.equal(cross?.schema.name, 'public');
  assert.equal(cross?.column, 'id', 'no referenced column recorded: the target primary key is used');
  assert.equal(resolveForeignKey(catalog, 'public', orders.columns[0]!), undefined);
});

test('referencingColumns lists every foreign key pointing at a table, across schemas', () => {
  const found = findRelation(catalog, 'public', 'orders')!;
  const refs = referencingColumns(catalog, found.schema, found.relation);
  assert.deepEqual(
    refs.map((r) => [r.schema.name, r.relation.name, r.column.name, r.viaColumn]),
    [['billing', 'invoices', 'order_id', 'id']],
  );
  const customers = findRelation(catalog, 'public', 'customers')!;
  assert.deepEqual(
    referencingColumns(catalog, customers.schema, customers.relation).map((r) => r.relation.name),
    ['orders'],
  );
});
