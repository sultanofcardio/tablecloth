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
  assert.deepEqual(parseOrderBy('postgres', 'id DESC, "Display Name", total asc nulls last'), [
    { column: 'id', direction: 'desc' },
    { column: 'Display Name', direction: 'asc' },
    { column: 'total', direction: 'asc' },
  ]);
  assert.deepEqual(parseOrderBy('postgres', ''), []);
  assert.deepEqual(parseOrderBy('postgres', 'coalesce(a, b) DESC'), [{ column: 'coalesce(a, b)', direction: 'desc' }]);
});

test('a NULLS clause without an explicit direction still reads as the column, ascending', () => {
  assert.deepEqual(parseOrderBy('postgres', 'a NULLS LAST'), [{ column: 'a', direction: 'asc' }]);
  assert.deepEqual(parseOrderBy('postgres', 'a nulls first, b'), [
    { column: 'a', direction: 'asc' },
    { column: 'b', direction: 'asc' },
  ]);
  assert.deepEqual(sortMark('postgres', 'a nulls last', 'a'), { direction: 'asc', index: 0 });
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
  assert.deepEqual(sortMark('postgres', 'created_at DESC, id', 'id'), { direction: 'asc', index: 2 });
  assert.deepEqual(sortMark('postgres', 'id', 'id'), { direction: 'asc', index: 0 });
  assert.equal(sortMark('postgres', 'id', 'total'), undefined);
  assert.equal(
    toggleSort('postgres', 'coalesce(a, b) DESC NULLS LAST', 'id', true),
    'coalesce(a, b) DESC NULLS LAST, id',
  );
  assert.equal(toggleSort('postgres', 'id ASC NULLS LAST, coalesce(a, b) DESC', 'id', true), 'id DESC NULLS LAST, coalesce(a, b) DESC');
});

test('a line comment in the ORDER BY text ends the terms, as it does for the database', () => {
  assert.equal(toggleSort('postgres', 'id -- note', 'created_at', true), 'id, created_at');
  assert.equal(toggleSort('mysql', 'id # note', 'created_at', true), 'id, created_at');
  assert.equal(toggleSort('postgres', 'id -- note', 'id', true), 'id DESC');
  assert.deepEqual(parseOrderBy('postgres', 'id -- note, created_at'), [{ column: 'id', direction: 'asc' }]);
  assert.deepEqual(sortMark('postgres', 'id -- note, created_at', 'id'), { direction: 'asc', index: 0 });
  assert.equal(sortMark('postgres', 'id -- note, created_at', 'created_at'), undefined);
  assert.deepEqual(parseOrderBy('postgres', 'id -- note\n, created_at'), [
    { column: 'id', direction: 'asc' },
    { column: 'created_at', direction: 'asc' },
  ]);
  assert.deepEqual(parseOrderBy('postgres', "note /* a, b */ DESC"), [{ column: 'note /* a, b */', direction: 'desc' }]);
  assert.deepEqual(parseOrderBy('mysql', "concat(a, ',') DESC"), [{ column: "concat(a, ',')", direction: 'desc' }]);
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
  assert.equal(composeWhere('postgres', '', []), '');
  assert.equal(composeWhere('postgres', '', ["status = 'a'"]), "status = 'a'");
  assert.equal(composeWhere('postgres', 'total > 10', []), 'total > 10');
  assert.equal(composeWhere('postgres', 'total > 10', ["status = 'a'"]), "total > 10 AND status = 'a'");
  assert.equal(composeWhere('postgres', '  total > 10  ', ["status = 'a'", 'id = 1']), "total > 10 AND status = 'a' AND id = 1");
  assert.equal(composeWhere('postgres', 'total > 10', ['', '  ']), 'total > 10');
});

test('composeWhere parenthesizes a manual part only when it has a top-level OR', () => {
  assert.equal(
    composeWhere('postgres', "status = 'new' OR status = 'held'", ['customer_id = 7']),
    "(status = 'new' OR status = 'held') AND customer_id = 7",
  );
  assert.equal(composeWhere('postgres', "(status = 'new' OR status = 'held')", ['customer_id = 7']), "(status = 'new' OR status = 'held') AND customer_id = 7");
  assert.equal(composeWhere('postgres', "name = 'or' AND note = 'x or y'", ['id = 1']), "name = 'or' AND note = 'x or y' AND id = 1");
  assert.equal(composeWhere('postgres', 'origin = 1 AND author = 2', ['id = 1']), 'origin = 1 AND author = 2 AND id = 1');
  assert.equal(composeWhere('postgres', "status = 'a' or status = 'b'", ['id = 1']), "(status = 'a' or status = 'b') AND id = 1");
  assert.equal(composeWhere('postgres', "status = 'new' OR status = 'held'", []), "status = 'new' OR status = 'held'");
  assert.equal(
    composeWhere('mysql', "name = 'it\\'s' OR status = 'new'", ['total > 5']),
    "(name = 'it\\'s' OR status = 'new') AND total > 5",
    'a MySQL backslash escape does not hide the OR',
  );
  assert.equal(
    composeWhere('postgres', "name = 'it''s or held' AND id = 1", ['total > 5']),
    "name = 'it''s or held' AND id = 1 AND total > 5",
    'a doubled quote keeps the OR inside the literal',
  );
  assert.equal(
    composeWhere('postgres', "id = 1 /* new or held */", ['total > 5']),
    "id = 1 /* new or held */ AND total > 5",
    'an OR inside a comment is not top level',
  );
  assert.equal(
    composeWhere('mysql', "`or` = 1 AND id = 2", ['total > 5']),
    "`or` = 1 AND id = 2 AND total > 5",
    'a column named or is not the operator',
  );
});

