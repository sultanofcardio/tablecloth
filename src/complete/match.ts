// Prefix matching and text replacement for completion lookups outside Monaco
// (the grid's WHERE / ORDER BY fields). Pure, so the webview bundle and the
// unit tests share it.
import type { DriverId } from '../core/types';
import { tokenize } from '../sql/tokens';
import type { CompletionEntry } from './core';

export interface WordAt {
  /** Offset where the word being completed starts (includes an opening identifier quote). */
  start: number;
  prefix: string;
  /** The caret sits inside a string literal, where nothing completes. */
  inString: boolean;
}

const WORD_CHAR = /[A-Za-z0-9_$]/;

interface QuoteState {
  /** The caret sits inside an unterminated string literal. */
  inString: boolean;
  /** Offset of the identifier quote still open at the caret, or -1. */
  identAt: number;
}

/**
 * Which quote is still open at the end of `before`, read off the tokenizer so
 * comments, MySQL backslash escapes, doubled quotes and the dialect's choice of
 * identifier quote all mean here exactly what they mean everywhere else. An
 * unterminated literal or comment is a place where nothing completes.
 */
function quoteState(before: string, dialect: DriverId): QuoteState {
  const tokens = tokenize(before, dialect);
  const last = tokens[tokens.length - 1];
  if (!last?.unterminated) return { inString: false, identAt: -1 };
  if (last.kind === 'ident') return { inString: false, identAt: last.start };
  return { inString: true, identAt: -1 };
}

/** The identifier fragment before the caret, IntelliJ's completion prefix. */
export function wordBeforeCaret(text: string, offset: number, dialect: DriverId): WordAt {
  const before = text.slice(0, offset);
  const { inString, identAt } = quoteState(before, dialect);
  let start = offset;
  while (start > 0 && WORD_CHAR.test(before[start - 1]!)) start--;
  // a quoted identifier being typed ("Disp or `Order Det) starts at its opening quote
  if (identAt >= 0 && identAt < start) start = identAt;
  return { start, prefix: before.slice(start), inString };
}

/** Indexes of the label characters a prefix matches, or null when it does not match. */
export function matchedIndexes(label: string, prefix: string): number[] | null {
  const needle = prefix.replace(/^["`]/, '').toLowerCase();
  if (!needle) return [];
  const hay = label.toLowerCase();
  if (hay.startsWith(needle)) return range(0, needle.length);
  const humps = wordStartMatch(hay, needle);
  if (humps) return humps;
  const at = hay.indexOf(needle);
  return at >= 0 ? range(at, at + needle.length) : null;
}

/** 0: prefix, 1: word starts ("ci" for customer_id), 2: substring, -1: no match. */
export function matchTier(label: string, prefix: string): number {
  const needle = prefix.replace(/^["`]/, '').toLowerCase();
  if (!needle) return 0;
  const hay = label.toLowerCase();
  if (hay.startsWith(needle)) return 0;
  if (wordStartMatch(hay, needle)) return 1;
  return hay.includes(needle) ? 2 : -1;
}

/** Entries matching the prefix, best matches first, ties broken by the provider's order. */
export function rankEntries(entries: CompletionEntry[], prefix: string): CompletionEntry[] {
  const scored: { entry: CompletionEntry; tier: number }[] = [];
  for (const entry of entries) {
    const tier = matchTier(entry.label, prefix);
    if (tier >= 0) scored.push({ entry, tier });
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier || a.entry.sortText.localeCompare(b.entry.sortText) || a.entry.label.localeCompare(b.entry.label),
  );
  return scored.map((s) => s.entry);
}

export interface Applied {
  text: string;
  caret: number;
}

/** Replace the word being completed with the entry; snippets keep their placeholder text. */
export function applyCompletion(text: string, offset: number, word: WordAt, entry: CompletionEntry): Applied {
  let insert = entry.insertText ?? entry.label;
  let caret: number | undefined;
  if (entry.snippet) {
    let out = '';
    let last = 0;
    for (const match of insert.matchAll(/\$\{(\d+):([^}]*)\}|\$(\d+)/g)) {
      out += insert.slice(last, match.index);
      if (caret === undefined) caret = out.length;
      out += match[2] ?? '';
      last = match.index + match[0].length;
    }
    insert = out + insert.slice(last);
  }
  const before = text.slice(0, word.start);
  return { text: before + insert + text.slice(offset), caret: before.length + (caret ?? insert.length) };
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}

/** Each needle character starts a word of the label or continues the previous match. */
function wordStartMatch(hay: string, needle: string): number[] | null {
  const out: number[] = [];
  let run = false;
  for (let j = 0; j < hay.length && out.length < needle.length; j++) {
    const wordStart = j === 0 || /[_\s.]/.test(hay[j - 1]!);
    if (hay[j] === needle[out.length] && (wordStart || run)) {
      out.push(j);
      run = true;
    } else {
      run = false;
    }
  }
  return out.length === needle.length ? out : null;
}

// ---------------------------------------------------------------------------
// Landing a completion in the editor text
// ---------------------------------------------------------------------------

/** What to insert and how far past the typed word the replacement reaches. */
export interface CompletionReplacement {
  insertText: string;
  /** Characters before the word start the replacement also covers (the opening quote and anything typed inside it). */
  extendStart: number;
  /** Characters after the caret the replacement also covers (a closing quote). */
  extendEnd: number;
  /** Text the editor matches the typed prefix against, when it must differ from the label. */
  filterText?: string;
}

const IDENTIFIER_KINDS: ReadonlySet<string> = new Set(['column', 'table', 'view', 'schema', 'routine']);

/**
 * An identifier completed inside a quote the user already typed keeps that
 * quote: the opening quote (and a closing one right after the caret, which
 * auto-closing leaves behind) joins the replaced range and the name goes in
 * quoted, so `"Prog|"` becomes `"Programs"` rather than `""Programs""`.
 */
export function completionReplacement(
  entry: CompletionEntry,
  before: string,
  after: string,
  dialect: DriverId,
): CompletionReplacement {
  const { identAt } = quoteState(before, dialect);
  const quote = identAt >= 0 ? before[identAt]! : undefined;
  if (!quote || !IDENTIFIER_KINDS.has(entry.kind)) {
    return { insertText: entry.insertText ?? entry.label, extendStart: 0, extendEnd: 0 };
  }
  return {
    insertText: quote + entry.label.replaceAll(quote, quote + quote) + quote,
    extendStart: before.length - identAt,
    extendEnd: after.startsWith(quote) ? 1 : 0,
    filterText: quote + entry.label,
  };
}

