import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlName } from '../src/core/util';
import { isCancellationError } from '../src/drivers/driver';
import { tableDistinctQuery, wrapDistinct } from '../src/sql/paging';

test('sqlName quotes keywords and every dialect\'s reserved words, and leaves plain names bare', () => {
  for (const name of ['rank', 'system', 'option', 'usage', 'dense_rank', 'div', 'ignore', 'keys', 'change', 'convert', 'order']) {
    assert.equal(sqlName('mysql', name), '`' + name + '`', name);
    assert.equal(sqlName('postgres', name), `"${name}"`, name);
  }
  for (const name of ['current_schema', 'current_role', 'analyse', 'asymmetric', 'freeze', 'user']) {
    assert.equal(sqlName('postgres', name), `"${name}"`, name);
    assert.equal(sqlName('sqlite', name), `"${name}"`, name);
  }
  assert.equal(sqlName('postgres', 'status'), 'status');
  assert.equal(sqlName('mysql', 'Status'), 'Status');
  assert.equal(sqlName('postgres', 'Status'), '"Status"');
  assert.equal(sqlName('sqlite', 'total_cents'), 'total_cents');
});

test('funnel distinct queries quote reserved column names', () => {
  assert.match(tableDistinctQuery('mysql', undefined, 't', 'rank', undefined, 10), /SELECT DISTINCT `rank` FROM `t`\nORDER BY `rank` LIMIT 10$/);
  assert.match(wrapDistinct('postgres', 'select * from t', 'order', undefined, 10), /SELECT DISTINCT "order" FROM/);
});

test('isCancellationError recognises the engines\' cancelled-statement errors only', () => {
  assert.ok(isCancellationError(Object.assign(new Error('canceling statement due to user request'), { code: '57014' })));
  assert.ok(isCancellationError(Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED', errno: 1317 })));
  assert.ok(!isCancellationError(Object.assign(new Error('syntax error at or near "selec"'), { code: '42601' })));
  assert.ok(!isCancellationError(new Error('connection terminated')));
  assert.ok(!isCancellationError(undefined));
  assert.ok(!isCancellationError('cancelled'));
});
