import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeOrderBy, funnelClause, mergeWhere, parseOrderBy, quoteName, sortMark, toggleSort } from '../src/webview/grid/filters';

test('parseOrderBy reads names, quotes, directions, and NULLS placement', () => {
  assert.deepEqual(parseOrderBy('id DESC, "Display Name", total asc nulls last'), [
    { column: 'id', direction: 'desc' },
    { column: 'Display Name', direction: 'asc' },
    { column: 'total', direction: 'asc' },
  ]);
  assert.deepEqual(parseOrderBy(''), []);
  assert.deepEqual(parseOrderBy('coalesce(a, b) DESC'), [{ column: 'coalesce(a, b)', direction: 'desc' }]);
});

test('header clicks cycle none -> ASC -> DESC -> none and replace the ORDER BY', () => {
  assert.equal(toggleSort('postgres', '', 'id', false), 'id');
  assert.equal(toggleSort('postgres', 'id', 'id', false), 'id DESC');
  assert.equal(toggleSort('postgres', 'id DESC', 'id', false), '');
  assert.equal(toggleSort('postgres', 'created_at DESC', 'id', false), 'id', 'a plain click replaces other sort columns');
});

test('Alt-click adds and updates a column in a multi-column sort', () => {
  assert.equal(toggleSort('postgres', 'created_at DESC', 'id', true), 'created_at DESC, id');
  assert.equal(toggleSort('postgres', 'created_at DESC, id', 'id', true), 'created_at DESC, id DESC');
  assert.equal(toggleSort('postgres', 'created_at DESC, id DESC', 'created_at', true), 'id DESC');
  assert.deepEqual(sortMark('created_at DESC, id', 'id'), { direction: 'asc', index: 2 });
  assert.deepEqual(sortMark('id', 'id'), { direction: 'asc', index: 0 });
  assert.equal(sortMark('id', 'total'), undefined);
});

test('names are quoted only when the dialect would fold or reject them', () => {
  assert.equal(quoteName('postgres', 'Display Name'), '"Display Name"');
  assert.equal(quoteName('postgres', 'Id'), '"Id"');
  assert.equal(quoteName('mysql', 'Id'), 'Id');
  assert.equal(quoteName('mysql', 'order-items'), '`order-items`');
  assert.equal(composeOrderBy('mysql', [{ column: 'a b', direction: 'desc' }]), '`a b` DESC');
});

test('funnel clauses: =, IN, IS NULL, and their combination', () => {
  assert.equal(funnelClause('postgres', 'status', ['shipped']), "status = 'shipped'");
  assert.equal(funnelClause('postgres', 'status', ['shipped', 'pending']), "status IN ('shipped', 'pending')");
  assert.equal(funnelClause('postgres', 'note', [null]), 'note IS NULL');
  assert.equal(funnelClause('sqlite', 'paid', [true, null]), '(paid = 1 OR paid IS NULL)');
  assert.equal(funnelClause('mysql', 'total', [1, 2.5]), 'total IN (1, 2.5)');
  assert.equal(funnelClause('postgres', 'name', ["O'Hara"]), "name = 'O''Hara'");
});

test('mergeWhere ANDs new clauses and replaces the previous clause of the same column', () => {
  assert.equal(mergeWhere('', undefined, "status = 'a'"), "status = 'a'");
  assert.equal(mergeWhere('total > 10', undefined, "status = 'a'"), "total > 10 AND status = 'a'");
  assert.equal(mergeWhere("total > 10 AND status = 'a'", "status = 'a'", "status = 'b'"), "total > 10 AND status = 'b'");
  assert.equal(mergeWhere("status = 'a' AND total > 10", "status = 'a'", ''), 'total > 10');
  assert.equal(mergeWhere("status = 'a'", "status = 'a'", ''), '');
});
