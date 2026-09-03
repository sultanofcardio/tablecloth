import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteDriver } from '../src/drivers/sqlite';
import type { DataSourceConfig } from '../src/core/types';
import { countDataRows, DELIMITERS, detectDelimiter, parseDelimited, type DelimitedOptions } from '../src/import/csv';
import {
  duplicateTarget,
  inferColumnType,
  isNumericText,
  matchTableColumn,
  matchTableColumns,
  sqlTypeFor,
  suggestColumnName,
  valueKindForInferred,
  valueKindForSqlType,
} from '../src/import/infer';
import { executeImport } from '../src/import/execute';
import type { DbSession } from '../src/drivers/driver';
import {
  buildCreateTable,
  buildInsertBatches,
  buildRowInsert,
  literalFor,
  type ImportPlanInput,
} from '../src/import/plan';

const csv: DelimitedOptions = { delimiter: ',', quote: '"', hasHeader: true, trim: false };

function fakeSession(dialect: DbSession['dialect'], failOn: string): { session: DbSession; statements: string[] } {
  const statements: string[] = [];
  const session: DbSession = {
    dialect,
    serverVersion: 'test',
    async query(sql) {
      statements.push(sql);
      if (sql === failOn) throw new Error('bad row');
      return { columns: [], rows: [], affectedRows: 0, hasRows: false };
    },
    async queryRaw() {
      return { columns: [], rows: [] };
    },
    async close() {},
  };
  return { session, statements };
}

// ---------------------------------------------------------------------------
// parseDelimited
// ---------------------------------------------------------------------------

test('parseDelimited handles RFC 4180 quoting, doubled quotes and embedded newlines', () => {
  const text = 'id,note\n1,"says ""hi"", then\nleaves"\n2,plain\n';
  const table = parseDelimited(text, csv);
  assert.deepEqual(table.headers, ['id', 'note']);
  assert.deepEqual(table.rows, [
    ['1', 'says "hi", then\nleaves'],
    ['2', 'plain'],
  ]);
});

test('MySQL create imports start a fresh insert transaction and remove the table on failure', async () => {
  const { session, statements } = fakeSession('mysql', 'INSERT batch');
  await assert.rejects(
    () => executeImport(session, {
      dialect: 'mysql',
      createSql: 'CREATE TABLE imported (id int);',
      dropSql: 'DROP TABLE imported;',
      batches: ['INSERT batch'],
      batchRows: [[['1']]],
      rowSql: () => 'INSERT row',
      onError: 'stop',
      cancelled: () => false,
      progressed: () => undefined,
    }),
    /bad row/,
  );
  assert.deepEqual(statements, [
    'CREATE TABLE imported (id int);',
    'START TRANSACTION',
    'INSERT batch',
    'ROLLBACK',
    'DROP TABLE imported;',
  ]);
});

test('parseDelimited accepts CRLF, strips a BOM and skips blank lines', () => {
  const text = '\uFEFFa,b\r\n1,2\r\n\r\n3,4\r\n';
  const table = parseDelimited(text, csv);
  assert.deepEqual(table.headers, ['a', 'b']);
  assert.deepEqual(table.rows, [
    ['1', '2'],
    ['3', '4'],
  ]);
});

test('parseDelimited keeps a lone quoted empty cell as a row', () => {
  const table = parseDelimited('a\n""\n', csv);
  assert.deepEqual(table.rows, [['']]);
});

test('parseDelimited treats a quote inside an unquoted field as literal', () => {
  const table = parseDelimited('a,b\n5" tall,x\n', csv);
  assert.deepEqual(table.rows, [['5" tall', 'x']]);
});

test('parseDelimited pads short rows and extends headers for long rows', () => {
  const table = parseDelimited('a,b\n1\n1,2,3,4\n', csv);
  assert.deepEqual(table.headers, ['a', 'b', 'column3', 'column4']);
  assert.deepEqual(table.rows, [
    ['1', '', '', ''],
    ['1', '2', '3', '4'],
  ]);
});

test('parseDelimited names columns positionally without a header row', () => {
  const table = parseDelimited('x,y,z\n1,2,3\n', { ...csv, hasHeader: false });
  assert.deepEqual(table.headers, ['column1', 'column2', 'column3']);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0], ['x', 'y', 'z']);
});

