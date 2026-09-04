import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasFor, computeCompletions, identifierInsertText } from '../src/complete/core';
import type { CatalogModel } from '../src/core/types';
import { SQL_RESERVED_WORDS } from '../src/sql/reserved';
import { SQL_KEYWORDS } from '../src/sql/tokens';

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

test('statement start offers live templates and statement keywords', () => {
  const entries = computeCompletions(catalog, 'postgres', '', 0);
  const sel = entries.find((e) => e.label === 'sel');
  assert.equal(sel?.kind, 'template');
  assert.equal(sel?.snippet, true);
  assert.match(sel!.insertText!, /^SELECT \* FROM \$\{1:table\}$/);
  assert.ok(entries.some((e) => e.kind === 'keyword' && e.label === 'SELECT'));
  assert.ok(entries.findIndex((e) => e.kind === 'template') < entries.findIndex((e) => e.kind === 'keyword'));
});

test('after JOIN, foreign keys become whole join clauses, ranked first', () => {
  const text = 'SELECT * FROM orders o JOIN ';
  const entries = computeCompletions(catalog, 'postgres', text, text.length);
  assert.equal(entries[0]?.kind, 'join');
  assert.equal(entries[0]?.label, 'customers c ON c.id = o.customer_id');
  assert.ok(entries.some((e) => e.kind === 'table' && e.label === 'orders'));
});

test('after ON, the FK condition between the joined tables comes first', () => {
  const text = 'SELECT * FROM orders o JOIN customers c ON ';
  const entries = computeCompletions(catalog, 'postgres', text, text.length);
  assert.equal(entries[0]?.label, 'c.id = o.customer_id');
  assert.equal(entries[0]?.kind, 'join');
  const continued = computeCompletions(catalog, 'postgres', text + 'c.id = o.customer_id AND ', text.length + 'c.id = o.customer_id AND '.length);
  assert.equal(continued[0]?.label, 'c.id = o.customer_id');
});

test('after a complete identifier, clause keywords are offered', () => {
  const text = 'SELECT * FROM orders o ';
  const entries = computeCompletions(catalog, 'postgres', text, text.length);
  assert.equal(entries[0]?.kind, 'keyword');
  assert.ok(entries.some((e) => e.label === 'WHERE'));
  assert.ok(entries.some((e) => e.label === 'LEFT JOIN'));
});

test('after SELECT and WHERE, columns lead and functions follow', () => {
  const text = 'SELECT * FROM orders o WHERE ';
  const entries = computeCompletions(catalog, 'postgres', text, text.length);
  assert.equal(entries[0]?.kind, 'column');
  const fn = entries.find((e) => e.label === 'coalesce');
  assert.equal(fn?.kind, 'function');
  assert.equal(fn?.insertText, 'coalesce($1)');
});

test('after a complete FROM clause only what can follow is offered, alias first', () => {
  const text = 'SELECT channel_id\nFROM "Programs"\n';
  const entries = computeCompletions(catalog, 'postgres', text, text.length);
  assert.deepEqual(entries[0], { label: 'P', kind: 'alias', detail: 'alias', sortText: '2P' });
  assert.ok(entries.slice(1).every((e) => e.kind === 'keyword'), 'no tables, columns, or functions after a table name');
  const ordered = [...entries].sort((a, b) => a.sortText.localeCompare(b.sortText)).map((e) => e.label);
  assert.deepEqual(ordered.slice(0, 5), ['P', 'AS', 'WHERE', 'LEFT JOIN', 'JOIN']);
  assert.ok(ordered.includes('GROUP BY') && ordered.includes('ORDER BY') && ordered.includes('UNION'));
  assert.equal(ordered.includes('AND'), false);
});