test('a trailing line comment in the manual text cannot comment out the funnel clauses', () => {
  assert.equal(composeWhere('postgres', 'id = 1 -- or x', ['total > 5']), 'id = 1 AND total > 5');
  assert.equal(composeWhere('mysql', 'id = 1 # note', ['total > 5']), 'id = 1 AND total > 5');
  assert.equal(
    composeWhere('postgres', "status = 'a' OR status = 'b' -- note", ['total > 5']),
    "(status = 'a' OR status = 'b') AND total > 5",
  );
  assert.equal(composeWhere('postgres', "note = '-- not a comment'", ['total > 5']), "note = '-- not a comment' AND total > 5");
  assert.equal(composeWhere('postgres', '-- everything', ['total > 5']), 'total > 5');
  assert.equal(composeWhere('postgres', 'id = 1 -- or x', []), 'id = 1 -- or x', 'without funnels the text is left as typed');
});

test('re-funnelling a column replaces its clause and never grows parentheses', () => {
  const funnels = new Map<string, string>();
  funnels.set('status', "status = 'a'");
  assert.equal(composeWhere('postgres', '', funnels.values()), "status = 'a'");
  funnels.set('id', 'id = 1');
  assert.equal(composeWhere('postgres', '', funnels.values()), "status = 'a' AND id = 1");
  funnels.set('id', 'id = 2');
  assert.equal(composeWhere('postgres', '', funnels.values()), "status = 'a' AND id = 2");
  funnels.set('status', "status = 'c'");
  assert.equal(composeWhere('postgres', '', funnels.values()), "status = 'c' AND id = 2");
  funnels.delete('status');
  assert.equal(composeWhere('postgres', '', funnels.values()), 'id = 2');
  funnels.delete('id');
  assert.equal(composeWhere('postgres', '', funnels.values()), '');
});

test('removing a funnel is substring-safe and idempotent', () => {
  const funnels = new Map<string, string>([
    ['customer_id', 'customer_id = 1'],
    ['id', 'id = 1'],
  ]);
  assert.equal(composeWhere('postgres', '', funnels.values()), 'customer_id = 1 AND id = 1');
  funnels.delete('id');
  assert.equal(composeWhere('postgres', '', funnels.values()), 'customer_id = 1');
  funnels.set('id', 'id = 1');
  funnels.delete('customer_id');
  assert.equal(composeWhere('postgres', '', funnels.values()), 'id = 1');
  const manual = 'total > 10';
  const once = composeWhere('postgres', manual, funnels.values());
  assert.equal(composeWhere('postgres', manual, funnels.values()), once);
});

test('resyncWhere keeps the funnels while the WHERE text is the composed text', () => {
  const funnels = new Map([['status', "status = 'a'"]]);
  const parts = { manual: 'total > 10', funnels };
  const same = resyncWhere('postgres', "total > 10 AND status = 'a'", parts);
  assert.equal(same.manual, 'total > 10');
  assert.deepEqual([...same.funnels], [['status', "status = 'a'"]]);
  assert.notEqual(same.funnels, funnels, 'the map is copied, so later edits do not alias');
  const padded = resyncWhere('postgres', "  total > 10 AND status = 'a'\n", parts);
  assert.deepEqual([...padded.funnels], [['status', "status = 'a'"]]);
});

test('resyncWhere treats hand-edited WHERE text as manual and drops the funnels', () => {
  const funnels = new Map([['status', "status = 'a'"]]);
  const edited = resyncWhere('postgres', "total > 10 AND status = 'a' AND id > 5", { manual: 'total > 10', funnels });
  assert.equal(edited.manual, "total > 10 AND status = 'a' AND id > 5");
  assert.equal(edited.funnels.size, 0);
  const cleared = resyncWhere('postgres', '', { manual: 'total > 10', funnels });
  assert.equal(cleared.manual, '');
  assert.equal(cleared.funnels.size, 0);
  const fresh = resyncWhere('postgres', "status = 'a'", { manual: '', funnels: new Map() });
  assert.equal(fresh.manual, "status = 'a'");
  assert.equal(fresh.funnels.size, 0);
  assert.equal(composeWhere('postgres', edited.manual, [...edited.funnels.values(), 'id = 2']), "total > 10 AND status = 'a' AND id > 5 AND id = 2");
});