test('parseDelimited fills blank header cells with positional names', () => {
  const table = parseDelimited('a,,c\n1,2,3\n', csv);
  assert.deepEqual(table.headers, ['a', 'column2', 'c']);
});

test('parseDelimited trims only unquoted cells when asked', () => {
  const text = ' a , b \n 1 , " 2 " \n';
  const untrimmed = parseDelimited(text, csv);
  assert.deepEqual(untrimmed.headers, [' a ', ' b ']);
  assert.deepEqual(untrimmed.rows, [[' 1 ', ' " 2 " ']]);
  const trimmed = parseDelimited(text, { ...csv, trim: true });
  assert.deepEqual(trimmed.headers, ['a', 'b']);
  assert.deepEqual(trimmed.rows, [['1', ' 2 ']]);
});

test('parseDelimited with quoting disabled keeps quote characters', () => {
  const table = parseDelimited('a,b\n"1,2",x\n', { ...csv, quote: '' });
  assert.deepEqual(table.headers, ['a', 'b', 'column3']);
  assert.deepEqual(table.rows, [['"1', '2"', 'x']]);
});

test('parseDelimited supports tab and semicolon delimiters', () => {
  const tsv = parseDelimited('a\tb\n1\t2\n', { ...csv, delimiter: '\t' });
  assert.deepEqual(tsv.rows, [['1', '2']]);
  const ssv = parseDelimited('a;b\n1;"x;y"\n', { ...csv, delimiter: ';' });
  assert.deepEqual(ssv.rows, [['1', 'x;y']]);
});

test('parseDelimited of empty input yields nothing', () => {
  assert.deepEqual(parseDelimited('', csv), { headers: [], rows: [] });
  assert.deepEqual(parseDelimited('\n\n', csv), { headers: [], rows: [] });
  assert.deepEqual(parseDelimited('only,header\n', csv), { headers: ['only', 'header'], rows: [] });
});

test('parseDelimited keeps an unterminated quoted field', () => {
  const table = parseDelimited('a,b\n1,"open\n', csv);
  assert.deepEqual(table.rows, [['1', 'open\n']]);
});

test('countDataRows matches parseDelimited', () => {
  const text = 'a,b\n1,"multi\nline"\n\n2,x\n';
  assert.equal(countDataRows(text, csv), 2);
  assert.equal(countDataRows(text, { ...csv, hasHeader: false }), 3);
  assert.equal(countDataRows('', csv), 0);
  assert.equal(countDataRows('a,b\n', csv), 0);
});

// ---------------------------------------------------------------------------
// detectDelimiter
// ---------------------------------------------------------------------------

test('DELIMITERS lists the four supported characters', () => {
  assert.deepEqual(
    DELIMITERS.map((d) => d.char),
    [',', '\t', ';', '|'],
  );
});

test('detectDelimiter recognizes each delimiter', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3\n4,5,6\n'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
  assert.equal(detectDelimiter('a;b;c\n1;2;3\n'), ';');
  assert.equal(detectDelimiter('a|b|c\n1|2|3\n'), '|');
});

test('detectDelimiter ignores delimiters inside quotes', () => {
  const text = 'name;note\nA;"x, y"\nB;"p, q, r"\n';
  assert.equal(detectDelimiter(text), ';');
});

test('detectDelimiter prefers the consistent candidate over a frequent inconsistent one', () => {
  const text = 'name;address\nA;1 Main St, Apt 2, Springfield\nB;Oak Rd\nC;2nd Ave, Suite 5\n';
  assert.equal(detectDelimiter(text), ';');
});

test('detectDelimiter breaks ties in favor of the comma and defaults to it', () => {
  assert.equal(detectDelimiter('a,b;c\n1,2;3\n'), ',');
  assert.equal(detectDelimiter(''), ',');
  assert.equal(detectDelimiter('single column\nvalue\n'), ',');
});

test('detectDelimiter only samples the first 20 non-empty lines', () => {
  const head = Array.from({ length: 20 }, (_, i) => `${i}|x|y`).join('\n');
  const tail = Array.from({ length: 50 }, (_, i) => `${i},a,b,c,d`).join('\n');
  assert.equal(detectDelimiter(`${head}\n\n\n${tail}\n`), '|');
});

// ---------------------------------------------------------------------------
// inferColumnType
// ---------------------------------------------------------------------------

