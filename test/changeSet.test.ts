import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChangeStatements,
  countChanges,
  makeEditTarget,
  resultColumnOrigins,
  typedLiteral,
  valueKind,
  type ChangeSet,
} from '../src/edit/changeSet';
import type { ColumnInfo, ColumnModel, DriverId } from '../src/core/types';

const tableColumns: ColumnModel[] = [
  { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true, autoIncrement: true },
  { name: 'customer_id', dataType: 'bigint', nullable: false, primaryKey: false, foreignKeyTarget: 'customers', foreignKeyColumn: 'id' },
  { name: 'status', dataType: 'text', nullable: false, primaryKey: false, default: "'pending'" },
  { name: 'total', dataType: 'numeric(10,2)', nullable: false, primaryKey: false, default: '0' },
  { name: 'note', dataType: 'text', nullable: true, primaryKey: false },
  { name: 'paid', dataType: 'boolean', nullable: false, primaryKey: false, default: 'false' },
  { name: 'created_at', dataType: 'timestamptz', nullable: false, primaryKey: false, default: 'now()' },
  { name: 'total_cents', dataType: 'bigint', nullable: true, primaryKey: false, generated: true },
];

const pageColumns: ColumnInfo[] = tableColumns.map((c) => ({
  name: c.name,
  dataType: c.dataType,
  numeric: /int|numeric/.test(c.dataType),
}));

const rows = [
  [1042, 88, 'shipped', '129.90', null, false, '2026-08-28 14:02:00', 12990],
  [1041, 12, 'shipped', '84.00', 'gift wrap', true, '2026-08-28 11:47:00', 8400],
  [1040, 57, 'shipped', '312.45', null, false, '2026-08-27 19:20:00', 31245],
];

function target(dialect: DriverId, table = 'orders') {
  return makeEditTarget(dialect, table, tableColumns, pageColumns, false);
}

test('makeEditTarget: keys, read-only generated columns, defaults', () => {
  const t = target('postgres');
  assert.equal(t.readOnlyReason, undefined);
  assert.equal(t.wholeRowKey, false);
  assert.deepEqual(
    t.columns.map((c) => [c.name, c.key, c.readOnly, c.autoIncrement, c.hasDefault]),
    [
      ['id', true, false, true, true],
      ['customer_id', false, false, false, false],
      ['status', false, false, false, true],
      ['total', false, false, false, true],
      ['note', false, false, false, false],
      ['paid', false, false, false, true],
      ['created_at', false, false, false, true],
      ['total_cents', false, true, false, false],
    ],
  );
  assert.equal(t.columns[1]!.foreignKeyTarget, 'customers');
  assert.equal(t.columns[1]!.foreignKeyColumn, 'id');
});

test('makeEditTarget: read-only source, alias columns, missing key falls back to the whole row', () => {
  assert.equal(makeEditTarget('postgres', 'orders', tableColumns, pageColumns, true).readOnlyReason, 'The data source is read-only');
  const aliased = makeEditTarget(
    'postgres',
    'orders',
    tableColumns,
    [{ name: 'customer_id' }, { name: 'n', numeric: true }],
    false,
  );
  assert.equal(aliased.wholeRowKey, true);
  assert.deepEqual(aliased.columns.map((c) => [c.key, c.readOnly]), [[true, false], [false, true]]);
  const nothing = makeEditTarget('postgres', 'orders', tableColumns, [{ name: 'n' }], false);
  assert.equal(nothing.readOnlyReason, 'No editable columns in this result');
});

test('computed projections cannot impersonate source columns', () => {
  const result: ColumnInfo[] = [{ name: 'id', numeric: true }, { name: 'status' }];
  const origins = resultColumnOrigins('SELECT id + 1 AS id, status FROM orders', 'postgres', tableColumns, result);
  assert.deepEqual(origins, [undefined, 'status']);
  const sourced = result.map((column, i) => ({ ...column, sourceColumn: origins[i] }));
  const editable = makeEditTarget('postgres', 'orders', tableColumns, sourced, false, true);
  assert.deepEqual(editable.columns.map((column) => [column.name, column.readOnly, column.key]), [
    ['id', true, false],
    ['status', false, true],
  ]);
  assert.throws(
    () => buildChangeStatements(editable, [[2, 'new']], { updates: { 0: { 0: { kind: 'value', text: '3' } } }, deletes: [], inserts: [] }),
    /Column "id" cannot be edited/,
  );
});

