import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements, statementAt } from '../src/sql/splitter';

test('splits simple statements on semicolons', () => {
  const result = splitStatements('SELECT 1; SELECT 2;\nSELECT 3', 'postgres');
  assert.deepEqual(
    result.map((s) => s.sql),
    ['SELECT 1', 'SELECT 2', 'SELECT 3'],
  );
});

test('ignores semicolons inside single-quoted strings', () => {
  const result = splitStatements("SELECT 'a;b'; SELECT 'it''s;ok'", 'postgres');
  assert.deepEqual(
    result.map((s) => s.sql),
    ["SELECT 'a;b'", "SELECT 'it''s;ok'"],
  );
});

test('ignores semicolons in line and block comments', () => {
  const sql = 'SELECT 1 -- trailing; comment\n; /* block; comment */ SELECT 2';
  const result = splitStatements(sql, 'postgres');
  assert.equal(result.length, 2);
  assert.equal(result[0]!.sql, 'SELECT 1 -- trailing; comment');
  // leading comments stay attached to their statement
  assert.equal(result[1]!.sql, '/* block; comment */ SELECT 2');
});

test('handles nested block comments (PostgreSQL)', () => {
  const sql = 'SELECT 1 /* outer /* inner; */ still; outer */; SELECT 2';
  const result = splitStatements(sql, 'postgres');
  assert.equal(result.length, 2);
});

test('handles dollar-quoted bodies (PostgreSQL)', () => {
  const sql = `CREATE FUNCTION f() RETURNS void AS $$
BEGIN
  PERFORM 1;
  PERFORM 2;
END;
$$ LANGUAGE plpgsql; SELECT 1`;
  const result = splitStatements(sql, 'postgres');
  assert.equal(result.length, 2);
  assert.match(result[0]!.sql, /LANGUAGE plpgsql$/);
});

test('handles tagged dollar quotes', () => {
  const sql = "SELECT $tag$ ; $notclosing$ ; $tag$; SELECT 'after'";
  const result = splitStatements(sql, 'postgres');
  assert.equal(result.length, 2);
});

test('mysql: backticks, hash comments, backslash escapes', () => {
  const sql = "SELECT `weird;name` FROM t; # comment; here\nSELECT 'a\\';b'; SELECT 2";
  const result = splitStatements(sql, 'mysql');
  assert.equal(result.length, 3);
  assert.equal(result[2]!.sql, 'SELECT 2');
});

test('dollar signs are not special outside postgres', () => {
  const result = splitStatements('SELECT $$ FROM t; SELECT 2', 'mysql');
  assert.equal(result.length, 2);
});

test('statementAt picks the statement under the caret', () => {
  const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3';
  const statements = splitStatements(sql, 'postgres');
  const second = statementAt(statements, sql.indexOf('2'), sql);
  assert.equal(second?.sql, 'SELECT 2');
  // caret at very end
  const third = statementAt(statements, sql.length, sql);
  assert.equal(third?.sql, 'SELECT 3');
  // caret right after a semicolon, still on the statement's line
  const afterFirst = statementAt(statements, sql.indexOf(';') + 1, sql);
  assert.equal(afterFirst?.sql, 'SELECT 1');
});

test('statementAt returns nothing on a blank line between statements', () => {
  const sql = 'SELECT 1;\n\nSELECT 2;\n   \n';
  const statements = splitStatements(sql, 'postgres');
  assert.equal(statementAt(statements, sql.indexOf('\n\n') + 1, sql), undefined);
  // blank line after the last terminated statement
  assert.equal(statementAt(statements, sql.length - 1, sql), undefined);
  assert.equal(statementAt(statements, sql.length, sql), undefined);
});

test('statementAt keeps a caret on a blank line inside an unterminated statement', () => {
  const sql = 'SELECT *\n\nFROM t';
  const statements = splitStatements(sql, 'postgres');
  const stmt = statementAt(statements, sql.indexOf('\n\n') + 1, sql);
  assert.equal(stmt?.sql, 'SELECT *\n\nFROM t');
});

test('trailing whitespace-only tail produces no empty statement', () => {
  const result = splitStatements('SELECT 1;   \n  ', 'postgres');
  assert.equal(result.length, 1);
});

test('statement offsets are exact', () => {
  const sql = '  SELECT 1  ;  SELECT 2  ';
  const [a, b] = splitStatements(sql, 'postgres');
  assert.equal(sql.slice(a!.start, a!.end), 'SELECT 1');
  assert.equal(sql.slice(b!.start, b!.end), 'SELECT 2');
});
