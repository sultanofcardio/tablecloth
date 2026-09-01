import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPgPass, parsePgPassLine } from '../src/data/pgpass';

test('parses plain lines', () => {
  assert.deepEqual(parsePgPassLine('localhost:5432:acme:api:secret'), ['localhost', '5432', 'acme', 'api', 'secret']);
});

test('skips comments and malformed lines', () => {
  assert.equal(parsePgPassLine('# comment'), undefined);
  assert.equal(parsePgPassLine(''), undefined);
  assert.equal(parsePgPassLine('too:few:fields'), undefined);
});

test('honors backslash escapes', () => {
  assert.deepEqual(parsePgPassLine('host:5432:db:user:pa\\:ss\\\\word'), [
    'host',
    '5432',
    'db',
    'user',
    'pa:ss\\word',
  ]);
});

test('matches with wildcards, first match wins', () => {
  const content = ['# comment', 'other:5432:*:*:nope', '*:5432:acme:api:yes', '*:*:*:*:fallback'].join('\n');
  assert.equal(matchPgPass(content, { host: 'db.example.com', port: 5432, database: 'acme', user: 'api' }), 'yes');
  assert.equal(matchPgPass(content, { host: 'x', port: 9999, database: 'y', user: 'z' }), 'fallback');
  assert.equal(matchPgPass(content, { host: 'other', port: 5432, database: 'any', user: 'one' }), 'nope');
});
