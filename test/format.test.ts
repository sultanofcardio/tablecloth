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

test('formatting preserves MySQL null-safe equality and PostgreSQL named arguments', () => {
  assert.equal(formatSql('select a <=> b from t', 'mysql'), 'SELECT a <=> b\nFROM t');
  assert.equal(formatSql('select f(a => 1)', 'postgres'), 'SELECT f(a => 1)');
});

test('a trailing newline in the input is kept, statements end with their own semicolons', () => {
  assert.equal(formatSql('select 1;\nselect 2\n', 'postgres'), 'SELECT 1;\n\nSELECT 2\n');
  assert.equal(formatSql('', 'postgres'), '');
});

type Dialect = 'postgres' | 'mysql' | 'sqlite';

/** Assert the exact output and that formatting the output again changes nothing. */
function expectFormat(input: string, expected: string, dialect: Dialect = 'postgres'): void {
  const once = formatSql(input, dialect);
  assert.equal(once, expected);
  assert.equal(formatSql(once, dialect), once, 'idempotent');
}

test('prefixed string literals, hex and binary numbers stay intact', () => {
  expectFormat("select E'\\n', X'0A', N'abc', U&'d\\0061t', E'it\\'s' from t", "SELECT E'\\n', X'0A', N'abc', U&'d\\0061t', E'it\\'s'\nFROM t");
  expectFormat("select _utf8mb4'abc', b'01', 0x1F, 0b101 from t", "SELECT _utf8mb4'abc', b'01', 0x1F, 0b101\nFROM t", 'mysql');
  expectFormat("select x'0a', 0X1f from t", "SELECT x'0a', 0X1f\nFROM t", 'sqlite');
});

test('mysql double-quoted string literals round-trip whole', () => {
  expectFormat('select * from t where s = "a\\"b" and x = 1', 'SELECT *\nFROM t\nWHERE s = "a\\"b"\n  AND x = 1', 'mysql');
  expectFormat('select "a, b" as c from t', 'SELECT "a, b" AS c\nFROM t', 'mysql');
  expectFormat('select "a, b" as c from t', 'SELECT "a, b" AS c\nFROM t', 'sqlite');
});

test('mysql variables are neither uppercased nor spaced', () => {
  expectFormat("select @user_id, @@session.sql_mode, @@GLOBAL.x, @'q', @`q` from t", "SELECT @user_id, @@session.sql_mode, @@GLOBAL.x, @'q', @`q`\nFROM t", 'mysql');
  expectFormat('set @a = 1, @@session.sql_mode = @b', 'SET @a = 1, @@session.sql_mode = @b', 'mysql');
});

test('postgres operators outside the fixed list round-trip', () => {
  expectFormat('select a <-> b, x @@ y, j @? p, |/ 25, a ^@ b, ?- l, a -|- b, a <<| b, a &< b, a ?# b, a ## b from t', 'SELECT a <-> b, x @@ y, j @? p, |/ 25, a ^@ b, ?- l, a -|- b, a <<| b, a &< b, a ?# b, a ## b\nFROM t');
  expectFormat('select 1+-2, a<-1, x=-1 from t', 'SELECT 1 + -2, a < -1, x = -1\nFROM t');
});

test('BETWEEN keeps its AND on the same line', () => {
  expectFormat('select 1 from t where a between 1 and 2 and b is not null', 'SELECT 1\nFROM t\nWHERE a BETWEEN 1 AND 2\n  AND b IS NOT NULL');
  expectFormat('select 1 from t join u on a between 1 and 2 and c = 1', 'SELECT 1\nFROM t\nJOIN u ON a BETWEEN 1 AND 2\n  AND c = 1');
});

test('type names hug their length and brackets are not spaced', () => {
  expectFormat(
    'create table t (a varchar (255), b numeric (10, 2), c character varying (10))',
    ['CREATE TABLE t', '(', '    a varchar(255),', '    b numeric(10, 2),', '    c character varying(10)', ')'].join('\n'),
  );
  expectFormat('select a::int [ ], array [ 1, 2 ], arr [1] from t', 'SELECT a::int[], array[1, 2], arr[1]\nFROM t');
});

test('CREATE TABLE AS uses the query layout', () => {
  expectFormat('create table t as select count(*) from x', 'CREATE TABLE t AS\nSELECT count(*)\nFROM x');
  expectFormat('create table if not exists s.t (id int)', ['CREATE TABLE IF NOT EXISTS s.t', '(', '    id int', ')'].join('\n'));
});

test('function calls in FROM and JOIN keep no space; DDL and DML column lists keep theirs', () => {
  expectFormat('select * from my_func (1)', 'SELECT *\nFROM my_func(1)');
  expectFormat('select * from generate_series(1, 3) g join lateral unnest(a) u on true', 'SELECT *\nFROM generate_series(1, 3) g\nJOIN LATERAL unnest(a) u ON TRUE');
  expectFormat('insert into t (a) values (1)', 'INSERT INTO t (a)\nVALUES (1)');
  expectFormat('create index i on t (a)', 'CREATE INDEX i ON t (a)');
});

test('a terminator never lands inside a trailing line comment', () => {
  expectFormat('select 1 -- c\n;\nselect 2;', 'SELECT 1 -- c\n;\n\nSELECT 2;');
  expectFormat('select 1 # c\n;\nselect 2;', 'SELECT 1 # c\n;\n\nSELECT 2;', 'mysql');
  expectFormat('select 1 /* c */ ;', 'SELECT 1 /* c */;');
  expectFormat('select 1\n-- tail\n;', 'SELECT 1\n-- tail\n;');
});

