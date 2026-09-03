import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { buildXlsx, crc32, numericLiteral } from '../src/export/xlsx';
import { DEFAULT_EXTRACTOR_OPTIONS, getBinaryExtractor, getExtractor } from '../src/export/extractors';
import type { CellValue, ColumnInfo } from '../src/core/types';

const columns: ColumnInfo[] = [{ name: 'id', numeric: true }, { name: 'email' }, { name: 'note' }, { name: 'active' }];
const rows: CellValue[][] = [
  [1, 'ada@example.com', null, true],
  ['12.50', ' padded ', 'a & b', false],
];

const EXPECTED_ENTRIES = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/styles.xml',
  'xl/worksheets/sheet1.xml',
];

interface Entry {
  name: string;
  crc: number;
  data: Uint8Array;
}

/** Walk the central directory back to each local header, checking the container layout along the way. */
function readZip(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, 'EOCD signature sits at the end of the file');
  assert.equal(view.getUint16(eocd + 20, true), 0, 'no archive comment');
  const count = view.getUint16(eocd + 10, true);
  assert.equal(view.getUint16(eocd + 8, true), count);
  const centralSize = view.getUint32(eocd + 12, true);
  let offset = view.getUint32(eocd + 16, true);
  assert.equal(offset + centralSize, eocd, 'central directory ends where the EOCD begins');

  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(offset, true), 0x02014b50, 'central directory signature');
    assert.equal(view.getUint16(offset + 10, true), 0, 'stored entry');
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    assert.equal(compressedSize, size, 'stored entries have equal sizes');
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    assert.equal(view.getUint32(local, true), 0x04034b50, `local header signature for ${name}`);
    assert.equal(view.getUint32(local + 14, true), crc, `local and central CRC agree for ${name}`);
    assert.equal(view.getUint32(local + 22, true), size, `local and central size agree for ${name}`);
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    assert.equal(decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)), name);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    entries.push({ name, crc, data: bytes.subarray(dataStart, dataStart + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function part(bytes: Uint8Array, name: string): string {
  const entry = readZip(bytes).find((e) => e.name === name);
  assert.ok(entry, `${name} is present`);
  return new TextDecoder().decode(entry.data);
}

const zlibCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array) => number }).crc32;

test('crc32 matches the standard check values', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('the package is a stored ZIP with the expected parts', () => {
  const bytes = buildXlsx({ columns, rows });
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'starts with a local file header');
  const entries = readZip(bytes);
  assert.deepEqual(
    entries.map((e) => e.name),
    EXPECTED_ENTRIES,
  );
  assert.match(part(bytes, '[Content_Types].xml'), /PartName="\/xl\/worksheets\/sheet1\.xml"/);
  assert.match(part(bytes, '_rels/.rels'), /Target="xl\/workbook\.xml"/);
  assert.match(part(bytes, 'xl/_rels/workbook.xml.rels'), /Target="worksheets\/sheet1\.xml"/);
  assert.match(part(bytes, 'xl/_rels/workbook.xml.rels'), /Target="styles\.xml"/);
});

const crcSkip = zlibCrc32 ? false : 'zlib.crc32 is not available on this node';

test('entry CRC32 fields match node:zlib', { skip: crcSkip }, () => {
  for (const entry of readZip(buildXlsx({ columns, rows }))) {
    assert.equal(entry.crc, zlibCrc32!(entry.data) >>> 0, `crc of ${entry.name}`);
  }
});

test('styles define a default font and a bold font at cellXfs index 1', () => {
  const styles = part(buildXlsx({ columns, rows }), 'xl/styles.xml');
  assert.match(styles, /<fonts count="2"><font>[^<]*<sz val="11"\/>/);
  assert.match(styles, /<font><b\/>/);
  assert.match(
    styles,
    /<cellXfs count="2"><xf numFmtId="0" fontId="0"[^>]*\/><xf numFmtId="0" fontId="1"[^>]*applyFont="1"\/><\/cellXfs>/,
  );
});

