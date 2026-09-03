import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSql } from '../src/sql/format';
import { significant, tokenize } from '../src/sql/tokens';

const fixtures: { name: string; input: string; expected: string; dialect?: 'postgres' | 'mysql' | 'sqlite' }[] = [
  {
    name: 'select with join, conditions, order, limit',
    input:
      "select o.id, c.email, o.total from orders o join customers c on c.id = o.customer_id where o.status = 'shipped' and o.total > 10 order by o.created_at desc limit 10;",
    expected: [
      'SELECT o.id, c.email, o.total',
      'FROM orders o',
      'JOIN customers c ON c.id = o.customer_id',
      "WHERE o.status = 'shipped'",
      '  AND o.total > 10',
      'ORDER BY o.created_at DESC',
      'LIMIT 10;',
    ].join('\n'),
  },
  {
    name: 'subqueries become indented blocks',
    input: 'select * from (select id from t) as q where q.id in (select id from other)',
    expected: ['SELECT *', 'FROM (', '    SELECT id', '    FROM t', ') AS q', 'WHERE q.id IN (', '    SELECT id', '    FROM other', ')'].join('\n'),
  },
  {
    name: 'insert with several tuples aligns them',
    input: "insert into orders (customer_id, status, total) values (88, 'pending', 0.00), (89, 'pending', 1.00);",
    expected: ['INSERT INTO orders (customer_id, status, total)', "VALUES (88, 'pending', 0.00),", "       (89, 'pending', 1.00);"].join('\n'),
  },
  {
    name: 'update and delete',
    input: "update orders set status = 'shipped', total = 1 where id = 1; delete from orders where id = 1;",
    expected: ['UPDATE orders', "SET status = 'shipped',", '    total = 1', 'WHERE id = 1;', '', 'DELETE FROM orders', 'WHERE id = 1;'].join('\n'),
  },
  {
    name: 'create table aligns column names',
    input: "create table orders (id bigint primary key, customer_id bigint not null references customers (id), status text default 'pending');",
    expected: [
      'CREATE TABLE orders',
      '(',
      '    id          bigint PRIMARY KEY,',
      '    customer_id bigint NOT NULL REFERENCES customers (id),',
      "    status      text DEFAULT 'pending'",
      ');',
    ].join('\n'),
  },
  {
    name: 'long select lists wrap under the first item',
    input:
      'select customers.id, customers.email, customers.full_name, customers.created_at, customers.updated_at, customers.country_code from customers',
    expected: [
      'SELECT customers.id,',
      '       customers.email,',
      '       customers.full_name,',
      '       customers.created_at,',
      '       customers.updated_at,',
      '       customers.country_code',
      'FROM customers',
    ].join('\n'),
  },
  {
    name: 'CTE',
    input: 'with recent as (select * from orders where total > 1) select count(*) from recent',
    expected: ['WITH recent AS (', '    SELECT *', '    FROM orders', '    WHERE total > 1', ')', 'SELECT count(*)', 'FROM recent'].join('\n'),
  },
  {
    name: 'mysql backticks, # comment, and functions keep their case',
    dialect: 'mysql',
    input: 'select `a`, COUNT(*) # how many\nfrom `t` where x <> 2',
    expected: ['SELECT `a`, COUNT(*) # how many', 'FROM `t`', 'WHERE x <> 2'].join('\n'),
  },
  {
    name: 'casts, parameters, strings untouched',
    input: "select a::text, :id, ${name}, 'it''s' from t",
    expected: ["SELECT a::text, :id, ${name}, 'it''s'", 'FROM t'].join('\n'),
  },
  {
    name: 'long CASE breaks into branches',
    input:
      "select case when status = 'shipped' then 'on its way to the customer' when status = 'delivered' then 'arrived' else 'pending' end as label from orders",
    expected: [
      'SELECT CASE',
      "           WHEN status = 'shipped' THEN 'on its way to the customer'",
      "           WHEN status = 'delivered' THEN 'arrived'",
      "           ELSE 'pending'",
      '       END AS label',
      'FROM orders',
    ].join('\n'),
  },
  {
    name: 'other statements are re-spaced only',
    input: 'create   index   idx_orders_status on orders ( status ) ;',
    expected: 'CREATE INDEX idx_orders_status ON orders (status);',
  },
  {
    name: 'dollar-quoted bodies stay verbatim',
    input: 'create function add_one(n integer) returns integer as $$ select n + 1 $$ language sql',
    expected: 'CREATE FUNCTION add_one(n integer) RETURNS integer AS $$ select n + 1 $$ LANGUAGE sql',
  },
  {
    name: 'comments before and inside statements survive',
    input: '-- shipped orders\nselect id -- the key\nfrom orders;\n\n/* second */\nselect 1;',
    expected: ['-- shipped orders', 'SELECT id -- the key', 'FROM orders;', '', '/* second */', 'SELECT 1;'].join('\n'),
  },
];

for (const fixture of fixtures) {
  test(`format: ${fixture.name}`, () => {
    assert.equal(formatSql(fixture.input, fixture.dialect ?? 'postgres'), fixture.expected);
  });
}

test('formatting is idempotent and keeps every token', () => {
  for (const fixture of fixtures) {
    const dialect = fixture.dialect ?? 'postgres';
    const once = formatSql(fixture.input, dialect);
    assert.equal(formatSql(once, dialect), once, `idempotent: ${fixture.name}`);
    const before = significant(tokenize(fixture.input, dialect)).map((t) => (t.kind === 'word' ? t.value : t.text));
    const after = significant(tokenize(once, dialect)).map((t) => (t.kind === 'word' ? t.value : t.text));
    assert.deepEqual(after, before, `tokens preserved: ${fixture.name}`);
  }
});

test('keyword case options', () => {
  assert.equal(formatSql('SELECT a FROM t', 'postgres', { keywordCase: 'lower' }), 'select a\nfrom t');
  assert.equal(formatSql('Select a From t', 'postgres', { keywordCase: 'preserve' }), 'Select a\nFrom t');
});

test('a trailing newline in the input is kept, statements end with their own semicolons', () => {
  assert.equal(formatSql('select 1;\nselect 2\n', 'postgres'), 'SELECT 1;\n\nSELECT 2\n');
  assert.equal(formatSql('', 'postgres'), '');
});

test('malformed input never throws and keeps its tokens', () => {
  const broken = "select (a, b from t where x = 'unterminated";
  const out = formatSql(broken, 'postgres');
  for (const token of ['select', '(', 'a', ',', 'b', 'from', 't', 'where', 'x', '=']) assert.ok(out.toLowerCase().includes(token));
  assert.doesNotThrow(() => formatSql('))) select ((( from', 'postgres'));
});