test('inferColumnType picks each base type', () => {
  assert.equal(inferColumnType(['1', '-2', '2147483647']), 'integer');
  assert.equal(inferColumnType(['2147483648']), 'bigint');
  assert.equal(inferColumnType(['-9223372036854775808']), 'bigint');
  assert.equal(inferColumnType(['9223372036854775808']), 'numeric');
  assert.equal(inferColumnType(['1.5', '-0.25', '1e10', '.5', '5.']), 'numeric');
  assert.equal(inferColumnType(['true', 'False', 'T', 'f', 'yes', 'NO']), 'boolean');
  assert.equal(inferColumnType(['2024-01-31']), 'date');
  assert.equal(inferColumnType(['2024-01-31 12:30']), 'timestamp');
  assert.equal(inferColumnType(['2024-01-31T12:30:00']), 'timestamp');
  assert.equal(inferColumnType(['2024-01-31T12:30:00.123Z']), 'timestamp');
  assert.equal(inferColumnType(['2024-01-31 12:30:00+02:00']), 'timestamp');
  assert.equal(inferColumnType(['hello']), 'text');
});

test('inferColumnType ignores empty and null-text cells', () => {
  assert.equal(inferColumnType([]), 'text');
  assert.equal(inferColumnType(['', '']), 'text');
  assert.equal(inferColumnType(['', '7', '\\N'], '\\N'), 'integer');
  assert.equal(inferColumnType(['\\N'], '\\N'), 'text');
});

test('inferColumnType applies the mixing rules', () => {
  assert.equal(inferColumnType(['1', '2.5']), 'numeric');
  assert.equal(inferColumnType(['1', '3000000000']), 'bigint');
  assert.equal(inferColumnType(['3000000000', '1.5']), 'numeric');
  assert.equal(inferColumnType(['2024-01-31', '2024-01-31 10:00']), 'timestamp');
  assert.equal(inferColumnType(['0', '1']), 'integer');
  assert.equal(inferColumnType(['true', '1']), 'text');
  assert.equal(inferColumnType(['2024-01-31', '7']), 'text');
  assert.equal(inferColumnType(['1', '2', 'x']), 'text');
  assert.equal(inferColumnType([' 1']), 'text');
});

test('isNumericText follows the SQL number grammar', () => {
  for (const ok of ['1', '-1', '+1', '1.5', '.5', '5.', '1e3', '1.5E-3']) assert.equal(isNumericText(ok), true, ok);
  for (const bad of ['', ' 1', '1,000', '0x10', 'NaN', 'Infinity', '1.2.3', 'e5']) {
    assert.equal(isNumericText(bad), false, bad);
  }
});

test('sqlTypeFor maps every inferred type per dialect', () => {
  const all = ['integer', 'bigint', 'numeric', 'boolean', 'date', 'timestamp', 'text'] as const;
  assert.deepEqual(
    all.map((t) => sqlTypeFor('postgres', t)),
    ['integer', 'bigint', 'numeric', 'boolean', 'date', 'timestamp', 'text'],
  );
  assert.deepEqual(
    all.map((t) => sqlTypeFor('mysql', t)),
    ['int', 'bigint', 'decimal(20,6)', 'tinyint(1)', 'date', 'datetime', 'text'],
  );
  assert.deepEqual(
    all.map((t) => sqlTypeFor('sqlite', t)),
    ['INTEGER', 'INTEGER', 'REAL', 'INTEGER', 'TEXT', 'TEXT', 'TEXT'],
  );
});

// ---------------------------------------------------------------------------
// column names
// ---------------------------------------------------------------------------

test('suggestColumnName normalizes headers', () => {
  const used = new Set<string>();
  assert.equal(suggestColumnName('Email Address', used), 'email_address');
  assert.equal(suggestColumnName('  First--Name!! ', used), 'first_name');
  assert.equal(suggestColumnName('2024 Sales', used), 'col_2024_sales');
  assert.equal(suggestColumnName('', used), 'col');
  assert.equal(suggestColumnName('***', used), 'col_2');
  assert.equal(suggestColumnName('Prénom', used), 'prenom');
  assert.equal(suggestColumnName('already_ok', used), 'already_ok');
  assert.deepEqual(
    [...used].sort(),
    ['already_ok', 'col', 'col_2', 'col_2024_sales', 'email_address', 'first_name', 'prenom'],
  );
});

