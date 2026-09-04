// Small UI building blocks in the IntelliJ New UI style: a modal dialog, an
// anchored popup, and SQL tinting for the submit preview.
import { ICONS } from './icons';

export const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (name === 'class') node.className = String(value);
    else if (name === 'html') node.innerHTML = String(value);
    else if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export interface DialogAction {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

export interface DialogOptions {
  title: string;
  body: Node;
  actions: DialogAction[];
  width?: number;
  /** Return false to keep the dialog open. */
  onAction(id: string): boolean | void;
}

let openDialog: { root: HTMLElement; close(): void } | undefined;

export function closeDialog(): void {
  openDialog?.close();
}

export function showDialog(options: DialogOptions): void {
  closeDialog();
  const overlay = h('div', { class: 'tc-overlay' });
  const dialog = h('div', { class: 'tc-dialog', role: 'dialog' });
  if (options.width) dialog.style.width = `${options.width}px`;
  dialog.appendChild(h('div', { class: 'tc-dialog-title' }, options.title));
  const body = h('div', { class: 'tc-dialog-body' });
  body.appendChild(options.body);
  dialog.appendChild(body);
  const actions = h('div', { class: 'tc-dialog-actions' });
  let primary: HTMLButtonElement | undefined;
  for (const action of options.actions) {
    const button = h('button', {
      class: 'tc-button' + (action.primary ? ' primary' : '') + (action.danger ? ' danger' : ''),
    });
    button.textContent = action.label;
    button.addEventListener('click', () => {
      if (options.onAction(action.id) !== false) close();
    });
    if (action.primary) primary = button;
    actions.appendChild(button);
  }
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const cancel = options.actions.find((a) => a.id === 'cancel');
      if (!cancel || options.onAction('cancel') !== false) close();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && primary) {
      e.preventDefault();
      primary.click();
    }
  };
  document.addEventListener('keydown', onKey, true);
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (openDialog?.root === overlay) openDialog = undefined;
  };
  openDialog = { root: overlay, close };
  (primary ?? dialog.querySelector('button'))?.focus();
}

export function isDialogOpen(): boolean {
  return openDialog !== undefined;
}

let openPopup: { root: HTMLElement; close(): void } | undefined;

export function closePopup(): void {
  openPopup?.close();
}

/** A popup panel anchored under an element, dismissed by outside clicks or Escape. */
export function showPopup(anchor: HTMLElement, content: HTMLElement, options: { width?: number } = {}): () => void {
  closePopup();
  const popup = h('div', { class: 'tc-popup' });
  if (options.width) popup.style.width = `${options.width}px`;
  popup.appendChild(content);
  document.body.appendChild(popup);

  const rect = anchor.getBoundingClientRect();
  const size = popup.getBoundingClientRect();
  let x = Math.min(rect.left, window.innerWidth - size.width - 8);
  let y = rect.bottom + 4;
  if (y + size.height > window.innerHeight - 8) y = Math.max(8, rect.top - size.height - 4);
  x = Math.max(8, x);
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;

  const onMouse = (e: Event) => {
    if (!popup.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('mousedown', onMouse, true);
  document.addEventListener('keydown', onKey, true);
  const close = () => {
    document.removeEventListener('mousedown', onMouse, true);
    document.removeEventListener('keydown', onKey, true);
    popup.remove();
    if (openPopup?.root === popup) openPopup = undefined;
  };
  openPopup = { root: popup, close };
  return close;
}

const SQL_WORDS = /\b(UPDATE|SET|WHERE|DELETE FROM|INSERT INTO|VALUES|DEFAULT VALUES|AND|OR|IS|NULL|NOT|IN|DEFAULT|TRUE|FALSE|SELECT|FROM|COUNT|LIMIT|OFFSET|ORDER BY|AS|DISTINCT)\b/g;

/** Tint a statement for the preview: strings, numbers, and keywords, like the editor. */
export function highlightSql(sql: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const pieces = sql.split(/('(?:[^']|'')*')/);
  pieces.forEach((piece, i) => {
    if (i % 2 === 1) {
      frag.appendChild(h('span', { class: 'sql-str' }, piece));
      return;
    }
    let last = 0;
    const pattern = new RegExp(`${SQL_WORDS.source}|(-?\\b\\d+(?:\\.\\d+)?\\b)`, 'g');
    for (const match of piece.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (start > last) frag.appendChild(document.createTextNode(piece.slice(last, start)));
      frag.appendChild(h('span', { class: match[1] ? 'sql-kw' : 'sql-num' }, match[0]));
      last = start + match[0].length;
    }
    if (last < piece.length) frag.appendChild(document.createTextNode(piece.slice(last)));
  });
  return frag;
}

export function iconButton(target: HTMLElement, icon: keyof typeof ICONS): void {
  target.innerHTML = ICONS[icon];
}
