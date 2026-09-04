import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeOrderBy,
  composeWhere,
  funnelClause,
  parseOrderBy,
  quoteName,
  resyncWhere,
  sortMark,
  toggleSort,
} from '../src/webview/grid/filters';

test('parseOrderBy reads names, quotes, directions, and NULLS placement', () => {
  assert.deepEqual(parseOrderBy('id DESC, "Display Name", total asc nulls last'), [
    { column: 'id', direction: 'desc' },
    { column: 'Display Name', direction: 'asc' },
    { column: 'total', direction: 'asc' },
  ]);
  assert.deepEqual(parseOrderBy(''), []);
  assert.deepEqual(parseOrderBy('coalesce(a, b) DESC'), [{ column: 'coalesce(a, b)', direction: 'desc' }]);
});

test('a NULLS clause without an explicit direction still reads as the column, ascending', () => {
  assert.deepEqual(parseOrderBy('a NULLS LAST'), [{ column: 'a', direction: 'asc' }]);
  assert.deepEqual(parseOrderBy('a nulls first, b'), [
    { column: 'a', direction: 'asc' },
    { column: 'b', direction: 'asc' },
  ]);
  assert.deepEqual(sortMark('a nulls last', 'a'), { direction: 'asc', index: 0 });
  assert.equal(toggleSort('postgres', 'a NULLS LAST', 'a', true), 'a DESC NULLS LAST');
  assert.equal(toggleSort('postgres', 'a NULLS LAST, b', 'a', true), 'a DESC NULLS LAST, b');
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
  assert.equal(
    toggleSort('postgres', 'coalesce(a, b) DESC NULLS LAST', 'id', true),
    'coalesce(a, b) DESC NULLS LAST, id',
  );
  assert.equal(toggleSort('postgres', 'id ASC NULLS LAST, coalesce(a, b) DESC', 'id', true), 'id DESC NULLS LAST, coalesce(a, b) DESC');
});

test('names are quoted only when the dialect would fold or reject them', () => {
  assert.equal(quoteName('postgres', 'Display Name'), '"Display Name"');
  assert.equal(quoteName('postgres', 'Id'), '"Id"');
  assert.equal(quoteName('mysql', 'Id'), 'Id');
  assert.equal(quoteName('mysql', 'order-items'), '`order-items`');
  assert.equal(composeOrderBy('mysql', [{ column: 'a b', direction: 'desc' }]), '`a b` DESC');
});

test('keywords and reserved words are quoted in generated clauses', () => {
  assert.equal(composeOrderBy('postgres', [{ column: 'rank', direction: 'asc' }]), '"rank"');
  assert.equal(composeOrderBy('mysql', [{ column: 'system', direction: 'desc' }]), '`system` DESC');
  assert.equal(funnelClause('mysql', 'order', [1]), '`order` = 1');
  assert.equal(funnelClause('postgres', 'option', ['x', null]), '("option" = \'x\' OR "option" IS NULL)');
  assert.equal(quoteName('sqlite', 'select'), '"select"');
});

test('funnel clauses: =, IN, IS NULL, and their combination', () => {
  assert.equal(funnelClause('postgres', 'status', ['shipped']), "status = 'shipped'");
  assert.equal(funnelClause('postgres', 'status', ['shipped', 'pending']), "status IN ('shipped', 'pending')");
  assert.equal(funnelClause('postgres', 'note', [null]), 'note IS NULL');
  assert.equal(funnelClause('sqlite', 'paid', [true, null]), '(paid = 1 OR paid IS NULL)');
  assert.equal(funnelClause('mysql', 'total', [1, 2.5]), 'total IN (1, 2.5)');
  assert.equal(funnelClause('postgres', 'name', ["O'Hara"]), "name = 'O''Hara'");
  assert.equal(funnelClause('mysql', 'path', ['C:\\tmp']), "path = 'C:\\\\tmp'", 'MySQL doubles the backslash');
  assert.equal(funnelClause('postgres', 'path', ['C:\\tmp']), "path = 'C:\\tmp'", 'PostgreSQL leaves it alone');
});

test('composeWhere ANDs the manual text and the funnel clauses without nesting', () => {
  assert.equal(composeWhere('', []), '');
  assert.equal(composeWhere('', ["status = 'a'"]), "status = 'a'");
  assert.equal(composeWhere('total > 10', []), 'total > 10');
  assert.equal(composeWhere('total > 10', ["status = 'a'"]), "total > 10 AND status = 'a'");
  assert.equal(composeWhere('  total > 10  ', ["status = 'a'", 'id = 1']), "total > 10 AND status = 'a' AND id = 1");
  assert.equal(composeWhere('total > 10', ['', '  ']), 'total > 10');
});

