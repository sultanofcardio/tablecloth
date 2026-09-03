import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTableRefs } from '../src/complete/refs';

test('parses FROM and JOIN with aliases', () => {
  const refs = parseTableRefs('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 1');
  assert.deepEqual(refs, [
    { schema: undefined, table: 'orders', alias: 'o' },
    { schema: undefined, table: 'customers', alias: 'c' },
  ]);
});

test('parses schema-qualified tables and quoted names', () => {
  const refs = parseTableRefs('SELECT * FROM public."order items" oi JOIN acme.customers ON 1=1');
  assert.deepEqual(refs[0], { schema: 'public', table: 'order items', alias: 'oi' });
  assert.deepEqual(refs[1], { schema: 'acme', table: 'customers', alias: undefined });
});

test('keywords are not mistaken for aliases', () => {
  const refs = parseTableRefs('SELECT * FROM orders WHERE status = 1');
  assert.deepEqual(refs, [{ schema: undefined, table: 'orders', alias: undefined }]);
});

test('UPDATE and INSERT INTO targets are found', () => {
  assert.equal(parseTableRefs('UPDATE orders SET x = 1')[0]?.table, 'orders');
  assert.equal(parseTableRefs('INSERT INTO customers (a) VALUES (1)')[0]?.table, 'customers');
});

test('IS DISTINCT FROM and ON DUPLICATE KEY UPDATE name values, not tables', () => {
  assert.deepEqual(parseTableRefs('SELECT * FROM orders WHERE a IS DISTINCT FROM b'), [{ schema: undefined, table: 'orders', alias: undefined }]);
  assert.deepEqual(parseTableRefs('SELECT * FROM orders o WHERE o.a IS NOT DISTINCT\n FROM o.b'), [{ schema: undefined, table: 'orders', alias: 'o' }]);
  assert.deepEqual(parseTableRefs("INSERT INTO orders (a) VALUES (1) ON DUPLICATE KEY UPDATE a = 1"), [
    { schema: undefined, table: 'orders', alias: undefined },
  ]);
});
