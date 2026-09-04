/**
 * Delimited-text parsing for the Import Data dialog. Pure TypeScript with no
 * node or vscode imports because the same code runs in the extension host and
 * inside the dialog webview (for the live preview).
 */

export interface DelimitedOptions {
  /** One character, or '\t'. */
  delimiter: string;
  /** Usually '"'; the empty string disables quoting entirely. */
  quote: string;
  hasHeader: boolean;
  /** Trim whitespace around unquoted cells. */
  trim: boolean;
}

export interface DelimitedTable {
  /** From the header row, else 'column1'..'columnN'. */
  headers: string[];
  /** Data rows only, each padded with '' to headers.length. */
  rows: string[][];
}

export type DelimiterId = 'comma' | 'tab' | 'semicolon' | 'pipe';

export const DELIMITERS: { id: DelimiterId; label: string; char: string }[] = [
  { id: 'comma', label: 'Comma', char: ',' },
  { id: 'tab', label: 'Tab', char: '\t' },
  { id: 'semicolon', label: 'Semicolon', char: ';' },
  { id: 'pipe', label: 'Pipe', char: '|' },
];

const BOM = '\uFEFF';
const DETECT_SAMPLE_LINES = 20;

function isLineBreak(ch: string): boolean {
  return ch === '\n' || ch === '\r';
}

/**
 * Walk the text and yield one string[] per non-empty record. A record is empty
 * when it has a single unquoted '' cell, which covers blank lines and the
 * trailing newline; a lone "" on a line is a real one-cell row.
 */
function* records(text: string, opts: DelimitedOptions): Generator<string[]> {
  const { delimiter, quote, trim } = opts;
  const n = text.length;
  let i = text.startsWith(BOM) ? 1 : 0;
  let fields: string[] = [];
  let anyQuoted = false;

  while (i <= n) {
    let value = '';
    let quoted = false;
    let j = i;

    if (quote !== '' && trim) {
      // Allow whitespace between the delimiter and an opening quote (`a, "b"`).
      let k = j;
      while (k < n && /\s/.test(text.charAt(k)) && text.charAt(k) !== delimiter && !isLineBreak(text.charAt(k))) k++;
      if (k < n && text.charAt(k) === quote) j = k;
    }

    if (quote !== '' && j < n && text.charAt(j) === quote) {
      quoted = true;
      j++;
      let chunkStart = j;
      while (j < n) {
        const ch = text.charAt(j);
        if (ch !== quote) {
          j++;
          continue;
        }
        value += text.slice(chunkStart, j);
        if (text.charAt(j + 1) === quote) {
          value += quote;
          j += 2;
          chunkStart = j;
          continue;
        }
        j++;
        chunkStart = -1;
        break;
      }
      // Unterminated quote: keep whatever was read so nothing silently disappears.
      if (chunkStart >= 0) value += text.slice(chunkStart, j);
      // Lenient handling of text after the closing quote: append it (dropping
      // whitespace when trimming) instead of failing the whole file.
      while (j < n && text.charAt(j) !== delimiter && !isLineBreak(text.charAt(j))) {
        const ch = text.charAt(j);
        if (!(trim && /\s/.test(ch))) value += ch;
        j++;
      }
    } else {
      while (j < n && text.charAt(j) !== delimiter && !isLineBreak(text.charAt(j))) j++;
      value = text.slice(i, j);
      if (trim) value = value.trim();
    }

    fields.push(value);
    if (quoted) anyQuoted = true;

    if (j < n && text.charAt(j) === delimiter) {
      i = j + 1;
      continue;
    }

    const atEnd = j >= n;
    if (!atEnd) j += text.charAt(j) === '\r' && text.charAt(j + 1) === '\n' ? 2 : 1;
    const empty = fields.length === 1 && fields[0] === '' && !anyQuoted;
    if (!empty) yield fields;
    fields = [];
    anyQuoted = false;
    if (atEnd) return;
    i = j;
  }
}