test('direct aliases and stars retain their real source-column identities', () => {
  assert.deepEqual(
    resultColumnOrigins('SELECT id AS order_id, orders.status FROM orders', 'postgres', tableColumns, [{ name: 'order_id' }, { name: 'status' }]),
    ['id', 'status'],
  );
  assert.deepEqual(resultColumnOrigins('SELECT * FROM orders', 'postgres', tableColumns, pageColumns), tableColumns.map((column) => column.name));
});

test('the mock-up change set previews the four IntelliJ statements in order', () => {
  const changes: ChangeSet = {
    updates: { 0: { 2: { kind: 'value', text: 'delivered' } }, 1: { 3: { kind: 'value', text: '84.00' } } },
    deletes: [2],
    inserts: [{ id: 'new1', cells: { 1: { kind: 'value', text: '88' }, 2: { kind: 'value', text: 'pending' }, 3: { kind: 'value', text: '0.00' } } }],
  };
  assert.equal(countChanges(changes), 4);
  const statements = buildChangeStatements(target('postgres'), rows, changes);
  assert.deepEqual(
    statements.map((s) => s.sql),
    [
      "UPDATE orders SET status = 'delivered' WHERE id = 1042;",
      'UPDATE orders SET total = 84.00 WHERE id = 1041;',
      'DELETE FROM orders WHERE id = 1040;',
      "INSERT INTO orders (customer_id, status, total) VALUES (88, 'pending', 0.00);",
    ],
  );
  assert.deepEqual(statements.map((s) => s.kind), ['update', 'update', 'delete', 'insert']);
  assert.deepEqual(statements.map((s) => s.row), [0, 1, 2, 'new1']);
});

test('a row edited and then deleted only deletes; empty edits count nothing', () => {
  const changes: ChangeSet = { updates: { 0: { 2: { kind: 'value', text: 'x' } }, 1: {} }, deletes: [0], inserts: [] };
  assert.equal(countChanges(changes), 1);
  assert.deepEqual(
    buildChangeStatements(target('postgres'), rows, changes).map((s) => s.sql),
    ['DELETE FROM orders WHERE id = 1042;'],
  );
});

test('NULL and DEFAULT edits, booleans, quoting per dialect', () => {
  const changes: ChangeSet = {
    updates: {
      0: {
        4: { kind: 'null' },
        5: { kind: 'value', text: 'yes' },
        2: { kind: 'default' },
        3: { kind: 'value', text: 'abc' },
      },
    },
    deletes: [],
    inserts: [],
  };
  assert.equal(
    buildChangeStatements(target('postgres'), rows, changes)[0]!.sql,
    "UPDATE orders SET status = DEFAULT, total = 'abc', note = NULL, paid = TRUE WHERE id = 1042;",
  );
  assert.equal(
    buildChangeStatements(target('mysql', '`acme`.`orders`'), rows, changes)[0]!.sql,
    "UPDATE `acme`.`orders` SET status = DEFAULT, total = 'abc', note = NULL, paid = TRUE WHERE id = 1042;",
  );
  assert.throws(() => buildChangeStatements(target('sqlite'), rows, changes), /SQLite cannot reset "status"/);
  const sqliteChanges: ChangeSet = { updates: { 0: { 5: { kind: 'value', text: 'true' } } }, deletes: [], inserts: [] };
  assert.equal(buildChangeStatements(target('sqlite'), rows, sqliteChanges)[0]!.sql, 'UPDATE orders SET paid = 1 WHERE id = 1042;');
});