test('a CASE with a line comment is laid out as a block', () => {
  expectFormat('select case -- c\n when a then 1 else 2 end from t', ['SELECT CASE -- c', '           WHEN a THEN 1', '           ELSE 2', '       END', 'FROM t'].join('\n'));
  expectFormat('select case when a then 1 -- c\n else 2 end from t', ['SELECT CASE', '           WHEN a THEN 1 -- c', '           ELSE 2', '       END', 'FROM t'].join('\n'));
  expectFormat('select case x when 1 then 2\n -- c\n end as l from t', ['SELECT CASE x', '           WHEN 1 THEN 2', '           -- c', '       END AS l', 'FROM t'].join('\n'));
  expectFormat('select case when a then 1 else 2 end -- c\n as l from t', ['SELECT CASE WHEN a THEN 1 ELSE 2 END -- c', '       AS l', 'FROM t'].join('\n'));
});

test('a comma precedes the line comment of a list item', () => {
  expectFormat('select a -- c1\n, b from t', 'SELECT a, -- c1\n       b\nFROM t');
  expectFormat('select a, -- first\n b from t', 'SELECT a, -- first\n       b\nFROM t');
  expectFormat('update t set a = 1 -- c\n, b = 2', 'UPDATE t\nSET a = 1, -- c\n    b = 2');
  expectFormat('insert into t (a) values (1) -- c\n, (2)', 'INSERT INTO t (a)\nVALUES (1), -- c\n       (2)');
  expectFormat('with a as (select 1) -- c\n, b as (select 2) select 1', ['WITH a AS (', '    SELECT 1', '), -- c', 'b AS (', '    SELECT 2', ')', 'SELECT 1'].join('\n'));
  expectFormat('create table t (a int -- c\n, b text)', ['CREATE TABLE t', '(', '    a int, -- c', '    b text', ')'].join('\n'));
});

test('comments on heads, connectors, parens and subquery closers are kept', () => {
  expectFormat('select -- c\n a, b from t', 'SELECT -- c\n       a, b\nFROM t');
  expectFormat('select /* c */ a, b from t', 'SELECT /* c */ a, b\nFROM t');
  expectFormat('select distinct -- c\n a from t', 'SELECT DISTINCT -- c\n                a\nFROM t');
  expectFormat('select a from t where -- c\n a = 1 and -- d\n b = 2', ['SELECT a', 'FROM t', 'WHERE -- c', '      a = 1', '  AND -- d', '      b = 2'].join('\n'));
  expectFormat('select a from t where a = 1\n-- own line\nand b = 2', ['SELECT a', 'FROM t', 'WHERE a = 1', '  -- own line', '  AND b = 2'].join('\n'));
  expectFormat('select a from t join u on -- c\n t.id = u.id', ['SELECT a', 'FROM t', 'JOIN u ON -- c', '          t.id = u.id'].join('\n'));
  expectFormat('select * from ( -- open\n select 1 -- one\n -- before close\n ) -- after close\n q', ['SELECT *', 'FROM ( -- open', '    SELECT 1 -- one', '    -- before close', ') -- after close', 'q'].join('\n'));
  expectFormat('create table t ( -- open\n -- id\n id int, -- pk\n name text\n) -- close\n', ['CREATE TABLE t', '( -- open', '    -- id', '    id   int, -- pk', '    name text', ') -- close', ''].join('\n'));
  expectFormat('select a -- c1\n, -- c2\n b from t', 'SELECT a, -- c1\n       -- c2\n       b\nFROM t');
});

test('every comment in the input appears in the output, in order', () => {
  const inputs: { sql: string; dialect?: Dialect }[] = [
    { sql: 'select a, -- one\n b -- two\n from t -- three\n where x = 1 -- four\n and y = 2 -- five\n;' },
    { sql: 'select case -- c1\n when a then 1 -- c2\n else 2 -- c3\n end -- c4\n from t' },
    { sql: 'with a as ( -- c1\n select 1 -- c2\n ) -- c3\n, b as (select 2) -- c4\n select * from a -- c5\n join b on /* c6 */ true -- c7' },
    { sql: 'insert into t (a, -- c1\n b) values (1, -- c2\n 2), -- c3\n (3, 4) -- c4' },
    { sql: 'create table t ( -- c1\n a int, -- c2\n b text -- c3\n) -- c4' },
    { sql: 'select `a` # c1\n, b # c2\n from t # c3\n order by a # c4', dialect: 'mysql' },
    { sql: 'select 1 /* b1 */ , /* b2 */ 2 -- l1\n /* b3 */ from t /* b4 */' },
  ];
  for (const { sql, dialect = 'postgres' } of inputs) {
    const once = formatSql(sql, dialect);
    const commentsOf = (text: string) => tokenize(text, dialect).filter((t) => t.kind === 'comment').map((t) => t.text.trim());
    assert.deepEqual(commentsOf(once), commentsOf(sql), `comments kept: ${sql}`);
    assert.equal(formatSql(once, dialect), once, `idempotent: ${sql}`);
    const before = significant(tokenize(sql, dialect)).map((t) => (t.kind === 'word' ? t.value : t.text));
    const after = significant(tokenize(once, dialect)).map((t) => (t.kind === 'word' ? t.value : t.text));
    assert.deepEqual(after, before, `tokens preserved: ${sql}`);
  }
});

test('malformed input never throws and keeps its tokens', () => {
  const broken = "select (a, b from t where x = 'unterminated";
  const out = formatSql(broken, 'postgres');
  for (const token of ['select', '(', 'a', ',', 'b', 'from', 't', 'where', 'x', '=']) assert.ok(out.toLowerCase().includes(token));
  assert.doesNotThrow(() => formatSql('))) select ((( from', 'postgres'));
});
