// Cell ordering for the client-side sort. Numeric text is compared exactly
// (integers and plain decimals of any length) so neighbouring bigints and
// high-precision decimals keep their order instead of collapsing in a double.
import type { CellValue } from '../../core/types';

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^([+-]?)(\d*)\.(\d*)$/;

interface ExactNumber {
  negative: boolean;
  /** Digits before the point, without leading zeros ('' for zero). */
  integer: string;
  /** Digits after the point, without trailing zeros. */
  fraction: string;
}

function parseExact(text: string): ExactNumber | undefined {
  let sign = '';
  let integer: string;
  let fraction: string;
  if (INTEGER.test(text)) {
    if (text[0] === '+' || text[0] === '-') sign = text[0]!;
    integer = text.replace(/^[+-]/, '');
    fraction = '';
  } else {
    const match = DECIMAL.exec(text);
    if (!match || (match[2] === '' && match[3] === '')) return undefined;
    sign = match[1]!;
    integer = match[2]!;
    fraction = match[3]!;
  }
  integer = integer.replace(/^0+/, '');
  fraction = fraction.replace(/0+$/, '');
  const zero = integer === '' && fraction === '';
  return { negative: sign === '-' && !zero, integer, fraction };
}

function compareMagnitude(a: ExactNumber, b: ExactNumber): number {
  if (a.integer.length !== b.integer.length) return a.integer.length < b.integer.length ? -1 : 1;
  if (a.integer !== b.integer) return a.integer < b.integer ? -1 : 1;
  if (a.fraction === b.fraction) return 0;
  return a.fraction < b.fraction ? -1 : 1;
}

/** Exact ordering of two numeric texts, or undefined when either is not a plain integer or decimal. */
export function compareNumericText(a: string, b: string): number | undefined {
  const x = parseExact(a);
  const y = parseExact(b);
  if (!x || !y) return undefined;
  if (x.negative !== y.negative) return x.negative ? -1 : 1;
  const magnitude = compareMagnitude(x, y);
  return x.negative ? -magnitude : magnitude;
}

/**
 * Ascending order of two cell values: NULLs first; numeric columns by value,
 * exactly where the text allows and by double otherwise (exponents, infinities);
 * everything else by locale-aware text.
 */
export function compareCells(a: CellValue, b: CellValue, numeric: boolean): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  const sa = String(a);
  const sb = String(b);
  if (numeric) {
    const exact = compareNumericText(sa.trim(), sb.trim());
    if (exact !== undefined) return exact;
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  }
  return sa.localeCompare(sb);
}