test('after a WHERE condition: AND / OR and the clauses that may follow, operators only after a name', () => {
  const afterValue = labels("SELECT * FROM orders o WHERE status = 'x' ");
  assert.deepEqual(afterValue.slice(0, 2), ['AND', 'OR']);
  assert.ok(afterValue.includes('GROUP BY') && afterValue.includes('ORDER BY') && afterValue.includes('LIMIT'));
  assert.equal(afterValue.includes('IS NULL'), false);
  assert.equal(afterValue.includes('orders'), false);
  const afterName = labels('SELECT * FROM orders o WHERE o.status ');
  assert.ok(afterName.includes('IS NULL') && afterName.includes('LIKE') && afterName.includes('BETWEEN'));
});

test('next-token keywords follow the clause: select list, join, group, order, update, insert', () => {
  assert.equal(labels('SELECT id ')[0], 'FROM');
  assert.deepEqual(labels('SELECT * FROM orders o JOIN customers ').slice(0, 3), ['c', 'AS', 'ON']);
  assert.deepEqual(labels('SELECT * FROM orders o JOIN customers c ').slice(0, 2), ['ON', 'USING'], 'an alias already typed is not offered again');
  assert.deepEqual(labels('SELECT * FROM orders GROUP BY status ').slice(0, 2), ['HAVING', 'ORDER BY']);
  assert.deepEqual(labels('SELECT * FROM orders ORDER BY id ').slice(0, 4), ['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST']);
  const mysql = computeCompletions(catalog, 'mysql', 'SELECT * FROM orders ORDER BY id ', 33).map((e) => e.label);
  assert.deepEqual(mysql.slice(0, 2), ['ASC', 'DESC']);
  assert.equal(mysql.includes('NULLS FIRST'), false, 'MySQL has no NULLS clause');
  assert.deepEqual(labels("UPDATE orders SET status = 'x' ").slice(0, 2), ['WHERE', 'RETURNING']);
  assert.deepEqual(labels('UPDATE orders ').slice(0, 2), ['o', 'AS']);
  assert.deepEqual(labels('INSERT INTO orders (id) ').slice(0, 3), ['VALUES', 'SELECT', 'DEFAULT VALUES']);
  assert.deepEqual(labels('DELETE FROM orders ').slice(0, 3), ['o', 'AS', 'WHERE']);
  assert.deepEqual(labels('SELECT * FROM orders LIMIT 10 ').slice(0, 1), ['OFFSET']);
});

test('completion inside a mysql double-quoted literal offers no objects', () => {
  const text = 'SELECT * FROM orders WHERE status = "st';
  const mysql = computeCompletions(catalog, 'mysql', text, text.length);
  assert.deepEqual(mysql.filter((e) => e.kind === 'column' || e.kind === 'table' || e.kind === 'view').map((e) => e.label), []);
  const postgres = computeCompletions(catalog, 'postgres', text, text.length).map((e) => e.label);
  assert.ok(postgres.includes('status'), 'PostgreSQL still completes a quoted identifier');
  const backticks = 'SELECT * FROM orders WHERE `st';
  assert.ok(
    computeCompletions(catalog, 'mysql', backticks, backticks.length).map((e) => e.label).includes('status'),
    'MySQL still completes a backticked identifier',
  );
});

test('aliasFor uses initials and avoids taken names', () => {
  assert.equal(aliasFor('order_items', new Set()), 'oi');
  assert.equal(aliasFor('customers', new Set(['c'])), 'c2');
  assert.equal(aliasFor('Programs', new Set()), 'P');
  assert.equal(aliasFor('LiveStream', new Set()), 'LS');
  assert.equal(aliasFor('pg_stat_activity', new Set()), 'psa');
});

test('aliasFor never spells a keyword or reserved word', () => {
  const reserved = new Set([...SQL_KEYWORDS, ...SQL_RESERVED_WORDS]);
  for (const name of ['invoice_notes', 'order_notes', 'audit_sessions', 'item_stock', 'order_requests', 'order_form', 'digital_orders']) {
    const alias = aliasFor(name, new Set());
    assert.equal(reserved.has(alias.toLowerCase()), false, `${name} -> ${alias}`);
  }
  assert.equal(aliasFor('invoice_notes', new Set()), 'ino', 'initials grow by the next letters of the last word');
  assert.equal(aliasFor('order_notes', new Set()), 'ono');
  assert.equal(aliasFor('audit_sessions', new Set()), 'ase');
  assert.equal(aliasFor('invoice_notes', new Set(['ino'])), 'ino2', 'a taken lengthened alias still gets the numeric suffix');
  assert.equal(aliasFor('a_s', new Set()), 'as2', 'a last word too short to lengthen falls back to the numeric suffix');
});

