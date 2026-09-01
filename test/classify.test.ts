import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatement } from '../src/sql/classify';

test('classifies select-ish statements', () => {
  for (const sql of [
    'SELECT * FROM t',
    '  select 1',
    '-- comment\nSELECT 1',
    '/* c */ VALUES (1)',
    'SHOW databases',
    'EXPLAIN SELECT 1',
    'PRAGMA table_info(x)',
    'WITH x AS (SELECT 1) SELECT * FROM x',
  ]) {
    assert.equal(classifyStatement(sql).selectish, true, sql);
  }
});

test('classifies mutating statements', () => {
  for (const sql of [
    'INSERT INTO t VALUES (1)',
    'update t set a = 1',
    'DELETE FROM t',
    'CREATE TABLE t (a int)',
    'DROP TABLE t',
    'TRUNCATE t',
    'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
  ]) {
    const cls = classifyStatement(sql);
    assert.equal(cls.mutating, true, sql);
    assert.equal(cls.selectish, false, sql);
  }
});

test('keyword extraction skips leading comments', () => {
  assert.equal(classifyStatement('-- hello\n\n/* x */ SELECT 1').keyword, 'select');
});