test('suggestColumnName dedupes with numeric suffixes', () => {
  const used = new Set<string>(['name']);
  assert.equal(suggestColumnName('Name', used), 'name_2');
  assert.equal(suggestColumnName('NAME', used), 'name_3');
  assert.equal(suggestColumnName('name_2', used), 'name_2_2');
  assert.equal(used.size, 4);
});

test('matchTableColumn tries exact, then case-insensitive, then normalized', () => {
  const columns = ['id', 'Email', 'email', 'first_name', 'created_at'];
  assert.equal(matchTableColumn('email', columns), 'email');
  assert.equal(matchTableColumn('Email', columns), 'Email');
  assert.equal(matchTableColumn('EMAIL', columns), 'Email');
  assert.equal(matchTableColumn('First Name', columns), 'first_name');
  assert.equal(matchTableColumn('Created At', columns), 'created_at');
  assert.equal(matchTableColumn('Created_At ', columns), 'created_at');
  assert.equal(matchTableColumn('phone', columns), undefined);
  assert.equal(matchTableColumn('', columns), undefined);
  assert.equal(matchTableColumn('***', ['col']), undefined);
});

test('valueKindForSqlType maps introspected types', () => {
  const cases: [string, string][] = [
    ['bigint', 'numeric'],
    ['integer', 'numeric'],
    ['numeric(10,2)', 'numeric'],
    ['int(11)', 'numeric'],
    ['int(10) unsigned', 'numeric'],
    ['tinyint(1)', 'boolean'],
    ['tinyint(4)', 'numeric'],
    ['tinyint', 'numeric'],
    ['boolean', 'boolean'],
    ['bool', 'boolean'],
    ['REAL', 'numeric'],
    ['double precision', 'numeric'],
    ['decimal(20,6)', 'numeric'],
    ['varchar(64)', 'text'],
    ['text', 'text'],
    ['timestamp without time zone', 'text'],
    ['date', 'text'],
    ['json', 'text'],
    ['', 'text'],
  ];
  for (const [type, kind] of cases) assert.equal(valueKindForSqlType(type), kind, type);
});

// ---------------------------------------------------------------------------
// literals
// ---------------------------------------------------------------------------

const nulls = { nullText: '\\N', emptyAsNull: false };

test('literalFor applies the NULL rules', () => {
  assert.equal(literalFor('postgres', 'text', '\\N', nulls), 'NULL');
  assert.equal(literalFor('postgres', 'text', '', nulls), "''");
  assert.equal(literalFor('postgres', 'text', '', { ...nulls, emptyAsNull: true }), 'NULL');
  assert.equal(literalFor('postgres', 'numeric', '', nulls), 'NULL');
  assert.equal(literalFor('postgres', 'boolean', '', nulls), 'NULL');
  // An empty null marker is disabled rather than matching every empty cell.
  assert.equal(literalFor('postgres', 'text', '', { nullText: '', emptyAsNull: false }), "''");
  assert.equal(literalFor('postgres', 'text', 'NULL', { nullText: 'NULL', emptyAsNull: false }), 'NULL');
});

test('literalFor numeric kind emits numbers bare and everything else quoted', () => {
  assert.equal(literalFor('postgres', 'numeric', '42', nulls), '42');
  assert.equal(literalFor('postgres', 'numeric', '-1.5e3', nulls), '-1.5e3');
  assert.equal(literalFor('postgres', 'numeric', '1,000', nulls), "'1,000'");
  assert.equal(literalFor('mysql', 'numeric', 'abc', nulls), "'abc'");
});

test('literalFor boolean kind per dialect', () => {
  for (const word of ['true', 'T', 'yes', 'Y', '1']) {
    assert.equal(literalFor('postgres', 'boolean', word, nulls), 'TRUE', word);
    assert.equal(literalFor('mysql', 'boolean', word, nulls), 'TRUE', word);
    assert.equal(literalFor('sqlite', 'boolean', word, nulls), '1', word);
  }
  for (const word of ['false', 'F', 'no', 'N', '0']) {
    assert.equal(literalFor('postgres', 'boolean', word, nulls), 'FALSE', word);
    assert.equal(literalFor('mysql', 'boolean', word, nulls), 'FALSE', word);
    assert.equal(literalFor('sqlite', 'boolean', word, nulls), '0', word);
  }
  assert.equal(literalFor('postgres', 'boolean', 'maybe', nulls), "'maybe'");
});

