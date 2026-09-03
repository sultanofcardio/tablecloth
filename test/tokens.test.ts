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

test('dialect multi-character operators stay atomic', () => {
  assert.ok(kinds('SELECT a <=> b', 'mysql').includes('punct:<=>'));
  assert.ok(kinds('SELECT f(a => 1)', 'postgres').includes('punct:=>'));
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

const texts = (sql: string, dialect: 'postgres' | 'mysql' | 'sqlite' = 'postgres') =>
  significant(tokenize(sql, dialect)).map((t) => `${t.kind}:${t.text}`);

test('prefixed string literals are one string token', () => {
  assert.deepEqual(texts("SELECT E'\\n', U&'d\\0061t', X'0A', B'01', N'abc'"), [
    'word:SELECT', "string:E'\\n'", 'punct:,', "string:U&'d\\0061t'", 'punct:,', "string:X'0A'", 'punct:,', "string:B'01'", 'punct:,', "string:N'abc'",
  ]);
  // backslash escapes are live inside E'' so the escaped quote does not end the string
  assert.deepEqual(texts("SELECT E'it\\'s', 2"), ['word:SELECT', "string:E'it\\'s'", 'punct:,', 'number:2']);
  // the prefix letters are case-insensitive
  assert.deepEqual(texts("SELECT x'0a', b'1', n'x'", 'sqlite'), ['word:SELECT', "string:x'0a'", 'punct:,', "string:b'1'", 'punct:,', "string:n'x'"]);
  assert.deepEqual(texts("SELECT _utf8mb4'abc', X'0A'", 'mysql'), ['word:SELECT', "string:_utf8mb4'abc'", 'punct:,', "string:X'0A'"]);
  // an alias-like word separated by a space stays a word followed by a string
  assert.deepEqual(texts("SELECT e 'x'"), ['word:SELECT', 'word:e', "string:'x'"]);
  assert.deepEqual(texts("SELECT _u 'x'", 'mysql'), ['word:SELECT', 'word:_u', "string:'x'"]);
});

test('hex and binary numeric literals are one number token', () => {
  for (const dialect of ['postgres', 'mysql', 'sqlite'] as const) {
    assert.deepEqual(texts('SELECT 0x1F, 0X1f, 0b101, 0B01, 10', dialect), [
      'word:SELECT', 'number:0x1F', 'punct:,', 'number:0X1f', 'punct:,', 'number:0b101', 'punct:,', 'number:0B01', 'punct:,', 'number:10',
    ]);
  }
});

test('mysql user and system variables are atomic', () => {
  assert.deepEqual(texts("SELECT @user_id, @@session.sql_mode, @@global.x, @'quoted', @`quoted`, @@SQL_MODE", 'mysql'), [
    'word:SELECT', 'variable:@user_id', 'punct:,', 'variable:@@session.sql_mode', 'punct:,', 'variable:@@global.x', 'punct:,',
    "variable:@'quoted'", 'punct:,', 'variable:@`quoted`', 'punct:,', 'variable:@@SQL_MODE',
  ]);
  assert.deepEqual(kinds('SET @A = 1', 'mysql'), ['word:set', 'variable:@a', 'punct:=', 'number:1']);
  // in Postgres @ is an operator
  assert.deepEqual(texts('SELECT @ -5'), ['word:SELECT', 'punct:@', 'punct:-', 'number:5']);
});

test('postgres operators are a maximal run of operator characters', () => {
  const ops = ['<->', '@@', '@?', '|/', '^@', '?-', '-|-', '<<|', '&<', '?#', '##', '!~~*', '->>', '#>>', '<@', '=>', '||', '<>', '!='];
  for (const op of ops) {
    assert.deepEqual(texts(`a ${op} b`), ['word:a', `punct:${op}`, 'word:b'], op);
  }
  // a run may only end in + or - when it contains one of ~ ! @ # % ^ & | ` ?
  assert.deepEqual(texts('1+-2'), ['number:1', 'punct:+', 'punct:-', 'number:2']);
  assert.deepEqual(texts('a<-1'), ['word:a', 'punct:<', 'punct:-', 'number:1']);
  assert.deepEqual(texts('x=-1'), ['word:x', 'punct:=', 'punct:-', 'number:1']);
  assert.deepEqual(texts('a @- b'), ['word:a', 'punct:@-', 'word:b']);
  // comment openers are never absorbed into an operator
  assert.deepEqual(texts('a=--c\nb'), ['word:a', 'punct:=', 'word:b']);
  assert.deepEqual(texts('a=/*c*/b'), ['word:a', 'punct:=', 'word:b']);
  // :: and := remain single tokens and :name parameters still work
  assert.deepEqual(texts('a::int, b := :name'), ['word:a', 'punct:::', 'word:int', 'punct:,', 'word:b', 'punct::=', 'param::name']);
});

test('mysql and sqlite keep the fixed operator list', () => {
  assert.deepEqual(texts('a <=> b, c := d, j -> 1, j ->> 2', 'mysql'), [
    'word:a', 'punct:<=>', 'word:b', 'punct:,', 'word:c', 'punct::=', 'word:d', 'punct:,', 'word:j', 'punct:->', 'number:1', 'punct:,', 'word:j', 'punct:->>', 'number:2',
  ]);
  assert.deepEqual(texts('a <-> b', 'sqlite'), ['word:a', 'punct:<', 'punct:->', 'word:b']);
});
