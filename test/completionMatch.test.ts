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
  assert.deepEqual(wordBeforeCaret('status = cust', 13, 'postgres'), { start: 9, prefix: 'cust', inString: false });
  assert.deepEqual(wordBeforeCaret('o.cu', 4, 'postgres'), { start: 2, prefix: 'cu', inString: false });
  assert.deepEqual(wordBeforeCaret('total > 10 ', 11, 'postgres'), { start: 11, prefix: '', inString: false });
  assert.equal(wordBeforeCaret("status = 'sh", 12, 'postgres').inString, true, 'inside a string literal');
  assert.equal(wordBeforeCaret("status = 'shipped' AND to", 25, 'postgres').inString, false, 'after a closed string');
  assert.deepEqual(wordBeforeCaret('"Disp', 5, 'postgres'), { start: 0, prefix: '"Disp', inString: false }, 'opening quote belongs to the word');
  assert.deepEqual(wordBeforeCaret('"Display Name" = x', 18, 'postgres'), { start: 17, prefix: 'x', inString: false });
});

test('on mysql a double quote opens a string literal, not an identifier', () => {
  assert.deepEqual(wordBeforeCaret('status = "an', 12, 'mysql'), { start: 10, prefix: 'an', inString: true });
  assert.deepEqual(wordBeforeCaret('status = "or', 12, 'mysql'), { start: 10, prefix: 'or', inString: true });
  assert.equal(wordBeforeCaret('status = "shipped" AND to', 25, 'mysql').inString, false, 'after a closed literal');
  assert.deepEqual(wordBeforeCaret('`Disp', 5, 'mysql'), { start: 0, prefix: '`Disp', inString: false }, 'backticks still quote a name');
  assert.deepEqual(wordBeforeCaret('status = "an', 12, 'postgres'), { start: 9, prefix: '"an', inString: false });
  assert.deepEqual(wordBeforeCaret('status = "an', 12, 'sqlite'), { start: 9, prefix: '"an', inString: false });
});

test('completionReplacement never extends over a mysql double quote', () => {
  const programs = entry('Programs', '1Programs', { kind: 'table' });
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM "', '"', 'mysql'), {
    insertText: 'Programs',
    extendStart: 0,
    extendEnd: 0,
  });
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM `', '`', 'mysql'), {
    insertText: '`Programs`',
    extendStart: 1,
    extendEnd: 1,
    filterText: '`Programs',
  });
  assert.equal(completionReplacement(programs, 'SELECT * FROM "', '"', 'postgres').extendStart, 1);
});

test('the lookup reads quotes the way the tokenizer does', () => {
  assert.equal(wordBeforeCaret("name = 'O\\'Br", 13, 'mysql').inString, true, 'MySQL backslash escapes keep the literal open');
  assert.equal(wordBeforeCaret("path = 'C:\\' AND stat", 21, 'mysql').inString, true);
  assert.deepEqual(wordBeforeCaret("note = 'it\\'s ord", 17, 'mysql'), { start: 14, prefix: 'ord', inString: true });
  assert.equal(wordBeforeCaret("name = 'O\\'Br", 13, 'postgres').inString, false, 'PostgreSQL closes the literal at the quote');
  assert.equal(wordBeforeCaret("name = 'O''Br", 13, 'postgres').inString, true, 'a doubled quote does not close it');
  assert.equal(wordBeforeCaret("id > 1 /* customer's */ AND st", 30, 'postgres').inString, false, 'an apostrophe inside a comment is not a literal');
  assert.equal(wordBeforeCaret('id > 1 /* open ', 15, 'postgres').inString, true, 'nothing completes inside an unterminated comment');
});

test('completionReplacement sees the quote through comments and escapes', () => {
  const programs = entry('Programs', '1Programs', { kind: 'table' });
  assert.deepEqual(completionReplacement(programs, 'SELECT /* customer\'s */ * FROM "', '"', 'postgres'), {
    insertText: '"Programs"',
    extendStart: 1,
    extendEnd: 1,
    filterText: '"Programs',
  });
  assert.deepEqual(completionReplacement(programs, "SELECT 'a''b' FROM \"", '"', 'postgres'), {
    insertText: '"Programs"',
    extendStart: 1,
    extendEnd: 1,
    filterText: '"Programs',
  });
  assert.deepEqual(completionReplacement(programs, "SELECT 'C:\\' FROM `", '`', 'mysql'), {
    insertText: 'Programs',
    extendStart: 0,
    extendEnd: 0,
  }, 'the backtick is still inside the MySQL literal');
});

