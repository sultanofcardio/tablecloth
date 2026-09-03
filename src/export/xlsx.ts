import type { CellValue, ColumnInfo } from '../core/types';

/**
 * Minimal Office Open XML workbook writer. Pure TypeScript with no node-only
 * imports because it is bundled into both the extension host and the webview.
 */

export interface XlsxInput {
  columns: ColumnInfo[];
  rows: CellValue[][];
  /** Defaults to Sheet1; sanitized to Excel's 31-character limit. */
  sheetName?: string;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';

/** cellXfs index of the bold style used for the header row. */
const BOLD_STYLE = 1;
const SHEET_NAME_MAX = 31;
const DEFAULT_SHEET_NAME = 'Sheet1';

export function buildXlsx(input: XlsxInput): Uint8Array {
  const sheetName = sanitizeSheetName(input.sheetName);
  return zip([
    { name: '[Content_Types].xml', text: contentTypesXml() },
    { name: '_rels/.rels', text: rootRelsXml() },
    { name: 'xl/workbook.xml', text: workbookXml(sheetName) },
    { name: 'xl/_rels/workbook.xml.rels', text: workbookRelsXml() },
    { name: 'xl/styles.xml', text: stylesXml() },
    { name: 'xl/worksheets/sheet1.xml', text: sheetXml(input.columns, input.rows) },
  ]);
}

// ---------------------------------------------------------------------------
// Cell values
// ---------------------------------------------------------------------------

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const LOOSE_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * The number token to emit for a cell, or undefined when it should be written as text.
 * Drivers hand back bigint and decimal columns as strings; those pass through
 * verbatim so no precision is lost in formats such as JSON that have no limit.
 */
export function numericLiteral(column: ColumnInfo, value: CellValue): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value !== 'string' || !column.numeric) return undefined;
  if (!LOOSE_NUMBER.test(value) || !Number.isFinite(Number(value))) return undefined;
  return JSON_NUMBER.test(value) ? value : String(Number(value));
}

/**
 * The number token to write into an Excel cell, or undefined when it should be text.
 * Excel stores doubles and keeps 15 significant digits, so integers outside the
 * safe range and longer decimals are kept as text instead of being silently rounded.
 */