export function parseDelimited(text: string, opts: DelimitedOptions): DelimitedTable {
  let headers: string[] | undefined;
  const rows: string[][] = [];
  for (const record of records(text, opts)) {
    if (opts.hasHeader && headers === undefined) {
      headers = record;
      continue;
    }
    rows.push(record);
  }

  headers ??= [];
  let width = headers.length;
  for (const row of rows) {
    if (row.length > width) width = row.length;
  }
  // Blank header cells and cells beyond the header row both get positional names.
  for (let c = 0; c < width; c++) {
    if (!headers[c]) headers[c] = `column${c + 1}`;
  }
  for (const row of rows) {
    while (row.length < width) row.push('');
  }
  return { headers, rows };
}

/** Same scanner as parseDelimited, without keeping the rows. */
export function countDataRows(text: string, opts: DelimitedOptions): number {
  let count = 0;
  const it = records(text, opts);
  while (!it.next().done) count++;
  return opts.hasHeader ? Math.max(0, count - 1) : count;
}

interface DelimiterScore {
  /** 2: same non-zero count on every line; 1: present with a dominant count; 0: absent. */
  tier: number;
  primary: number;
  secondary: number;
}

function scoreCounts(perLine: number[]): DelimiterScore {
  if (perLine.length === 0) return { tier: 0, primary: 0, secondary: 0 };
  const first = perLine[0]!;
  if (first > 0 && perLine.every((c) => c === first)) return { tier: 2, primary: first, secondary: 0 };
  const freq = new Map<number, number>();
  for (const c of perLine) {
    if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
  }
  let modeValue = 0;
  let modeFreq = 0;
  for (const [value, count] of freq) {
    if (count > modeFreq || (count === modeFreq && value > modeValue)) {
      modeValue = value;
      modeFreq = count;
    }
  }
  if (modeFreq === 0) return { tier: 0, primary: 0, secondary: 0 };
  return { tier: 1, primary: modeFreq / perLine.length, secondary: modeValue };
}

function betterScore(a: DelimiterScore, b: DelimiterScore): boolean {
  if (a.tier !== b.tier) return a.tier > b.tier;
  if (a.primary !== b.primary) return a.primary > b.primary;
  return a.secondary > b.secondary;
}

/**
 * Pick the candidate delimiter whose per-line count is most consistent over the
 * first 20 non-empty lines, preferring larger counts; ties go to the comma.
 * Double quotes at the start of a field hide the delimiters inside them.
 */
export function detectDelimiter(sample: string): string {
  const candidates = DELIMITERS.map((d) => d.char);
  const perLine: number[][] = candidates.map(() => []);
  let line = candidates.map(() => 0);
  let lineHasContent = false;
  let inQuotes = false;
  let atFieldStart = true;
  let lines = 0;

  const flushLine = () => {
    if (lineHasContent) {
      candidates.forEach((_, k) => perLine[k]!.push(line[k]!));
      lines++;
    }
    line = candidates.map(() => 0);
    lineHasContent = false;
    atFieldStart = true;
  };

  for (let i = sample.startsWith(BOM) ? 1 : 0; i < sample.length && lines < DETECT_SAMPLE_LINES; i++) {
    const ch = sample.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (sample.charAt(i + 1) === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (isLineBreak(ch)) {
      if (ch === '\r' && sample.charAt(i + 1) === '\n') i++;
      flushLine();
      continue;
    }
    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      lineHasContent = true;
      atFieldStart = false;
      continue;
    }
    if (ch !== ' ') lineHasContent = true;
    const k = candidates.indexOf(ch);
    if (k >= 0) {
      line[k]!++;
      atFieldStart = true;
    } else {
      atFieldStart = false;
    }
  }
  if (lines < DETECT_SAMPLE_LINES) flushLine();

  let best = 0;
  let bestScore = scoreCounts(perLine[0]!);
  for (let k = 1; k < candidates.length; k++) {
    const score = scoreCounts(perLine[k]!);
    if (betterScore(score, bestScore)) {
      best = k;
      bestScore = score;
    }
  }
  return candidates[best]!;
}
