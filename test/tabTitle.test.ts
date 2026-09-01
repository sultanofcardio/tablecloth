import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultTabTitle } from '../src/console/tabTitle';
import type { ConsoleBinding } from '../src/core/types';

const binding: ConsoleBinding = { dataSourceId: 'x', database: 'kgtv', schema: 'public' };
const counter = () => 7;

test('single-table select is named db.schema.table', () => {
  assert.equal(resultTabTitle('SELECT * FROM "Channel"', binding, counter), 'kgtv.public.Channel');
  assert.equal(resultTabTitle('SELECT * FROM programs', binding, counter), 'kgtv.public.programs');
});

test('a schema-qualified table keeps its own schema', () => {
  assert.equal(resultTabTitle('SELECT * FROM audit.events', binding, counter), 'kgtv.audit.events');
});

test('joins and table-less selects fall back to Result n', () => {
  assert.equal(
    resultTabTitle('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id', binding, counter),
    'Result 7',
  );
  assert.equal(resultTabTitle('SELECT 1 + 1', binding, counter), 'Result 7');
});

test('a comment directly above the statement names the tab', () => {
  assert.equal(resultTabTitle('-- upcoming shows\nSELECT * FROM programs', binding, counter), 'upcoming shows');
  assert.equal(resultTabTitle('/* channel lineup */\nSELECT * FROM "Channel"', binding, counter), 'channel lineup');
});

test('long comments are trimmed', () => {
  const long = '-- ' + 'x'.repeat(80) + '\nSELECT 1';
  assert.equal(resultTabTitle(long, binding, counter).length, 40);
});

test('missing binding still names sensibly', () => {
  assert.equal(resultTabTitle('SELECT * FROM main.items', undefined, counter), 'main.items');
});
