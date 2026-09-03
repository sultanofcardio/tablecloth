import { test } from 'node:test';
import assert from 'node:assert/strict';
import { significant, tokenize } from '../src/sql/tokens';

const kinds = (sql: string, dialect: 'postgres' | 'mysql' | 'sqlite' = 'postgres') =>
  significant(tokenize(sql, dialect)).map((t) => `${t.kind}:${t.value}`);

test('words, identifiers, strings, numbers, operators', () => {
  assert.deepEqual(kinds(`SELECT "Name", 'it''s', 1.5e3, a::text FROM t WHERE x <> 2`), [
    'word:select',
    'ident:Name',
    'punct:,',
    "string:'it''s'",
    'punct:,',
    'number:1.5e3',
    'punct:,',
    'word:a',
    'punct:::',
    'word:text',
    'word:from',
    'word:t',
    'word:where',
    'word:x',
    'punct:<>',
    'number:2',
  ]);
});

test('comments are trivia and round-trip', () => {
  const sql = '-- hi\nSELECT /* nested /* deep */ */ 1 # not a comment in pg';
  const all = tokenize(sql, 'postgres');
  assert.equal(all.map((t) => t.text).join(''), sql);
  assert.deepEqual(
    all.filter((t) => t.kind === 'comment').map((t) => t.text),
    ['-- hi', '/* nested /* deep */ */'],
  );
  assert.ok(kinds('SELECT 1 # c', 'mysql').includes('number:1'));
  assert.ok(!kinds('SELECT 1 # c', 'mysql').some((k) => k.startsWith('word:c')));
});

test('parameters per dialect', () => {
  assert.deepEqual(kinds('WHERE id = :id AND x = ${name} AND y::int = $1'), [
    'word:where', 'word:id', 'punct:=', 'param:id', 'word:and', 'word:x', 'punct:=', 'param:name',
    'word:and', 'word:y', 'punct:::', 'word:int', 'punct:=', 'param:1',
  ]);
  assert.deepEqual(kinds('WHERE id = ?', 'mysql'), ['word:where', 'word:id', 'punct:=', 'param:?']);
  // ? is the jsonb operator in Postgres, never a parameter
  assert.deepEqual(kinds("WHERE j ? 'k'"), ['word:where', 'word:j', 'punct:?', "string:'k'"]);
});

test('dollar quotes and backticks', () => {
  assert.deepEqual(kinds('SELECT $$a;b$$, $fn$x$fn$'), ['word:select', 'string:$$a;b$$', 'punct:,', 'string:$fn$x$fn$']);
  assert.deepEqual(kinds('SELECT `a``b` FROM `t`', 'mysql'), ['word:select', 'ident:a`b', 'word:from', 'ident:t']);
});

test('unterminated string runs to the end without throwing', () => {
  const tokens = tokenize("SELECT 'oops", 'postgres');
  assert.equal(tokens[tokens.length - 1]!.kind, 'string');
});