const keywordAliasCatalog: CatalogModel = {
  serverVersion: 'MySQL 8',
  introspectedAt: 0,
  databases: [
    {
      name: 'acme',
      allSchemaNames: ['acme'],
      schemas: [
        {
          name: 'acme',
          implicit: true,
          sequences: [],
          enums: [],
          routines: [],
          relations: [
            {
              name: 'invoices',
              kind: 'table',
              indexes: [],
              columns: [{ name: 'id', dataType: 'bigint', nullable: false, primaryKey: true }],
            },
            {
              name: 'invoice_notes',
              kind: 'table',
              indexes: [],
              columns: [
                { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true },
                { name: 'invoice_id', dataType: 'bigint', nullable: false, primaryKey: false, foreignKeyTarget: 'invoices' },
              ],
            },
            { name: 'order_notes', kind: 'table', indexes: [], columns: [] },
            { name: 'LiveStream', kind: 'table', indexes: [], columns: [] },
          ],
        },
      ],
    },
  ],
};

test('the alias suggestion keeps the case the table was typed with', () => {
  const entries = computeCompletions(keywordAliasCatalog, 'mysql', 'SELECT * FROM LiveStream ', 'SELECT * FROM LiveStream '.length);
  assert.deepEqual(entries[0], { label: 'LS', kind: 'alias', detail: 'alias', sortText: '2LS' });
  const update = computeCompletions(keywordAliasCatalog, 'mysql', 'UPDATE LiveStream ', 'UPDATE LiveStream '.length);
  assert.equal(update[0]?.label, 'LS');
});

test('an alias that would be a keyword is never offered, in the FROM clause or in FK joins', () => {
  const afterFrom = computeCompletions(keywordAliasCatalog, 'mysql', 'SELECT * FROM order_notes ', 'SELECT * FROM order_notes '.length);
  assert.equal(afterFrom[0]?.kind, 'alias');
  assert.equal(afterFrom[0]?.label, 'ono');
  assert.equal(afterFrom.some((e) => e.label.toLowerCase() === 'on' && e.kind === 'alias'), false);

  const text = 'SELECT * FROM invoices i JOIN ';
  const joins = computeCompletions(keywordAliasCatalog, 'mysql', text, text.length).filter((e) => e.kind === 'join');
  assert.deepEqual(joins.map((e) => e.label), ['invoice_notes ino ON ino.invoice_id = i.id']);
});

test('a star that completes a term offers the clause keywords, FROM first', () => {
  for (const text of ['SELECT * ', 'SELECT DISTINCT * ', 'SELECT id, * ', 'SELECT o.* ']) {
    const entries = computeCompletions(catalog, 'postgres', text, text.length);
    assert.deepEqual(entries[0], { label: 'FROM', kind: 'keyword', sortText: '300' }, text);
    assert.equal(entries.some((e) => e.kind === 'column' || e.kind === 'function'), false, `no columns after ${JSON.stringify(text)}`);
    assert.equal(entries.some((e) => e.label === 'AS'), false, `AS makes no sense after ${JSON.stringify(text)}`);
  }
  const inCall = computeCompletions(catalog, 'postgres', 'SELECT count(* ', 'SELECT count(* '.length);
  assert.equal(inCall.some((e) => e.kind === 'column' || e.kind === 'function'), false, 'nothing to name inside count(*');
  assert.equal(inCall.some((e) => e.label === 'AS' || e.label === 'AND'), false);
  const multiplication = computeCompletions(catalog, 'postgres', 'SELECT id * FROM orders', 'SELECT id * '.length);
  assert.equal(multiplication[0]?.kind, 'column', 'a star after a name multiplies, so operands follow');
});