function excelNumber(column: ColumnInfo, value: CellValue): string | undefined {
  const token = numericLiteral(column, value);
  if (token === undefined) return undefined;
  if (typeof value === 'number') return Number.isInteger(value) && !Number.isSafeInteger(value) ? undefined : token;
  const text = String(value);
  if (/^[+-]?\d+$/.test(text)) {
    const integer = BigInt(text);
    if (integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  }
  const mantissa = text.replace(/^[+-]/, '').split(/[eE]/)[0] ?? '';
  const significantDigits = mantissa.replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length;
  return significantDigits > 15 ? undefined : token;
}

export function escapeXmlText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function escapeXmlAttr(text: string): string {
  return escapeXmlText(text).replaceAll('"', '&quot;');
}

/** Control characters other than tab, CR and LF cannot appear in XML 1.0 and make Excel report corruption. */
function stripInvalidXml(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

function inlineString(text: string): string {
  const clean = stripInvalidXml(text);
  const preserve = /^\s|\s$/.test(clean) ? ' xml:space="preserve"' : '';
  return `<is><t${preserve}>${escapeXmlText(clean)}</t></is>`;
}

/** Zero-based column index to its A1-style letters (0 -> A, 25 -> Z, 26 -> AA). */
function columnLetters(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cellXml(ref: string, column: ColumnInfo, value: CellValue): string | undefined {
  if (value === null) return undefined;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const num = excelNumber(column, value);
  if (num !== undefined) return `<c r="${ref}"><v>${num}</v></c>`;
  return `<c r="${ref}" t="inlineStr">${inlineString(String(value))}</c>`;
}

function sanitizeSheetName(name: string | undefined): string {
  const clean = (name ?? '')
    .replace(/[[\]:*?/\\]/g, '_')
    .slice(0, SHEET_NAME_MAX)
    .replace(/^'+|'+$/g, '')
    .trim();
  return clean || DEFAULT_SHEET_NAME;
}

// ---------------------------------------------------------------------------
// Package parts
// ---------------------------------------------------------------------------

function sheetXml(columns: ColumnInfo[], rows: CellValue[][]): string {
  const parts: string[] = [XML_DECLARATION, `<worksheet xmlns="${NS_MAIN}"><sheetData>`];
  parts.push('<row r="1">');
  columns.forEach((column, c) => {
    parts.push(`<c r="${columnLetters(c)}1" s="${BOLD_STYLE}" t="inlineStr">${inlineString(column.name)}</c>`);
  });
  parts.push('</row>');
  rows.forEach((row, r) => {
    const rowNumber = r + 2;
    parts.push(`<row r="${rowNumber}">`);
    columns.forEach((column, c) => {
      const cell = cellXml(`${columnLetters(c)}${rowNumber}`, column, row[c] ?? null);
      if (cell !== undefined) parts.push(cell);
    });
    parts.push('</row>');
  });
  parts.push('</sheetData></worksheet>\n');
  return parts.join('');
}

function contentTypesXml(): string {
  return (
    XML_DECLARATION +
    `<Types xmlns="${NS_CONTENT_TYPES}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>\n'
  );
}

function rootRelsXml(): string {
  return (
    XML_DECLARATION +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_DOC_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    '</Relationships>\n'
  );
}

function workbookXml(sheetName: string): string {
  return (
    XML_DECLARATION +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_DOC_REL}">` +
    `<sheets><sheet name="${escapeXmlAttr(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>\n'
  );
}

function workbookRelsXml(): string {
  return (
    XML_DECLARATION +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_DOC_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${NS_DOC_REL}/styles" Target="styles.xml"/>` +
    '</Relationships>\n'
  );
}

/** Excel insists on the two default fills and a Normal cell style even in a minimal stylesheet. */
function stylesXml(): string {
  return (
    XML_DECLARATION +
    `<styleSheet xmlns="${NS_MAIN}">` +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="2">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>\n'
  );
}

// ---------------------------------------------------------------------------
// ZIP container (stored entries only)
// ---------------------------------------------------------------------------

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
/** General purpose bit 11: entry names are UTF-8. */
const UTF8_NAMES_FLAG = 0x0800;
const METHOD_STORED = 0;
/** 1980-01-01 00:00:00, the DOS epoch; a fixed stamp keeps the output deterministic. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  text: string;
}

class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  length = 0;

  u16(value: number): void {
    const chunk = new Uint8Array(2);
    new DataView(chunk.buffer).setUint16(0, value, true);
    this.bytes(chunk);
  }

  u32(value: number): void {
    const chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setUint32(0, value, true);
    this.bytes(chunk);
  }

  bytes(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

function zip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const out = new ByteWriter();
  const central = new ByteWriter();

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const crc = crc32(data);
    const localOffset = out.length;

    out.u32(LOCAL_HEADER_SIGNATURE);
    out.u16(ZIP_VERSION);
    out.u16(UTF8_NAMES_FLAG);
    out.u16(METHOD_STORED);
    out.u16(DOS_TIME);
    out.u16(DOS_DATE);
    out.u32(crc);
    out.u32(data.length);
    out.u32(data.length);
    out.u16(name.length);
    out.u16(0); // extra field length
    out.bytes(name);
    out.bytes(data);

    central.u32(CENTRAL_HEADER_SIGNATURE);
    central.u16(ZIP_VERSION); // version made by
    central.u16(ZIP_VERSION); // version needed to extract
    central.u16(UTF8_NAMES_FLAG);
    central.u16(METHOD_STORED);
    central.u16(DOS_TIME);
    central.u16(DOS_DATE);
    central.u32(crc);
    central.u32(data.length);
    central.u32(data.length);
    central.u16(name.length);
    central.u16(0); // extra field length
    central.u16(0); // comment length
    central.u16(0); // disk number start
    central.u16(0); // internal attributes
    central.u32(0); // external attributes
    central.u32(localOffset);
    central.bytes(name);
  }

  const centralOffset = out.length;
  const centralBytes = central.toUint8Array();
  out.bytes(centralBytes);

  out.u32(EOCD_SIGNATURE);
  out.u16(0); // this disk
  out.u16(0); // disk holding the central directory
  out.u16(entries.length);
  out.u16(entries.length);
  out.u32(centralBytes.length);
  out.u32(centralOffset);
  out.u16(0); // comment length
  return out.toUint8Array();
}