test('the sheet has a bold inline-string header row and typed data cells', () => {
  const sheet = part(buildXlsx({ columns, rows }), 'xl/worksheets/sheet1.xml');
  assert.ok(
    sheet.startsWith(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
    ),
  );
  assert.ok(sheet.includes('<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>id</t></is></c>'));
  assert.ok(sheet.includes('<c r="B1" s="1" t="inlineStr"><is><t>email</t></is></c>'));
  assert.ok(sheet.includes('<c r="D1" s="1" t="inlineStr"><is><t>active</t></is></c></row>'));
  // numbers, strings, nulls (omitted) and booleans
  assert.ok(
    sheet.includes(
      '<row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>ada@example.com</t></is></c>' +
        '<c r="D2" t="b"><v>1</v></c></row>',
    ),
  );
  assert.ok(!sheet.includes('r="C2"'), 'null cell is omitted');
  // numeric-column strings become numbers verbatim; padded strings preserve their whitespace; text is escaped
  assert.ok(sheet.includes('<c r="A3"><v>12.50</v></c>'));
  assert.ok(sheet.includes('<c r="B3" t="inlineStr"><is><t xml:space="preserve"> padded </t></is></c>'));
  assert.ok(sheet.includes('<c r="C3" t="inlineStr"><is><t>a &amp; b</t></is></c>'));
  assert.ok(sheet.includes('<c r="D3" t="b"><v>0</v></c></row></sheetData></worksheet>'));
});

test('non-numeric text in a numeric column stays text and XML-invalid control characters are stripped', () => {
  const sheet = part(
    buildXlsx({ columns: [{ name: 'n', numeric: true }, { name: 's' }], rows: [['abc', 'a\u0001b\tc']] }),
    'xl/worksheets/sheet1.xml',
  );
  assert.ok(sheet.includes('<c r="A2" t="inlineStr"><is><t>abc</t></is></c>'));
  assert.ok(sheet.includes('<c r="B2" t="inlineStr"><is><t>ab\tc</t></is></c>'));
});

test('numeric strings beyond Excel precision are written as text', () => {
  const sheet = part(
    buildXlsx({ columns: [{ name: 'bigint', numeric: true }, { name: 'decimal', numeric: true }], rows: [['9007199254740993', '123456789012345.1']] }),
    'xl/worksheets/sheet1.xml',
  );
  assert.ok(sheet.includes('<c r="A2" t="inlineStr"><is><t>9007199254740993</t></is></c>'));
  assert.ok(sheet.includes('<c r="B2" t="inlineStr"><is><t>123456789012345.1</t></is></c>'));
});

test('numericLiteral passes numeric-column strings through verbatim without Excel limits', () => {
  const numeric: ColumnInfo = { name: 'n', numeric: true };
  assert.equal(numericLiteral(numeric, '9007199254740993'), '9007199254740993');
  assert.equal(numericLiteral(numeric, '1234567890.1234567'), '1234567890.1234567');
  assert.equal(numericLiteral(numeric, '-123456789012345678901234567890'), '-123456789012345678901234567890');
  assert.equal(numericLiteral(numeric, '12.50'), '12.50');
  assert.equal(numericLiteral(numeric, '+5'), '5');
  assert.equal(numericLiteral(numeric, '.5'), '0.5');
  assert.equal(numericLiteral(numeric, 7), '7');
  assert.equal(numericLiteral(numeric, 'abc'), undefined);
  assert.equal(numericLiteral(numeric, '1e400'), undefined);
  assert.equal(numericLiteral(numeric, NaN), undefined);
  assert.equal(numericLiteral({ name: 's' }, '12.50'), undefined);
});