test('literalFor text kind quotes with dialect escaping', () => {
  assert.equal(literalFor('postgres', 'text', "O'Hara", nulls), "'O''Hara'");
  assert.equal(literalFor('sqlite', 'text', 'back\\slash', nulls), "'back\\slash'");
  assert.equal(literalFor('mysql', 'text', "O'Hara\\x", nulls), "'O''Hara\\\\x'");
  assert.equal(literalFor('postgres', 'text', '42', nulls), "'42'");
});

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------

const newColumns = [
  { name: 'email', sqlType: 'text' },
  { name: 'name', sqlType: 'text' },
  { name: 'created_at', sqlType: 'timestamp' },
];

test('buildCreateTable per dialect', () => {
  assert.equal(
    buildCreateTable('postgres', 'public', 'new_customers', newColumns),
    'CREATE TABLE "public"."new_customers"\n(\n    "email" text,\n    "name" text,\n    "created_at" timestamp\n);',
  );
  assert.equal(
    buildCreateTable('mysql', 'shop', 'new_customers', [
      { name: 'email', sqlType: 'text' },
      { name: 'active', sqlType: 'tinyint(1)' },
    ]),
    'CREATE TABLE `shop`.`new_customers`\n(\n    `email` text,\n    `active` tinyint(1)\n);',
  );
  assert.equal(
    buildCreateTable('sqlite', undefined, 'new customers', [{ name: 'id', sqlType: 'INTEGER' }]),
    'CREATE TABLE "new customers"\n(\n    "id" INTEGER\n);',
  );
  assert.throws(() => buildCreateTable('postgres', undefined, 't', []), /without columns/);
});

const plan: ImportPlanInput = {
  dialect: 'postgres',
  schema: 'public',
  table: 'customers',
  columns: [
    { source: 0, target: 'email', kind: 'text' },
    { source: 1, target: 'name', kind: 'text' },
    { source: 2, target: 'age', kind: 'numeric' },
    { source: 3, target: 'active', kind: 'boolean' },
  ],
  nullText: '\\N',
  emptyAsNull: false,
  batchSize: 2,
};

const rows = [
  ['a@x.io', 'Ada', '36', 'yes'],
  ['b@x.io', "O'Brien", '', 'no'],
  ['c@x.io', '\\N', '41', ''],
];

test('buildInsertBatches emits aligned multi-row inserts per batch', () => {
  const batches = buildInsertBatches(plan, rows);
  assert.deepEqual(batches, [
    'INSERT INTO "public"."customers" ("email", "name", "age", "active")\n' +
      "VALUES ('a@x.io', 'Ada', 36, TRUE),\n" +
      "       ('b@x.io', 'O''Brien', NULL, FALSE);",
    'INSERT INTO "public"."customers" ("email", "name", "age", "active")\n' +
      "VALUES ('c@x.io', NULL, 41, NULL);",
  ]);
});

test('buildInsertBatches handles edge cases', () => {
  assert.deepEqual(buildInsertBatches(plan, []), []);
  assert.equal(buildInsertBatches({ ...plan, batchSize: 0 }, rows).length, 3);
  assert.equal(buildInsertBatches({ ...plan, batchSize: -5 }, rows).length, 3);
  assert.equal(buildInsertBatches({ ...plan, batchSize: 100 }, rows).length, 1);
  assert.equal(buildInsertBatches({ ...plan, batchSize: Number.NaN }, rows).length, 3);
  // A source index beyond the row reads as an empty cell.
  const wide = buildInsertBatches({ ...plan, columns: [{ source: 9, target: 'x', kind: 'text' }] }, [['a']]);
  assert.deepEqual(wide, ['INSERT INTO "public"."customers" ("x")\nVALUES (\'\');']);
  assert.throws(() => buildInsertBatches({ ...plan, columns: [] }, rows), /without any mapped columns/);
});

test('buildInsertBatches quotes identifiers per dialect', () => {
  const mysql = buildInsertBatches({ ...plan, dialect: 'mysql', schema: undefined, batchSize: 10 }, [rows[0]!]);
  assert.deepEqual(mysql, [
    "INSERT INTO `customers` (`email`, `name`, `age`, `active`)\nVALUES ('a@x.io', 'Ada', 36, TRUE);",
  ]);
  const sqlite = buildInsertBatches({ ...plan, dialect: 'sqlite', schema: undefined, batchSize: 10 }, [rows[0]!]);
  assert.deepEqual(sqlite, [
    'INSERT INTO "customers" ("email", "name", "age", "active")\nVALUES (\'a@x.io\', \'Ada\', 36, 1);',
  ]);
});

