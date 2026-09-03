import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CompletionEntry } from '../src/complete/core';
import { applyCompletion, completionReplacement, matchedIndexes, rankEntries, wordBeforeCaret } from '../src/complete/match';

const entry = (label: string, sortText = '0' + label, extra: Partial<CompletionEntry> = {}): CompletionEntry => ({
  label,
  kind: 'column',
  sortText,
  ...extra,
});

test('wordBeforeCaret finds the identifier fragment, a qualifier, and string literals', () => {
  assert.deepEqual(wordBeforeCaret('status = cust', 13), { start: 9, prefix: 'cust', inString: false });
  assert.deepEqual(wordBeforeCaret('o.cu', 4), { start: 2, prefix: 'cu', inString: false });
  assert.deepEqual(wordBeforeCaret('total > 10 ', 11), { start: 11, prefix: '', inString: false });
  assert.equal(wordBeforeCaret("status = 'sh", 12).inString, true, 'inside a string literal');
  assert.equal(wordBeforeCaret("status = 'shipped' AND to", 25).inString, false, 'after a closed string');
  assert.deepEqual(wordBeforeCaret('"Disp', 5), { start: 0, prefix: '"Disp', inString: false }, 'opening quote belongs to the word');
  assert.deepEqual(wordBeforeCaret('"Display Name" = x', 18), { start: 17, prefix: 'x', inString: false });
});

test('rankEntries puts prefix matches first, then word starts, then substrings', () => {
  const entries = [entry('account_id'), entry('customer_id'), entry('created_at'), entry('id'), entry('DISTINCT', '4DISTINCT', { kind: 'keyword' })];
  assert.deepEqual(
    rankEntries(entries, 'id').map((e) => e.label),
    ['id', 'account_id', 'customer_id'],
    'exact prefix, then names whose word starts with it',
  );
  assert.deepEqual(rankEntries(entries, 'ci').map((e) => e.label), ['customer_id'], 'word starts: c(ustomer_)i(d)');
  assert.deepEqual(rankEntries(entries, 'st').map((e) => e.label), ['customer_id', 'DISTINCT'], 'substring matches last');
  assert.deepEqual(rankEntries(entries, 'zz'), []);
  assert.deepEqual(
    rankEntries(entries, '').map((e) => e.label),
    ['account_id', 'created_at', 'customer_id', 'id', 'DISTINCT'],
    'no prefix keeps the provider order (sortText)',
  );
  assert.deepEqual(rankEntries([entry('Display Name')], '"dis').map((e) => e.label), ['Display Name'], 'quoted prefix matches the bare name');
});

test('matchedIndexes highlights the characters the prefix matched', () => {
  assert.deepEqual(matchedIndexes('customer_id', 'cust'), [0, 1, 2, 3]);
  assert.deepEqual(matchedIndexes('customer_id', 'ci'), [0, 9]);
  assert.deepEqual(matchedIndexes('customer_id', 'omer'), [4, 5, 6, 7]);
  assert.equal(matchedIndexes('customer_id', 'zz'), null);
  assert.deepEqual(matchedIndexes('customer_id', ''), []);
});

test('applyCompletion replaces the word and expands snippets', () => {
  const word = wordBeforeCaret('status = cust', 13);
  assert.deepEqual(applyCompletion('status = cust', 13, word, entry('customer_id')), { text: 'status = customer_id', caret: 20 });
  const quoted = wordBeforeCaret('"Disp', 5);
  assert.deepEqual(applyCompletion('"Disp', 5, quoted, entry('Display Name', '0', { insertText: '"Display Name"' })), {
    text: '"Display Name"',
    caret: 14,
  });
  const fn = entry('count', '5count', { kind: 'function', insertText: 'count($1)', snippet: true });
  assert.deepEqual(applyCompletion('cou > 1', 3, wordBeforeCaret('cou > 1', 3), fn), { text: 'count() > 1', caret: 6 });
  const template = entry('sel', '0tsel', { kind: 'template', insertText: 'SELECT * FROM ${1:table}', snippet: true });
  assert.deepEqual(applyCompletion('sel', 3, wordBeforeCaret('sel', 3), template), { text: 'SELECT * FROM table', caret: 14 });
});

test('completionReplacement keeps a quote the user already typed instead of doubling it', () => {
  const programs = entry('Programs', '1Programs', { kind: 'table', insertText: '"Programs"' });
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM "', '"'), {
    insertText: '"Programs"',
    extendStart: 1,
    extendEnd: 1,
    filterText: '"Programs',
  });
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM "', ' WHERE 1'), {
    insertText: '"Programs"',
    extendStart: 1,
    extendEnd: 0,
    filterText: '"Programs',
  });
  assert.deepEqual(completionReplacement(entry('customers', '1', { kind: 'table' }), 'FROM "', '"'), {
    insertText: '"customers"',
    extendStart: 1,
    extendEnd: 1,
    filterText: '"customers',
  });
  assert.deepEqual(completionReplacement(entry('orders', '1', { kind: 'table' }), 'FROM `', '`').insertText, '`orders`');
  assert.equal(completionReplacement(entry('Odd"Name', '1', { kind: 'table' }), 'FROM "', '').insertText, '"Odd""Name"');
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM ', ''), { insertText: '"Programs"', extendStart: 0, extendEnd: 0 });
  const keyword = entry('WHERE', '4WHERE', { kind: 'keyword' });
  assert.deepEqual(completionReplacement(keyword, 'x = "', '"'), { insertText: 'WHERE', extendStart: 0, extendEnd: 0 });
});