test('values beyond Excel precision stay numbers in JSON but are written to xlsx as text', () => {
  const precise: ColumnInfo[] = [
    { name: 'big', numeric: true },
    { name: 'dec', numeric: true },
  ];
  const preciseRows: CellValue[][] = [['9007199254740993', '1234567890.1234567']];
  const json = getExtractor('json')!.extract(
    { dialect: 'postgres', columns: precise, rows: preciseRows },
    DEFAULT_EXTRACTOR_OPTIONS,
  );
  assert.ok(json.includes('"big": 9007199254740993,'));
  assert.ok(json.includes('"dec": 1234567890.1234567'));
  const sheet = part(buildXlsx({ columns: precise, rows: preciseRows }), 'xl/worksheets/sheet1.xml');
  assert.ok(sheet.includes('<c r="A2" t="inlineStr"><is><t>9007199254740993</t></is></c>'));
  assert.ok(sheet.includes('<c r="B2" t="inlineStr"><is><t>1234567890.1234567</t></is></c>'));
});

test('cell references continue past column Z', () => {
  const wide = Array.from({ length: 28 }, (_, i) => ({ name: `c${i}` }));
  const sheet = part(buildXlsx({ columns: wide, rows: [wide.map((c) => c.name)] }), 'xl/worksheets/sheet1.xml');
  assert.ok(sheet.includes('<c r="Z1" s="1" t="inlineStr"><is><t>c25</t></is></c>'));
  assert.ok(sheet.includes('<c r="AA1" s="1" t="inlineStr"><is><t>c26</t></is></c>'));
  assert.ok(sheet.includes('<c r="AB2" t="inlineStr"><is><t>c27</t></is></c>'));
});

test('a workbook with no rows still has its header row', () => {
  const sheet = part(buildXlsx({ columns, rows: [] }), 'xl/worksheets/sheet1.xml');
  assert.ok(sheet.endsWith('<is><t>active</t></is></c></row></sheetData></worksheet>\n'));
});

test('sheet names default to Sheet1 and are sanitized to what Excel accepts', () => {
  const sheetName = (name?: string) => {
    const workbook = part(buildXlsx({ columns, rows, sheetName: name }), 'xl/workbook.xml');
    const match = /<sheet name="([^"]*)" sheetId="1" r:id="rId1"\/>/.exec(workbook);
    assert.ok(match, 'workbook lists one sheet');
    return match[1];
  };
  assert.equal(sheetName(), 'Sheet1');
  assert.equal(sheetName(''), 'Sheet1');
  assert.equal(sheetName('public.customers'), 'public.customers');
  assert.equal(sheetName('a/b:c[d]*e?f\\g'), 'a_b_c_d__e_f_g');
  assert.equal(sheetName('x'.repeat(40)), 'x'.repeat(31));
  assert.equal(sheetName("'quoted'"), 'quoted');
  assert.equal(sheetName('a<b&c'), 'a&lt;b&amp;c');
});

test('the xlsx binary extractor honors selectedColumns and names the sheet after the table', () => {
  const xlsx = getBinaryExtractor('xlsx');
  assert.ok(xlsx);
  const bytes = xlsx.extractBinary(
    { dialect: 'postgres', columns, rows, tableName: 'public.customers', selectedColumns: [1, 0] },
    DEFAULT_EXTRACTOR_OPTIONS,
  );
  const sheet = part(bytes, 'xl/worksheets/sheet1.xml');
  assert.ok(
    sheet.includes(
      '<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>email</t></is></c>' +
        '<c r="B1" s="1" t="inlineStr"><is><t>id</t></is></c></row>',
    ),
  );
  assert.ok(
    sheet.includes(
      '<row r="2"><c r="A2" t="inlineStr"><is><t>ada@example.com</t></is></c><c r="B2"><v>1</v></c></row>',
    ),
  );
  assert.ok(!sheet.includes('r="C1"'));
  assert.match(part(bytes, 'xl/workbook.xml'), /<sheet name="public\.customers"/);
});
