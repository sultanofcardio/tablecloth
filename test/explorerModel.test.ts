import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExplorerTree, type ExplorerNode } from '../src/ui/explorerModel';
import type { CatalogModel, StoredDataSource } from '../src/core/types';

const ds: StoredDataSource = {
  scope: 'global',
  config: {
    id: 'ds1',
    name: 'acme-dev',
    driver: 'postgres',
    color: 'green',
    readOnly: false,
    autoSync: true,
    auth: 'userPassword',
  },
};

const catalog: CatalogModel = {
  serverVersion: 'PostgreSQL 16.2',
  introspectedAt: Date.now(),
  databases: [
    {
      name: 'acme',
      allSchemaNames: ['public', 'audit', 'pgagent'],
      schemas: [
        {
          name: 'public',
          implicit: false,
          sequences: [{ name: 'orders_id_seq' }],
          enums: [{ name: 'order_status', values: ['pending', 'shipped'] }],
          routines: [{ name: 'add_one', kind: 'function', args: '(integer)' }],
          relations: [
            {
              name: 'orders',
              kind: 'table',
              indexes: [{ name: 'idx_orders_status', columns: ['status'], unique: false }],
              columns: [
                { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true },
                {
                  name: 'customer_id',
                  dataType: 'bigint',
                  nullable: false,
                  primaryKey: false,
                  foreignKeyTarget: 'customers',
                },
              ],
            },
            { name: 'shipped', kind: 'view', indexes: [], columns: [] },
          ],
        },
      ],
    },
  ],
};

function find(nodes: ExplorerNode[], predicate: (n: ExplorerNode) => boolean): ExplorerNode | undefined {
  for (const node of nodes) {
    if (predicate(node)) return node;
    const child = node.children && find(node.children, predicate);
    if (child) return child;
  }
  return undefined;
}

test('an unintrospected data source is lazy', () => {
  const tree = buildExplorerTree([ds], { getCatalog: () => undefined, isConnected: () => false });
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.lazy, true);
  assert.equal(tree[0]!.vendor, 'postgres');
  assert.ok(tree[0]!.envColor);
});

test('an introspected source carries the full IntelliJ tree shape', () => {
  const tree = buildExplorerTree([ds], { getCatalog: () => catalog, isConnected: () => true });
  const root = tree[0]!;
  assert.match(root.meta ?? '', /PostgreSQL 16\.2/);

  const db = root.children![0]!;
  assert.equal(db.kind, 'database');
  assert.equal(db.chip, '1 of 3', 'introspection badge');

  const schema = find(tree, (n) => n.kind === 'schema' && n.label === 'public')!;
  const groups = schema.children!.map((g) => `${g.label}:${g.count}`);
  assert.deepEqual(groups, ['tables:1', 'views:1', 'sequences:1', 'routines:1', 'object types:1']);

  const orders = find(tree, (n) => n.kind === 'table' && n.label === 'orders')!;
  const [id, customerId, index] = orders.children!;
  assert.equal(id!.pk, true);
  assert.match(id!.meta!, /bigint · PK/);
  assert.equal(customerId!.fk, true);
  assert.match(customerId!.meta!, /FK → customers/);
  assert.equal(index!.kind, 'index');
  assert.match(index!.meta!, /\(status\)/);

  const enumNode = find(tree, (n) => n.kind === 'enum')!;
  assert.deepEqual(
    enumNode.children!.map((v) => v.label),
    ['pending', 'shipped'],
  );
});

test('empty store yields the hint row', () => {
  const tree = buildExplorerTree([], { getCatalog: () => undefined, isConnected: () => false });
  assert.equal(tree[0]!.kind, 'empty');
});
