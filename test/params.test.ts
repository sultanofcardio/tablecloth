import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindParameters, findParameters, parameterNames } from '../src/sql/params';

test('named parameters are found outside strings, comments, and casts', () => {
  const sql = "SELECT ':nope' AS s, a::text, x -- :also_no\nFROM t WHERE id = :id AND name = ${name} AND id <> :id";
  const refs = findParameters(sql, 'postgres');
  assert.deepEqual(refs.map((r) => r.name), ['id', 'name', 'id']);
  assert.deepEqual(parameterNames(refs), ['id', 'name']);
});

test('positional marks: ? in mysql/sqlite, $n in postgres, and ? is an operator in postgres', () => {
  assert.deepEqual(findParameters('SELECT ? , ?', 'mysql').map((r) => r.name), ['?1', '?2']);
  assert.deepEqual(findParameters('SELECT ?', 'sqlite').map((r) => r.name), ['?1']);
  assert.deepEqual(findParameters('SELECT $1, $2', 'postgres').map((r) => r.name), ['1', '2']);
  assert.deepEqual(findParameters("SELECT j ? 'k'", 'postgres'), []);
});

test('bindParameters rewrites to driver placeholders', () => {
  const sql = 'SELECT * FROM t WHERE a = :a AND b = :b AND c = :a';
  const pg = bindParameters(sql, 'postgres', findParameters(sql, 'postgres'), { a: '1', b: 'x' });
  assert.equal(pg.text, 'SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $1');
  assert.deepEqual(pg.values, ['1', 'x']);

  const my = bindParameters(sql, 'mysql', findParameters(sql, 'mysql'), { a: '1', b: null });
  assert.equal(my.text, 'SELECT * FROM t WHERE a = ? AND b = ? AND c = ?');
  assert.deepEqual(my.values, ['1', null, '1']);

  const none = bindParameters('SELECT 1', 'postgres', [], {});
  assert.deepEqual(none, { text: 'SELECT 1', values: [] });
});

test('missing values bind as NULL', () => {
  const sql = 'SELECT :x';
  const bound = bindParameters(sql, 'postgres', findParameters(sql, 'postgres'), {});
  assert.deepEqual(bound.values, [null]);
});
