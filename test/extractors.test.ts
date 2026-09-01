import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EXTRACTOR_OPTIONS, getExtractor, type ExtractorInput } from '../src/export/extractors';

const input: ExtractorInput = {
  dialect: 'postgres',
  columns: [
    { name: 'id', numeric: true },
    { name: 'email' },
    { name: 'note' },
    { name: 'active' },
  ],
  rows: [
    [1, 'ada@example.com', null, true],
    [2, "o'hara@example.com", 'gift, "wrap"', false],
  ],
  tableName: 'public.customers',
  keyColumns: ['id'],
};

test('SQL Inserts', () => {
  const out = getExtractor('sql-inserts')!.extract(input, DEFAULT_EXTRACTOR_OPTIONS);
  assert.equal(
    out,
    `INSERT INTO public.customers (id, email, note, active) VALUES (1, 'ada@example.com', NULL, TRUE);\n` +
      `INSERT INTO public.customers (id, email, note, active) VALUES (2, 'o''hara@example.com', 'gift, "wrap"', FALSE);\n`,
  );
});

test('SQL Inserts uses placeholder table when unknown', () => {
  const out = getExtractor('sql-inserts')!.extract({ ...input, tableName: undefined }, DEFAULT_EXTRACTOR_OPTIONS);
  assert.match(out, /^INSERT INTO MY_TABLE /);
});

test('SQL Updates keys on the primary key', () => {
  const out = getExtractor('sql-updates')!.extract(input, DEFAULT_EXTRACTOR_OPTIONS);
  assert.equal(
    out.split('\n')[0],
    `UPDATE public.customers SET email = 'ada@example.com', note = NULL, active = TRUE WHERE id = 1;`,
  );
});

test('SQL Updates without keys filters on all columns', () => {
  const out = getExtractor('sql-updates')!.extract({ ...input, keyColumns: undefined }, DEFAULT_EXTRACTOR_OPTIONS);
  assert.match(out.split('\n')[0]!, /WHERE id = 1 AND email = 'ada@example.com' AND note IS NULL AND active = TRUE;$/);
});

test('SQL Where Clause', () => {
  const out = getExtractor('sql-where')!.extract(input, DEFAULT_EXTRACTOR_OPTIONS);
  assert.equal(out, 'WHERE id = 1\n   OR id = 2\n');
});

test('CSV quotes only when needed and honors null text', () => {
  const out = getExtractor('csv')!.extract(input, { nullText: '\\N', quoteAll: false });
  assert.equal(
    out,
    'id,email,note,active\n1,ada@example.com,\\N,true\n2,o\'hara@example.com,"gift, ""wrap""",false\n',
  );
});

test('TSV uses tabs', () => {
  const out = getExtractor('tsv')!.extract(input, DEFAULT_EXTRACTOR_OPTIONS);
  assert.equal(out.split('\n')[0], 'id\temail\tnote\tactive');
});

test('pipe and semicolon variants quote their own delimiter', () => {
  const psv = getExtractor('psv')!.extract(
    { ...input, rows: [[1, 'a|b', null, true]] },
    DEFAULT_EXTRACTOR_OPTIONS,
  );
  assert.match(psv, /"a\|b"/);
  const ssv = getExtractor('ssv')!.extract(
    { ...input, rows: [[1, 'a;b', null, true]] },
    DEFAULT_EXTRACTOR_OPTIONS,
  );
  assert.match(ssv, /"a;b"/);
});

test('quoteAll quotes everything', () => {
  const out = getExtractor('csv')!.extract(input, { nullText: '', quoteAll: true });
  assert.equal(out.split('\n')[0], '"id","email","note","active"');
});

test('mysql literals double backslashes', () => {
  const out = getExtractor('sql-inserts')!.extract(
    {
      dialect: 'mysql',
      columns: [{ name: 'a' }],
      rows: [['back\\slash']],
      tableName: 't',
    },
    DEFAULT_EXTRACTOR_OPTIONS,
  );
  assert.equal(out, "INSERT INTO t (a) VALUES ('back\\\\slash');\n");
});