test('sqlite backticks quote an identifier, postgres backticks do not', () => {
  const programs = entry('Programs', '1Programs', { kind: 'table', insertText: '"Programs"' });
  assert.deepEqual(wordBeforeCaret('SELECT * FROM `Prog', 19, 'sqlite'), { start: 14, prefix: '`Prog', inString: false });
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM `', '`', 'sqlite'), {
    insertText: '`Programs`',
    extendStart: 1,
    extendEnd: 1,
    filterText: '`Programs',
  });
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM "', '"', 'sqlite'), {
    insertText: '"Programs"',
    extendStart: 1,
    extendEnd: 1,
    filterText: '"Programs',
  });
  assert.deepEqual(wordBeforeCaret('SELECT * FROM `Prog', 19, 'postgres'), { start: 15, prefix: 'Prog', inString: false });
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM `', '', 'postgres'), {
    insertText: '"Programs"',
    extendStart: 0,
    extendEnd: 0,
  });
});

test('a quoted name with a space is replaced from its opening quote', () => {
  const details = entry('Order Details', '1Order Details', { kind: 'table', insertText: '"Order Details"' });
  assert.deepEqual(completionReplacement(details, 'SELECT * FROM "Order ', '', 'postgres'), {
    insertText: '"Order Details"',
    extendStart: 7,
    extendEnd: 0,
    filterText: '"Order Details',
  });
  assert.deepEqual(completionReplacement(details, 'SELECT * FROM `Order ', '`', 'mysql'), {
    insertText: '`Order Details`',
    extendStart: 7,
    extendEnd: 1,
    filterText: '`Order Details',
  });
  const word = wordBeforeCaret('name = "Order Det', 17, 'postgres');
  assert.deepEqual(word, { start: 7, prefix: '"Order Det', inString: false });
  assert.deepEqual(applyCompletion('name = "Order Det', 17, word, details), { text: 'name = "Order Details"', caret: 22 });
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
  const word = wordBeforeCaret('status = cust', 13, 'postgres');
  assert.deepEqual(applyCompletion('status = cust', 13, word, entry('customer_id')), { text: 'status = customer_id', caret: 20 });
  const quoted = wordBeforeCaret('"Disp', 5, 'postgres');
  assert.deepEqual(applyCompletion('"Disp', 5, quoted, entry('Display Name', '0', { insertText: '"Display Name"' })), {
    text: '"Display Name"',
    caret: 14,
  });
  const fn = entry('count', '5count', { kind: 'function', insertText: 'count($1)', snippet: true });
  assert.deepEqual(applyCompletion('cou > 1', 3, wordBeforeCaret('cou > 1', 3, 'postgres'), fn), { text: 'count() > 1', caret: 6 });
  const template = entry('sel', '0tsel', { kind: 'template', insertText: 'SELECT * FROM ${1:table}', snippet: true });
  assert.deepEqual(applyCompletion('sel', 3, wordBeforeCaret('sel', 3, 'postgres'), template), { text: 'SELECT * FROM table', caret: 14 });
});

test('completionReplacement keeps a quote the user already typed instead of doubling it', () => {
  const programs = entry('Programs', '1Programs', { kind: 'table', insertText: '"Programs"' });
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM "', '"', 'postgres'), {
    insertText: '"Programs"',
    extendStart: 1,
    extendEnd: 1,
    filterText: '"Programs',
  });
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM "', ' WHERE 1', 'postgres'), {
    insertText: '"Programs"',
    extendStart: 1,
    extendEnd: 0,
    filterText: '"Programs',
  });
  assert.deepEqual(completionReplacement(entry('customers', '1', { kind: 'table' }), 'FROM "', '"', 'postgres'), {
    insertText: '"customers"',
    extendStart: 1,
    extendEnd: 1,
    filterText: '"customers',
  });
  assert.deepEqual(completionReplacement(entry('orders', '1', { kind: 'table' }), 'FROM `', '`', 'mysql').insertText, '`orders`');
  assert.equal(completionReplacement(entry('Odd"Name', '1', { kind: 'table' }), 'FROM "', '', 'postgres').insertText, '"Odd""Name"');
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM ', '', 'postgres'), { insertText: '"Programs"', extendStart: 0, extendEnd: 0 });
  const keyword = entry('WHERE', '4WHERE', { kind: 'keyword' });
  assert.deepEqual(completionReplacement(keyword, 'x = "', '"', 'postgres'), { insertText: 'WHERE', extendStart: 0, extendEnd: 0 });
});

test('completionReplacement tells a closing quote from an opening one', () => {
  const programs = entry('Programs', '1Programs', { kind: 'table', insertText: '"Programs"' });
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM "Programs"', '', 'postgres'), {
    insertText: '"Programs"',
    extendStart: 0,
    extendEnd: 0,
  });
  assert.deepEqual(completionReplacement(programs, 'SELECT * FROM "', '"', 'postgres'), {
    insertText: '"Programs"',
    extendStart: 1,
    extendEnd: 1,
    filterText: '"Programs',
  });
  assert.deepEqual(completionReplacement(programs, 'SELECT "a", "b" FROM "', '"', 'postgres').extendStart, 1, 'earlier closed pairs do not count');
  const orders = entry('orders', '1orders', { kind: 'table' });
  assert.deepEqual(completionReplacement(orders, 'SELECT * FROM `orders`', '', 'mysql'), { insertText: 'orders', extendStart: 0, extendEnd: 0 });
  assert.deepEqual(completionReplacement(orders, 'SELECT * FROM `', '`', 'mysql'), {
    insertText: '`orders`',
    extendStart: 1,
    extendEnd: 1,
    filterText: '`orders',
  });
});
