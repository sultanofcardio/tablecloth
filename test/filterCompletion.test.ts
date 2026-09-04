import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFilterCompletions, type CompletionEntry, type CompletionKind } from '../src/complete/core';
import { applyCompletion, rankEntries, wordBeforeCaret } from '../src/complete/match';
import type { CatalogModel } from '../src/core/types';

const catalog: CatalogModel = {
  serverVersion: 'PostgreSQL 17',
  introspectedAt: 0,
  databases: [
    {
      name: 'acme',
      allSchemaNames: ['public'],
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
                { name: 'customer_id', dataType: 'bigint', nullable: false, primaryKey: false, foreignKeyTarget: 'customers' },
                { name: 'status', dataType: 'text', nullable: false, primaryKey: false },
                { name: 'Display Name', dataType: 'text', nullable: true, primaryKey: false },
              ],
            },
            {
              name: 'customers',
              kind: 'table',
              indexes: [],
              columns: [
                { name: 'id', dataType: 'bigint', nullable: false, primaryKey: true },
                { name: 'email', dataType: 'text', nullable: false, primaryKey: false },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const labels = (entries: CompletionEntry[]) => entries.map((e) => e.label);
const ofKind = (entries: CompletionEntry[], kind: CompletionKind) => entries.filter((e) => e.kind === kind).map((e) => e.label);
const orders = { catalog, table: '"public"."orders"' };

test('an empty WHERE field offers the table columns first, then keywords and functions', () => {
  const entries = computeFilterCompletions(orders, 'postgres', 'where', '', 0);
  assert.deepEqual(labels(entries).slice(0, 4), ['id', 'customer_id', 'status', 'Display Name']);
  assert.ok(ofKind(entries, 'function').includes('count'));
  assert.ok(ofKind(entries, 'table').includes('customers'), 'other tables stay available for subqueries');
  assert.equal(entries.find((e) => e.label === 'Display Name')?.insertText, '"Display Name"', 'names Postgres would fold get quoted');
  assert.equal(entries.find((e) => e.label === 'customer_id')?.detail, 'bigint · FK → customers');
});

test('after a comparison the columns come back; after a value the clause keywords do', () => {
  const afterEq = computeFilterCompletions(orders, 'postgres', 'where', 'status = ', 9);
  assert.ok(ofKind(afterEq, 'column').includes('customer_id'));
  const afterValue = computeFilterCompletions(orders, 'postgres', 'where', 'id > 10 ', 8);
  const keywords = ofKind(afterValue, 'keyword');
  assert.ok(keywords.includes('AND') && keywords.includes('OR'));
});

test('the caret position, not the end of the text, decides the context', () => {
  const entries = computeFilterCompletions(orders, 'postgres', 'where', 'cust AND id > 1', 4);
  assert.deepEqual(labels(entries).slice(0, 4), ['id', 'customer_id', 'status', 'Display Name']);
});

test('a mysql double-quoted literal being typed neither opens the lookup nor is rewritten', () => {
  const source = { catalog, table: 'orders' };
  for (const text of ['status = "an', 'status = "n', 'status = "or']) {
    const word = wordBeforeCaret(text, text.length, 'mysql');
    assert.equal(word.inString, true, `${text} is inside a literal`);
    const shown = rankEntries(computeFilterCompletions(source, 'mysql', 'where', text, text.length), word.prefix);
    assert.ok(applyCompletion(text, text.length, word, shown[0]!).text.startsWith('status = "'), 'the opening quote survives an accept');
  }
  const postgres = 'status = "Disp';
  const word = wordBeforeCaret(postgres, postgres.length, 'postgres');
  assert.deepEqual({ prefix: word.prefix, inString: word.inString }, { prefix: '"Disp', inString: false });
  const shown = rankEntries(computeFilterCompletions(orders, 'postgres', 'where', postgres, postgres.length), word.prefix);
  assert.equal(shown[0]?.label, 'Display Name');
  assert.equal(applyCompletion(postgres, postgres.length, word, shown[0]!).text, 'status = "Display Name"');
});

test('a qualifier lists that table', () => {
  assert.deepEqual(labels(computeFilterCompletions(orders, 'postgres', 'where', 'customers.', 10)), ['id', 'email']);
});

test('ORDER BY completes columns, then sort directions before other keywords', () => {
  const start = computeFilterCompletions(orders, 'postgres', 'orderBy', '', 0);
  assert.deepEqual(labels(start).slice(0, 3), ['id', 'customer_id', 'status']);
  const after = computeFilterCompletions(orders, 'postgres', 'orderBy', 'status ', 7);
  // the lookup orders entries by sortText, so that is the order that matters
  const keywords = ofKind([...after].sort((a, b) => a.sortText.localeCompare(b.sortText)), 'keyword');
  assert.deepEqual(keywords.slice(0, 4), ['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST']);
  assert.equal(keywords.includes('DEFAULT'), false, 'clause keywords from other statement parts stay out');
  assert.equal(keywords.includes('LIMIT'), false);
  const mysql = computeFilterCompletions({ catalog, table: 'orders' }, 'mysql', 'orderBy', 'status ', 7);
  assert.equal(ofKind(mysql, 'keyword').includes('NULLS LAST'), false, 'MySQL has no NULLS clause');
});

test('the WHERE field keeps only the keywords a condition can use', () => {
  const afterValue = computeFilterCompletions(orders, 'postgres', 'where', 'id > 10 ', 8);
  const keywords = ofKind(afterValue, 'keyword');
  assert.ok(keywords.includes('AND') && keywords.includes('OR'));
  assert.equal(keywords.includes('IS NULL'), false, 'operators only follow a name');
  const afterName = ofKind(computeFilterCompletions(orders, 'postgres', 'where', 'status ', 7), 'keyword');
  assert.ok(afterName.includes('IS NULL') && afterName.includes('LIKE'));
  for (const stray of ['LIMIT', 'ORDER BY', 'GROUP BY', 'DEFAULT', 'PRIMARY KEY', 'SET', 'ASC']) {
    assert.equal(keywords.includes(stray), false, `${stray} is not offered in WHERE`);
  }
});

test('a result without a catalog relation completes from its own columns only', () => {
  const columns = [{ name: 'order_count', dataType: 'bigint' }, { name: 'email' }, { name: 'email' }];
  const entries = computeFilterCompletions({ columns }, 'mysql', 'where', '', 0);
  assert.deepEqual(ofKind(entries, 'column'), ['order_count', 'email'], 'duplicate result columns appear once');
  assert.equal(entries.some((e) => e.kind === 'table' || e.kind === 'view' || e.kind === 'schema'), false);
  assert.ok(ofKind(entries, 'function').includes('count'));
});