test('inserts skip untouched and DEFAULT cells; an empty insert uses the dialect form', () => {
  const nothing: ChangeSet = { updates: {}, deletes: [], inserts: [{ id: 'a', cells: { 0: { kind: 'default' } } }] };
  assert.equal(buildChangeStatements(target('postgres'), rows, nothing)[0]!.sql, 'INSERT INTO orders DEFAULT VALUES;');
  assert.equal(buildChangeStatements(target('mysql'), rows, nothing)[0]!.sql, 'INSERT INTO orders () VALUES ();');
  const typedId: ChangeSet = { updates: {}, deletes: [], inserts: [{ id: 'a', cells: { 0: { kind: 'value', text: '7' }, 4: { kind: 'null' } } }] };
  assert.equal(buildChangeStatements(target('postgres'), rows, typedId)[0]!.sql, 'INSERT INTO orders (id, note) VALUES (7, NULL);');
});

test('whole-row keys and NULL comparisons in WHERE', () => {
  const t = makeEditTarget('postgres', 'orders', tableColumns, [{ name: 'customer_id', numeric: true }, { name: 'note' }], false);
  const statements = buildChangeStatements(t, [[88, null]], { updates: {}, deletes: [0], inserts: [] });
  assert.equal(statements[0]!.sql, 'DELETE FROM orders WHERE customer_id = 88 AND note IS NULL;');
});

test('read-only columns reject edits; stale row indexes fail loudly', () => {
  assert.throws(
    () => buildChangeStatements(target('postgres'), rows, { updates: { 0: { 7: { kind: 'value', text: '1' } } }, deletes: [], inserts: [] }),
    /"total_cents" cannot be edited/,
  );
  assert.throws(
    () => buildChangeStatements(target('postgres'), rows, { updates: {}, deletes: [9], inserts: [] }),
    /Row 10 is no longer on this page/,
  );
  assert.throws(
    () => buildChangeStatements(makeEditTarget('postgres', 'orders', tableColumns, pageColumns, true), rows, { updates: {}, deletes: [0], inserts: [] }),
    /read-only/,
  );
});

test('identifiers that need quoting are quoted per dialect', () => {
  const cols: ColumnModel[] = [
    { name: 'Id', dataType: 'integer', nullable: false, primaryKey: true },
    { name: 'display name', dataType: 'text', nullable: true, primaryKey: false },
  ];
  const page: ColumnInfo[] = [{ name: 'Id', numeric: true }, { name: 'display name' }];
  const changes: ChangeSet = { updates: { 0: { 1: { kind: 'value', text: "O'Hara" } } }, deletes: [], inserts: [] };
  assert.equal(
    buildChangeStatements(makeEditTarget('postgres', '"public"."Channel"', cols, page, false), [[1, 'x']], changes)[0]!.sql,
    `UPDATE "public"."Channel" SET "display name" = 'O''Hara' WHERE "Id" = 1;`,
  );
  assert.equal(
    buildChangeStatements(makeEditTarget('mysql', '`Channel`', cols, page, false), [[1, 'x']], changes)[0]!.sql,
    // MySQL keeps identifier case, so a mixed-case name stays bare there
    "UPDATE `Channel` SET `display name` = 'O''Hara' WHERE Id = 1;",
  );
});

test('valueKind and typedLiteral', () => {
  assert.equal(valueKind('numeric(10,2)'), 'numeric');
  assert.equal(valueKind('bool'), 'boolean');
  assert.equal(valueKind('tinyint(1)'), 'numeric');
  assert.equal(valueKind('interval'), 'text');
  assert.equal(valueKind('varchar(20)', true), 'numeric');
  assert.equal(valueKind(undefined), 'text');
  assert.equal(typedLiteral('postgres', 'numeric', ' 12.5 '), '12.5');
  assert.equal(typedLiteral('postgres', 'numeric', ''), 'NULL');
  assert.equal(typedLiteral('postgres', 'numeric', '1e3'), '1e3');
  assert.equal(typedLiteral('postgres', 'numeric', 'twelve'), "'twelve'");
  assert.equal(typedLiteral('mysql', 'text', 'a\\b'), "'a\\\\b'");
  assert.equal(typedLiteral('sqlite', 'boolean', 'off'), '0');
});
