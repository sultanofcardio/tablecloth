// IntelliJ-style completion lookup for a plain text input (the WHERE and
// ORDER BY fields): pops up while an identifier is typed or on ⌃Space,
// narrows by the word before the caret, inserts on Enter, Tab, or click.
import type { CompletionEntry, CompletionKind } from '../../complete/core';
import { applyCompletion, matchedIndexes, rankEntries, wordBeforeCaret, type WordAt } from '../../complete/match';
import { ICONS } from './icons';
import { h } from './widgets';

export interface LookupOptions {
  request(text: string, offset: number): Promise<CompletionEntry[]>;
}

export interface Lookup {
  isOpen(): boolean;
  close(): void;
}

const KIND_ICONS: Partial<Record<CompletionKind, string>> = {
  column: ICONS.column,
  table: ICONS.table,
  view: ICONS.eye,
  schema: ICONS.schema,
  routine: ICONS.func,
  function: ICONS.func,
  join: ICONS.key,
};
const PAGE = 11;
/** Horizontal room the icon column takes, so the labels line up under the typed word. */
const TEXT_INSET = 34;

let measureCanvas: HTMLCanvasElement | undefined;

export function attachLookup(input: HTMLInputElement, options: LookupOptions): Lookup {
  let popup: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  /** Entries from the last host reply, narrowed again on every keystroke. */
  let entries: CompletionEntry[] = [];
  /** Word start the entries were requested for; the popup closes when it moves. */
  let anchorStart = -1;
  let shown: CompletionEntry[] = [];
  let selected = 0;
  let seq = 0;

  const isOpen = () => popup !== null;
  const close = () => {
    popup?.remove();
    popup = null;
    list = null;
    shown = [];
  };
  const caretPos = () => input.selectionStart ?? input.value.length;
  const currentWord = () => wordBeforeCaret(input.value, caretPos());

  const textWidth = (text: string): number => {
    measureCanvas ??= document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d')!;
    const style = getComputedStyle(input);
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return ctx.measureText(text).width;
  };

  const position = () => {
    if (!popup) return;
    const field = input.closest<HTMLElement>('.ffield') ?? input;
    const rect = input.getBoundingClientRect();
    const fieldRect = field.getBoundingClientRect();
    const size = popup.getBoundingClientRect();
    let x = rect.left + textWidth(input.value.slice(0, anchorStart)) - input.scrollLeft - TEXT_INSET;
    x = Math.max(8, Math.min(x, window.innerWidth - size.width - 8));
    let y = fieldRect.bottom + 4;
    if (y + size.height > window.innerHeight - 8) y = Math.max(8, fieldRect.top - size.height - 4);
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
  };

  const select = (index: number) => {
    if (!list || shown.length === 0) return;
    selected = Math.max(0, Math.min(shown.length - 1, index));
    list.querySelectorAll<HTMLElement>('.tc-li').forEach((row, i) => {
      row.classList.toggle('selected', i === selected);
      if (i === selected) row.scrollIntoView({ block: 'nearest' });
    });
  };

  const accept = (index = selected) => {
    const entry = shown[index];
    if (!entry) return;
    const applied = applyCompletion(input.value, caretPos(), currentWord(), entry);
    input.value = applied.text;
    input.setSelectionRange(applied.caret, applied.caret);
    close();
  };

  const labelNode = (entry: CompletionEntry, prefix: string): HTMLElement => {
    const label = h('span', { class: 'tc-li-label' });
    const marks = new Set(matchedIndexes(entry.label, prefix) ?? []);
    let run = '';
    let marked = false;
    const flush = () => {
      if (!run) return;
      label.appendChild(marked ? h('b', {}, run) : document.createTextNode(run));
      run = '';
    };
    for (let i = 0; i < entry.label.length; i++) {
      const isMarked = marks.has(i);
      if (isMarked !== marked) {
        flush();
        marked = isMarked;
      }
      run += entry.label[i];
    }
    flush();
    return label;
  };

  const render = (word: WordAt) => {
    shown = rankEntries(entries, word.prefix);
    if (shown.length === 0) {
      close();
      return;
    }
    if (!popup) {
      popup = h('div', { class: 'tc-lookup', role: 'listbox' });
      list = h('div', { class: 'tc-lookup-list' });
      popup.appendChild(list);
      // the input keeps focus (and its caret) while the mouse is on the popup
      popup.addEventListener('mousedown', (e) => e.preventDefault());
      document.body.appendChild(popup);
    }
    selected = 0;
    list!.textContent = '';
    shown.forEach((entry, i) => {
      const row = h('div', { class: 'tc-li' + (i === 0 ? ' selected' : ''), role: 'option' });
      row.appendChild(h('span', { class: `tc-li-ic ${entry.kind}`, html: KIND_ICONS[entry.kind] ?? '' }));
      row.appendChild(labelNode(entry, word.prefix));
      if (entry.detail) row.appendChild(h('span', { class: 'tc-li-detail' }, entry.detail));
      row.addEventListener('click', () => accept(i));
      list!.appendChild(row);
    });
    position();
  };

  const open = async (explicit: boolean) => {
    const word = currentWord();
    if (word.inString) {
      close();
      return;
    }
    const id = ++seq;
    anchorStart = word.start;
    const result = await options.request(input.value, caretPos());
    // a newer request, a moved caret, or a lost focus all make this reply stale
    if (id !== seq || document.activeElement !== input) return;
    const now = currentWord();
    if (now.start !== anchorStart || (!explicit && !now.prefix && input.value[anchorStart - 1] !== '.')) return;
    entries = result;
    render(now);
  };

  input.addEventListener('input', (e) => {
    const inputType = (e as InputEvent).inputType ?? '';
    const word = currentWord();
    if (word.inString) {
      close();
      return;
    }
    if (isOpen() && word.start === anchorStart && (word.prefix || inputType.startsWith('insert'))) {
      render(word);
      return;
    }
    close();
    if (!inputType.startsWith('insert')) return;
    // typing an identifier character (or a qualifier dot) opens the lookup, like IntelliJ's autopopup
    const typed = input.value[caretPos() - 1] ?? '';
    if (/[A-Za-z_$"`.]/.test(typed)) void open(false);
  });

  input.addEventListener(
    'keydown',
    (e) => {
      if (!isOpen()) {
        if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === ' ' || e.code === 'Space')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          void open(true);
        }
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
          select(selected + 1);
          break;
        case 'ArrowUp':
          select(selected - 1);
          break;
        case 'PageDown':
          select(selected + PAGE);
          break;
        case 'PageUp':
          select(selected - PAGE);
          break;
        case 'Enter':
        case 'Tab':
          accept();
          break;
        case 'Escape':
          close();
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  input.addEventListener('blur', close);
  window.addEventListener('resize', close);
  // the page moving under the popup closes it; the popup's own list scrolling does not
  document.addEventListener(
    'scroll',
    (e) => {
      if (popup && !popup.contains(e.target as Node)) close();
    },
    true,
  );

  return { isOpen, close };
}
