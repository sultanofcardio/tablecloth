import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BINARY_EXTRACTORS,
  DEFAULT_EXTRACTOR_OPTIONS,
  EXTRACTORS,
  EXTRACTOR_GROUP_LABELS,
  getBinaryExtractor,
  getExtractor,
  type ExtractorInput,
} from '../src/export/extractors';

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

const empty: ExtractorInput = { ...input, rows: [] };

function extract(id: string, source: ExtractorInput = input): string {
  const extractor = getExtractor(id);
  assert.ok(extractor, `extractor ${id} is registered`);
  return extractor.extract(source, DEFAULT_EXTRACTOR_OPTIONS);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('extractors carry the IntelliJ ids, labels, groups and extensions in menu order', () => {
  assert.deepEqual(
    EXTRACTORS.map((e) => [e.id, e.label, e.group, e.fileExtension]),
    [
      ['sql-inserts', 'SQL Inserts', 'builtin', 'sql'],
      ['sql-updates', 'SQL Updates', 'builtin', 'sql'],
      ['sql-where', 'Where Clause', 'builtin', 'sql'],
      ['csv', 'CSV', 'csv', 'csv'],
      ['tsv', 'TSV', 'csv', 'tsv'],
      ['psv', 'Pipe-separated', 'csv', 'csv'],
      ['ssv', 'Semicolon-separated', 'csv', 'csv'],
      ['html', 'HTML', 'scripted', 'html'],
      ['json', 'JSON', 'scripted', 'json'],
      ['markdown', 'Markdown', 'scripted', 'md'],
      ['one-row', 'One-row', 'scripted', 'txt'],
      ['pretty', 'Pretty', 'scripted', 'txt'],
      ['python-dataframe', 'Python-DataFrame', 'scripted', 'py'],
      ['sql-insert-multirow', 'SQL-Insert-Multirow', 'scripted', 'sql'],
      ['xml', 'XML', 'scripted', 'xml'],
    ],
  );
});

test('every extractor has a group and groups are contiguous in builtin, csv, scripted order', () => {
  const order = Object.keys(EXTRACTOR_GROUP_LABELS);
  assert.deepEqual(order, ['builtin', 'csv', 'scripted']);
  const groups = EXTRACTORS.map((e) => e.group);
  for (const group of groups) assert.ok(order.includes(group), `unknown group ${group}`);
  assert.deepEqual([...new Set(groups)], order);
  const sorted = [...groups].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  assert.deepEqual(groups, sorted, 'groups interleave');
});

test('ids are unique across text and binary extractors', () => {
  const ids = [...EXTRACTORS, ...BINARY_EXTRACTORS].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the Excel extractor is only offered as a binary extractor', () => {
  assert.equal(getExtractor('xlsx'), undefined);
  const xlsx = getBinaryExtractor('xlsx');
  assert.ok(xlsx);
  assert.equal(xlsx.label, 'Excel (xlsx)');
  assert.equal(xlsx.fileExtension, 'xlsx');
  assert.equal(getBinaryExtractor('nope'), undefined);
});

// ---------------------------------------------------------------------------
// Column selection
// ---------------------------------------------------------------------------

test('selectedColumns projects and reorders columns for text extractors', () => {
  const out = extract('csv', { ...input, selectedColumns: [1, 0] });
  assert.equal(out, "email,id\nada@example.com,1\no'hara@example.com,2\n");
});

test('selectedColumns projects columns for SQL extractors', () => {
  const out = extract('sql-inserts', { ...input, selectedColumns: [0, 3] });
  assert.equal(
    out,
    'INSERT INTO public.customers (id, active) VALUES (1, TRUE);\n' +
      'INSERT INTO public.customers (id, active) VALUES (2, FALSE);\n',
  );
});

test('SQL Updates keeps a deselected key column in WHERE while SET follows the selection', () => {
  const out = extract('sql-updates', { ...input, selectedColumns: [1] });
  assert.equal(
    out,
    "UPDATE public.customers SET email = 'ada@example.com' WHERE id = 1;\n" +
      "UPDATE public.customers SET email = 'o''hara@example.com' WHERE id = 2;\n",
  );
});

test('Where Clause keeps a deselected key column', () => {
  assert.equal(extract('sql-where', { ...input, selectedColumns: [1] }), 'WHERE id = 1\n   OR id = 2\n');
  assert.equal(extract('sql-where', { ...input, selectedColumns: [3, 2] }), 'WHERE id = 1\n   OR id = 2\n');
});

test('without a known key, SQL Updates and Where Clause fall back to the selected columns', () => {
  const noKey = { ...input, keyColumns: undefined, selectedColumns: [1] };
  assert.equal(
    extract('sql-updates', noKey),
    "UPDATE public.customers SET email = 'ada@example.com' WHERE email = 'ada@example.com';\n" +
      "UPDATE public.customers SET email = 'o''hara@example.com' WHERE email = 'o''hara@example.com';\n",
  );
  assert.equal(extract('sql-where', noKey), "WHERE email = 'ada@example.com'\n   OR email = 'o''hara@example.com'\n");
});

test('SQL Updates emits nothing when every emitted column is part of the key', () => {
  assert.equal(extract('sql-updates', { ...input, selectedColumns: [0] }), '');
  const userRoles: ExtractorInput = {
    dialect: 'postgres',
    columns: [
      { name: 'user_id', numeric: true },
      { name: 'role_id', numeric: true },
    ],
    rows: [
      [1, 2],
      [1, 3],
    ],
    tableName: 'user_roles',
    keyColumns: ['user_id', 'role_id'],
  };
  assert.equal(extract('sql-updates', userRoles), '');
  const withGrantedAt = {
    ...userRoles,
    columns: [...userRoles.columns, { name: 'granted_at' }],
    rows: [
      [1, 2, '2026-01-01'],
      [1, 3, null],
    ],
  };
  assert.equal(
    extract('sql-updates', withGrantedAt),
    "UPDATE user_roles SET granted_at = '2026-01-01' WHERE user_id = 1 AND role_id = 2;\n" +
      'UPDATE user_roles SET granted_at = NULL WHERE user_id = 1 AND role_id = 3;\n',
  );
  assert.equal(extract('sql-updates', { ...withGrantedAt, selectedColumns: [0, 1] }), '');
});

test('an empty or out-of-range selection falls back to every valid column', () => {
  assert.equal(extract('csv', { ...input, selectedColumns: [] }), extract('csv'));
  assert.equal(extract('csv', { ...input, selectedColumns: [0, 99, -1, 1.5] }), 'id\n1\n2\n');
});

// ---------------------------------------------------------------------------
// Built-in
// ---------------------------------------------------------------------------

test('SQL Inserts', () => {
  assert.equal(
    extract('sql-inserts'),
    `INSERT INTO public.customers (id, email, note, active) VALUES (1, 'ada@example.com', NULL, TRUE);\n` +
      `INSERT INTO public.customers (id, email, note, active) VALUES (2, 'o''hara@example.com', 'gift, "wrap"', FALSE);\n`,
  );
});

test('SQL Inserts uses placeholder table when unknown', () => {
  assert.match(extract('sql-inserts', { ...input, tableName: undefined }), /^INSERT INTO MY_TABLE /);
});

test('SQL Updates keys on the primary key', () => {
  assert.equal(
    extract('sql-updates').split('\n')[0],
    `UPDATE public.customers SET email = 'ada@example.com', note = NULL, active = TRUE WHERE id = 1;`,
  );
});

test('SQL Updates without keys filters on all columns', () => {
  const out = extract('sql-updates', { ...input, keyColumns: undefined });
  assert.match(
    out.split('\n')[0]!,
    /WHERE id = 1 AND email = 'ada@example.com' AND note IS NULL AND active = TRUE;$/,
  );
});

test('Where Clause', () => {
  assert.equal(extract('sql-where'), 'WHERE id = 1\n   OR id = 2\n');
});

test('SQL extractors quote a column named after a reserved word on every dialect', () => {
  const quoted = { postgres: '"order"', sqlite: '"order"', mysql: '`order`' } as const;
  for (const dialect of ['postgres', 'sqlite', 'mysql'] as const) {
    const source: ExtractorInput = {
      dialect,
      columns: [{ name: 'id', numeric: true }, { name: 'order' }],
      rows: [[1, 'x']],
      tableName: 't',
      keyColumns: ['order'],
    };
    const q = quoted[dialect];
    assert.equal(extract('sql-inserts', source), `INSERT INTO t (id, ${q}) VALUES (1, 'x');\n`, dialect);
    assert.equal(extract('sql-insert-multirow', source), `INSERT INTO t (id, ${q})\nVALUES (1, 'x');\n`, dialect);
    assert.equal(extract('sql-updates', source), `UPDATE t SET id = 1 WHERE ${q} = 'x';\n`, dialect);
    assert.equal(extract('sql-where', source), `WHERE ${q} = 'x'\n`, dialect);
  }
});

test('SQL extractors quote a mixed-case column where the dialect would fold it', () => {
  const source = (dialect: ExtractorInput['dialect']): ExtractorInput => ({
    dialect,
    columns: [{ name: 'Id', numeric: true }],
    rows: [[1]],
    tableName: 't',
  });
  assert.equal(extract('sql-inserts', source('postgres')), 'INSERT INTO t ("Id") VALUES (1);\n');
  assert.equal(extract('sql-inserts', source('sqlite')), 'INSERT INTO t ("Id") VALUES (1);\n');
  assert.equal(extract('sql-inserts', source('mysql')), 'INSERT INTO t (Id) VALUES (1);\n');
});

test('mysql literals double backslashes', () => {
  const out = extract('sql-inserts', {
    dialect: 'mysql',
    columns: [{ name: 'a' }],
    rows: [['back\\slash']],
    tableName: 't',
  });
  assert.equal(out, "INSERT INTO t (a) VALUES ('back\\\\slash');\n");
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

test('CSV quotes only when needed and honors null text', () => {
  const out = getExtractor('csv')!.extract(input, { nullText: '\\N', quoteAll: false });
  assert.equal(
    out,
    'id,email,note,active\n1,ada@example.com,\\N,true\n2,o\'hara@example.com,"gift, ""wrap""",false\n',
  );
});

test('TSV uses tabs', () => {
  assert.equal(extract('tsv').split('\n')[0], 'id\temail\tnote\tactive');
});

test('pipe and semicolon variants quote their own delimiter', () => {
  assert.match(extract('psv', { ...input, rows: [[1, 'a|b', null, true]] }), /"a\|b"/);
  assert.match(extract('ssv', { ...input, rows: [[1, 'a;b', null, true]] }), /"a;b"/);
});

test('quoteAll quotes everything', () => {
  const out = getExtractor('csv')!.extract(input, { nullText: '', quoteAll: true });
  assert.equal(out.split('\n')[0], '"id","email","note","active"');
});

// ---------------------------------------------------------------------------
// Scripted
// ---------------------------------------------------------------------------

test('HTML', () => {
  assert.equal(
    extract('html'),
    [
      '<table>',
      '  <thead>',
      '    <tr>',
      '      <th>id</th>',
      '      <th>email</th>',
      '      <th>note</th>',
      '      <th>active</th>',
      '    </tr>',
      '  </thead>',
      '  <tbody>',
      '    <tr>',
      '      <td>1</td>',
      '      <td>ada@example.com</td>',
      '      <td></td>',
      '      <td>true</td>',
      '    </tr>',
      '    <tr>',
      '      <td>2</td>',
      '      <td>o&#39;hara@example.com</td>',
      '      <td>gift, &quot;wrap&quot;</td>',
      '      <td>false</td>',
      '    </tr>',
      '  </tbody>',
      '</table>',
      '',
    ].join('\n'),
  );
});

test('HTML escapes markup in values and headers', () => {
  const out = extract('html', { ...input, columns: [{ name: 'a<b' }], rows: [['x & <y>']] });
  assert.match(out, /<th>a&lt;b<\/th>/);
  assert.match(out, /<td>x &amp; &lt;y&gt;<\/td>/);
});

test('JSON', () => {
  assert.equal(
    extract('json'),
    [
      '[',
      '  {',
      '    "id": 1,',
      '    "email": "ada@example.com",',
      '    "note": null,',
      '    "active": true',
      '  },',
      '  {',
      '    "id": 2,',
      '    "email": "o\'hara@example.com",',
      '    "note": "gift, \\"wrap\\"",',
      '    "active": false',
      '  }',
      ']',
      '',
    ].join('\n'),
  );
  assert.deepEqual(JSON.parse(extract('json')), [
    { id: 1, email: 'ada@example.com', note: null, active: true },
    { id: 2, email: "o'hara@example.com", note: 'gift, "wrap"', active: false },
  ]);
});

test('JSON keeps numeric-column strings as numbers and everything else as text', () => {
  const out = extract('json', {
    ...input,
    columns: [{ name: 'n', numeric: true }, { name: 's' }],
    rows: [
      ['12.50', '12.50'],
      ['9007199254740993', 7],
      ['abc', 'true'],
      [NaN, null],
    ],
  });
  assert.equal(
    out,
    [
      '[',
      '  {',
      '    "n": 12.50,',
      '    "s": "12.50"',
      '  },',
      '  {',
      '    "n": 9007199254740993,',
      '    "s": 7',
      '  },',
      '  {',
      '    "n": "abc",',
      '    "s": "true"',
      '  },',
      '  {',
      '    "n": "NaN",',
      '    "s": null',
      '  }',
      ']',
      '',
    ].join('\n'),
  );
});

test('JSON and Python keep numeric-column strings beyond double precision as numbers', () => {
  const source: ExtractorInput = {
    ...input,
    columns: [
      { name: 'big', numeric: true },
      { name: 'dec', numeric: true },
    ],
    rows: [['9007199254740993', '1234567890.1234567']],
  };
  assert.equal(
    extract('json', source),
    ['[', '  {', '    "big": 9007199254740993,', '    "dec": 1234567890.1234567', '  }', ']', ''].join('\n'),
  );
  assert.equal(
    extract('python-dataframe', source),
    [
      'import pandas as pd',
      '',
      'df = pd.DataFrame({',
      "    'big': [9007199254740993],",
      "    'dec': [1234567890.1234567],",
      '})',
      '',
    ].join('\n'),
  );
});

test('JSON of no rows is an empty array', () => {
  assert.equal(extract('json', empty), '[]\n');
});

test('Markdown', () => {
  assert.equal(
    extract('markdown'),
    [
      '| id | email | note | active |',
      '| ---: | --- | --- | --- |',
      '| 1 | ada@example.com |  | true |',
      '| 2 | o\'hara@example.com | gift, "wrap" | false |',
      '',
    ].join('\n'),
  );
});

test('Markdown escapes pipes and line breaks', () => {
  const out = extract('markdown', { ...input, columns: [{ name: 'a|b' }], rows: [['x|y\nz\r\nw']] });
  assert.equal(out, '| a\\|b |\n| --- |\n| x\\|y<br>z<br>w |\n');
});

test('One-row', () => {
  assert.equal(
    extract('one-row'),
    `1, 'ada@example.com', NULL, TRUE, 2, 'o''hara@example.com', 'gift, "wrap"', FALSE\n`,
  );
  assert.equal(extract('one-row', empty), '\n');
});

test('Pretty', () => {
  assert.equal(
    extract('pretty'),
    [
      '+----+--------------------+--------------+--------+',
      '| id | email              | note         | active |',
      '+----+--------------------+--------------+--------+',
      '|  1 | ada@example.com    | <null>       | true   |',
      "|  2 | o'hara@example.com | gift, \"wrap\" | false  |",
      '+----+--------------------+--------------+--------+',
      '',
    ].join('\n'),
  );
});

test('Pretty flattens multi-line values and closes an empty table with the header border', () => {
  const multi = extract('pretty', { ...input, columns: [{ name: 'v' }], rows: [['a\nb']] });
  assert.equal(multi, '+-----+\n| v   |\n+-----+\n| a b |\n+-----+\n');
  assert.equal(extract('pretty', empty), [
    '+----+-------+------+--------+',
    '| id | email | note | active |',
    '+----+-------+------+--------+',
    '',
  ].join('\n'));
});

test('Python-DataFrame', () => {
  assert.equal(
    extract('python-dataframe'),
    [
      'import pandas as pd',
      '',
      'df = pd.DataFrame({',
      "    'id': [1, 2],",
      "    'email': ['ada@example.com', \"o'hara@example.com\"],",
      "    'note': [None, 'gift, \"wrap\"'],",
      "    'active': [True, False],",
      '})',
      '',
    ].join('\n'),
  );
});

test('Python-DataFrame uses repr quoting and escapes', () => {
  const out = extract('python-dataframe', {
    ...input,
    columns: [{ name: "it's" }, { name: 'n', numeric: true }],
    rows: [['both \' and "', '12.50'], ['back\\slash\nnew\ttab', 3]],
  });
  assert.equal(
    out,
    [
      'import pandas as pd',
      '',
      'df = pd.DataFrame({',
      '    "it\'s": [\'both \\\' and "\', \'back\\\\slash\\nnew\\ttab\'],',
      "    'n': [12.50, 3],",
      '})',
      '',
    ].join('\n'),
  );
});

test('SQL-Insert-Multirow', () => {
  assert.equal(
    extract('sql-insert-multirow'),
    'INSERT INTO public.customers (id, email, note, active)\n' +
      "VALUES (1, 'ada@example.com', NULL, TRUE),\n" +
      `       (2, 'o''hara@example.com', 'gift, "wrap"', FALSE);\n`,
  );
  assert.match(extract('sql-insert-multirow', { ...input, tableName: undefined }), /^INSERT INTO MY_TABLE /);
  assert.equal(extract('sql-insert-multirow', empty), '');
});

test('XML', () => {
  assert.equal(
    extract('xml'),
    [
      '<data>',
      '  <row>',
      '    <column name="id">1</column>',
      '    <column name="email">ada@example.com</column>',
      '    <column name="note" null="true"/>',
      '    <column name="active">true</column>',
      '  </row>',
      '  <row>',
      '    <column name="id">2</column>',
      "    <column name=\"email\">o'hara@example.com</column>",
      '    <column name="note">gift, "wrap"</column>',
      '    <column name="active">false</column>',
      '  </row>',
      '</data>',
      '',
    ].join('\n'),
  );
});

test('XML escapes text and attribute values', () => {
  const out = extract('xml', { ...input, columns: [{ name: 'a"b<c' }], rows: [['x & <y>']] });
  assert.equal(
    out,
    '<data>\n  <row>\n    <column name="a&quot;b&lt;c">x &amp; &lt;y&gt;</column>\n  </row>\n</data>\n',
  );
});