test('composeWhere parenthesizes a manual part only when it has a top-level OR', () => {
  assert.equal(
    composeWhere("status = 'new' OR status = 'held'", ['customer_id = 7']),
    "(status = 'new' OR status = 'held') AND customer_id = 7",
  );
  assert.equal(composeWhere("(status = 'new' OR status = 'held')", ['customer_id = 7']), "(status = 'new' OR status = 'held') AND customer_id = 7");
  assert.equal(composeWhere("name = 'or' AND note = 'x or y'", ['id = 1']), "name = 'or' AND note = 'x or y' AND id = 1");
  assert.equal(composeWhere('origin = 1 AND author = 2', ['id = 1']), 'origin = 1 AND author = 2 AND id = 1');
  assert.equal(composeWhere("status = 'a' or status = 'b'", ['id = 1']), "(status = 'a' or status = 'b') AND id = 1");
  assert.equal(composeWhere("status = 'new' OR status = 'held'", []), "status = 'new' OR status = 'held'");
});

test('re-funnelling a column replaces its clause and never grows parentheses', () => {
  const funnels = new Map<string, string>();
  funnels.set('status', "status = 'a'");
  assert.equal(composeWhere('', funnels.values()), "status = 'a'");
  funnels.set('id', 'id = 1');
  assert.equal(composeWhere('', funnels.values()), "status = 'a' AND id = 1");
  funnels.set('id', 'id = 2');
  assert.equal(composeWhere('', funnels.values()), "status = 'a' AND id = 2");
  funnels.set('status', "status = 'c'");
  assert.equal(composeWhere('', funnels.values()), "status = 'c' AND id = 2");
  funnels.delete('status');
  assert.equal(composeWhere('', funnels.values()), 'id = 2');
  funnels.delete('id');
  assert.equal(composeWhere('', funnels.values()), '');
});

test('removing a funnel is substring-safe and idempotent', () => {
  const funnels = new Map<string, string>([
    ['customer_id', 'customer_id = 1'],
    ['id', 'id = 1'],
  ]);
  assert.equal(composeWhere('', funnels.values()), 'customer_id = 1 AND id = 1');
  funnels.delete('id');
  assert.equal(composeWhere('', funnels.values()), 'customer_id = 1');
  funnels.set('id', 'id = 1');
  funnels.delete('customer_id');
  assert.equal(composeWhere('', funnels.values()), 'id = 1');
  const manual = 'total > 10';
  const once = composeWhere(manual, funnels.values());
  assert.equal(composeWhere(manual, funnels.values()), once);
});

test('resyncWhere keeps the funnels while the WHERE text is the composed text', () => {
  const funnels = new Map([['status', "status = 'a'"]]);
  const parts = { manual: 'total > 10', funnels };
  const same = resyncWhere("total > 10 AND status = 'a'", parts);
  assert.equal(same.manual, 'total > 10');
  assert.deepEqual([...same.funnels], [['status', "status = 'a'"]]);
  assert.notEqual(same.funnels, funnels, 'the map is copied, so later edits do not alias');
  const padded = resyncWhere("  total > 10 AND status = 'a'\n", parts);
  assert.deepEqual([...padded.funnels], [['status', "status = 'a'"]]);
});

test('resyncWhere treats hand-edited WHERE text as manual and drops the funnels', () => {
  const funnels = new Map([['status', "status = 'a'"]]);
  const edited = resyncWhere("total > 10 AND status = 'a' AND id > 5", { manual: 'total > 10', funnels });
  assert.equal(edited.manual, "total > 10 AND status = 'a' AND id > 5");
  assert.equal(edited.funnels.size, 0);
  const cleared = resyncWhere('', { manual: 'total > 10', funnels });
  assert.equal(cleared.manual, '');
  assert.equal(cleared.funnels.size, 0);
  const fresh = resyncWhere("status = 'a'", { manual: '', funnels: new Map() });
  assert.equal(fresh.manual, "status = 'a'");
  assert.equal(fresh.funnels.size, 0);
  assert.equal(composeWhere(edited.manual, [...edited.funnels.values(), 'id = 2']), "total > 10 AND status = 'a' AND id > 5 AND id = 2");
});