test('buildRowInsert emits a single-row statement', () => {
  assert.equal(
    buildRowInsert(plan, rows[1]!),
    'INSERT INTO "public"."customers" ("email", "name", "age", "active")\n' +
      "VALUES ('b@x.io', 'O''Brien', NULL, FALSE);",
  );
});

// ---------------------------------------------------------------------------
// end to end against SQLite
// ---------------------------------------------------------------------------

function sqliteConfig(file: string): DataSourceConfig {
  return {
    id: 'import-test',
    name: 'import-test',
    driver: 'sqlite',
    color: 'none',
    readOnly: false,
    autoSync: true,
    auth: 'none',
    file,
  };
}

test('import pipeline end to end with SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablecloth-import-'));
  const session = await sqliteDriver.connect({ config: sqliteConfig(join(dir, 'import.db')), secrets: {} });
  try {
    const text =
      '\uFEFFEmail Address,Full Name,Age,Active,Joined\r\n' +
      'ada@example.com,"Lovelace, Ada",36,yes,2024-01-31\r\n' +
      'grace@example.com,"Hopper ""Amazing"" Grace",,no,2024-02-29\r\n' +
      'linus@example.com,\\N,54,,2024-03-01\r\n' +
      "mary@example.com,O'Neil,29,true,2024-03-15\r\n" +
      'ken@example.com,Ken,,false,\r\n';

    const delimiter = detectDelimiter(text);
    assert.equal(delimiter, ',');
    const opts: DelimitedOptions = { delimiter, quote: '"', hasHeader: true, trim: true };
    assert.equal(countDataRows(text, opts), 5);
    const table = parseDelimited(text, opts);
    assert.deepEqual(table.headers, ['Email Address', 'Full Name', 'Age', 'Active', 'Joined']);

    const used = new Set<string>();
    const nullText = '\\N';
    const definitions = table.headers.map((header, i) => {
      const inferred = inferColumnType(
        table.rows.map((r) => r[i]!),
        nullText,
      );
      return { name: suggestColumnName(header, used), inferred, sqlType: sqlTypeFor('sqlite', inferred) };
    });
    assert.deepEqual(
      definitions.map((d) => [d.name, d.inferred]),
      [
        ['email_address', 'text'],
        ['full_name', 'text'],
        ['age', 'integer'],
        ['active', 'boolean'],
        ['joined', 'date'],
      ],
    );

    const ddl = buildCreateTable('sqlite', undefined, 'people', definitions);
    await session.query(ddl);

    const input: ImportPlanInput = {
      dialect: 'sqlite',
      table: 'people',
      columns: definitions.map((d, i) => ({ source: i, target: d.name, kind: valueKindForInferred(d.inferred) })),
      nullText,
      emptyAsNull: false,
      batchSize: 2,
    };
    const batches = buildInsertBatches(input, table.rows);
    assert.equal(batches.length, 3);
    let inserted = 0;
    for (const statement of batches) {
      const result = await session.query(statement);
      inserted += result.affectedRows ?? 0;
    }
    assert.equal(inserted, 5);

    const retry = await session.query(buildRowInsert(input, ['solo@example.com', 'Solo', '7', 'y', '2024-04-01']));
    assert.equal(retry.affectedRows, 1);

    const back = await session.query('SELECT email_address, full_name, age, active, joined FROM people ORDER BY rowid');
    assert.deepEqual(
      back.columns.map((c) => c.name),
      ['email_address', 'full_name', 'age', 'active', 'joined'],
    );
    assert.deepEqual(back.rows, [
      ['ada@example.com', 'Lovelace, Ada', 36, 1, '2024-01-31'],
      ['grace@example.com', 'Hopper "Amazing" Grace', null, 0, '2024-02-29'],
      ['linus@example.com', null, 54, null, '2024-03-01'],
      ['mary@example.com', "O'Neil", 29, 1, '2024-03-15'],
      ['ken@example.com', 'Ken', null, 0, ''],
      ['solo@example.com', 'Solo', 7, 1, '2024-04-01'],
    ]);

    const typed = await session.query(
      "SELECT typeof(age), typeof(active), typeof(joined) FROM people WHERE email_address = 'ada@example.com'",
    );
    assert.deepEqual(typed.rows[0], ['integer', 'integer', 'text']);
  } finally {
    await session.close();
  }
});

test('import into an existing table maps headers onto its columns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablecloth-import-'));
  const session = await sqliteDriver.connect({ config: sqliteConfig(join(dir, 'existing.db')), secrets: {} });
  try {
    await session.query(
      'CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL, first_name TEXT, vip BOOLEAN)',
    );
    const catalog = await sqliteDriver.introspect(session, sqliteConfig(''), false);
    const customers = catalog.databases[0]!.schemas[0]!.relations.find((r) => r.name === 'customers')!;
    const tableColumns = customers.columns.map((c) => c.name);

    const table = parseDelimited('ID,EMAIL,First Name,VIP\n1,a@x.io,Ada,true\n2,b@x.io,,false\n', csv);
    const columns = table.headers.flatMap((header, source) => {
      const target = matchTableColumn(header, tableColumns);
      if (!target) return [];
      const column = customers.columns.find((c) => c.name === target)!;
      return [{ source, target, kind: valueKindForSqlType(column.dataType) }];
    });
    assert.deepEqual(
      columns.map((c) => `${c.target}:${c.kind}`),
      ['id:numeric', 'email:text', 'first_name:text', 'vip:boolean'],
    );

    const input: ImportPlanInput = {
      dialect: 'sqlite',
      table: 'customers',
      columns,
      nullText: '',
      emptyAsNull: true,
      batchSize: 50,
    };
    for (const statement of buildInsertBatches(input, table.rows)) await session.query(statement);
    const back = await session.query('SELECT id, email, first_name, vip FROM customers ORDER BY id');
    assert.deepEqual(back.rows, [
      [1, 'a@x.io', 'Ada', 1],
      [2, 'b@x.io', null, 0],
    ]);
  } finally {
    await session.close();
  }
});

test('valueKindForInferred maps inferred types to literal kinds', () => {
  assert.equal(valueKindForInferred('integer'), 'numeric');
  assert.equal(valueKindForInferred('bigint'), 'numeric');
  assert.equal(valueKindForInferred('numeric'), 'numeric');
  assert.equal(valueKindForInferred('boolean'), 'boolean');
  assert.equal(valueKindForInferred('date'), 'text');
  assert.equal(valueKindForInferred('timestamp'), 'text');
  assert.equal(valueKindForInferred('text'), 'text');
});

test('matchTableColumn falls back to a whole word of the header', () => {
  const columns = ['id', 'email', 'name', 'created_at', 'first_name'];
  assert.equal(matchTableColumn('Email Address', columns), 'email');
  assert.equal(matchTableColumn('Full Name', columns), 'name');
  assert.equal(matchTableColumn('First Name', columns), 'first_name', 'a multi-word column wins over its parts');
  assert.equal(matchTableColumn('Signup Date', columns), undefined);
  assert.equal(matchTableColumn('e mail', columns), undefined, 'single letters never match');
});

test('word matches only map a header that names exactly one column', () => {
  assert.equal(matchTableColumn('Email Address', ['id', 'email', 'address']), undefined, 'two candidates is a guess');
  assert.equal(matchTableColumn('Email Address', ['id', 'email', 'name']), 'email');
});

test('matchTableColumns never proposes the same table column twice', () => {
  assert.deepEqual(matchTableColumns(['First Name', 'Last Name', 'id'], ['id', 'name', 'email']), ['name', undefined, 'id']);
  assert.deepEqual(matchTableColumns(['Full Name', 'name'], ['id', 'name']), [undefined, 'name'], 'a name match beats an earlier word match');
  assert.deepEqual(matchTableColumns(['email', 'Email'], ['Email', 'email']), ['email', 'Email']);
});

test('duplicateTarget reports the first target mapped twice', () => {
  assert.equal(duplicateTarget([{ target: 'name' }, { target: '' }, { target: 'email' }]), undefined);
  assert.equal(duplicateTarget([{ target: 'name' }, { target: 'email' }, { target: 'name ' }]), 'name');
});

test('the null marker is ignored when inferring a column type', () => {
  assert.equal(inferColumnType(['1', 'NULL', '3'], 'NULL'), 'integer');
  assert.equal(inferColumnType(['1', 'NULL', '3']), 'text');
  assert.equal(inferColumnType(['2024-01-01', '\\N', ''], '\\N'), 'date');
});
