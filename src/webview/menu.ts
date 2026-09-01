// Anchored IntelliJ-style popup menu, shared by the explorer, console, and
// panel webviews. Styles live in media/menu.css.

export interface MenuItemButton {
  id: string;
  icon: string;
  tooltip: string;
}

export interface MenuItem {
  id?: string;
  kind?: 'item' | 'separator' | 'header';
  label?: string;
  icon?: string;
  /** Renders the check column: true = ✓, false = aligned blank. */
  check?: boolean;
  description?: string;
  danger?: boolean;
  buttons?: MenuItemButton[];
}

export interface MenuOptions {
  items: MenuItem[];
  footer?: string;
  /** Show a filter input at the top (for long lists like history). */
  filter?: boolean;
  minWidth?: number;
  onPick(id: string): void;
  onButton?(id: string, buttonId: string): void;
}

const MENU_ICONS: Record<string, string> = {
  terminal:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3l-3 3"/><path d="M13 15l3 0"/><path d="M3 4m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5l0 14"/><path d="M5 12l14 0"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h-1a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-1"/><path d="M20.385 6.585a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3l8.385 -8.415z"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/></svg>',
  plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.785 6l8.215 8.215l-2.054 2.054a5.81 5.81 0 1 1 -8.215 -8.215z"/><path d="M4 20l3.5 -3.5"/><path d="M15 4l-3.5 3.5"/><path d="M20 9l-3.5 3.5"/></svg>',
  database:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6m-8 0a8 3 0 1 0 16 0a8 3 0 1 0 -16 0"/><path d="M4 6v6a8 3 0 0 0 16 0v-6"/><path d="M4 12v6a8 3 0 0 0 16 0v-6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5l10 -10"/></svg>',
};

let openMenu: HTMLElement | undefined;
let closeListener: ((e: Event) => void) | undefined;

export function closeMenus(): void {
  openMenu?.remove();
  openMenu = undefined;
  if (closeListener) {
    document.removeEventListener('mousedown', closeListener, true);
    document.removeEventListener('keydown', keyListener, true);
    closeListener = undefined;
  }
}

let keyNav: { items: HTMLElement[]; focused: number } | undefined;

function keyListener(e: KeyboardEvent): void {
  if (!openMenu || !keyNav) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMenus();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const count = keyNav.items.length;
    if (count === 0) return;
    keyNav.focused = (keyNav.focused + delta + count) % count;
    keyNav.items.forEach((el, i) => el.classList.toggle('focused', i === keyNav!.focused));
    keyNav.items[keyNav.focused]!.scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'Enter' && keyNav.focused >= 0) {
    e.preventDefault();
    keyNav.items[keyNav.focused]?.click();
  }
}

/** Show an IntelliJ-style menu anchored below (or above) an element or point. */
export function showMenu(anchor: HTMLElement | { x: number; y: number }, options: MenuOptions): void {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'tc-menu';
  if (options.minWidth) menu.style.minWidth = `${options.minWidth}px`;

  const list = document.createElement('div');
  list.className = 'tc-menu-list';

  const pickables: HTMLElement[] = [];
  const hasChecks = options.items.some((i) => i.check !== undefined);

  const render = (filterText: string) => {
    list.textContent = '';
    pickables.length = 0;
    const filter = filterText.trim().toLowerCase();
    let lastWasContent = false;
    for (const item of options.items) {
      if (item.kind === 'separator') {
        if (!lastWasContent) continue;
        const sep = document.createElement('div');
        sep.className = 'tc-sep';
        list.appendChild(sep);
        lastWasContent = false;
        continue;
      }
      if (item.kind === 'header') {
        const header = document.createElement('div');
        header.className = 'tc-mh';
        header.textContent = item.label ?? '';
        list.appendChild(header);
        lastWasContent = false;
        continue;
      }
      if (filter && !(item.label ?? '').toLowerCase().includes(filter) && !(item.description ?? '').toLowerCase().includes(filter)) {
        continue;
      }
      const row = document.createElement('div');
      row.className = 'tc-mi' + (item.danger ? ' danger' : '');
      if (hasChecks) {
        const check = document.createElement('span');
        check.className = 'tc-check';
        if (item.check) check.innerHTML = MENU_ICONS.check!;
        row.appendChild(check);
      }
      if (item.icon && MENU_ICONS[item.icon]) {
        const icon = document.createElement('span');
        icon.className = 'tc-ic';
        icon.innerHTML = MENU_ICONS[item.icon]!;
        row.appendChild(icon);
      }
      const label = document.createElement('span');
      label.className = 'tc-label';
      label.textContent = item.label ?? '';
      row.appendChild(label);
      if (item.description) {
        const desc = document.createElement('span');
        desc.className = 'tc-desc';
        desc.textContent = item.description;
        row.appendChild(desc);
      }
      for (const button of item.buttons ?? []) {
        const btn = document.createElement('span');
        btn.className = 'tc-btn';
        btn.title = button.tooltip;
        btn.innerHTML = MENU_ICONS[button.icon] ?? '';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeMenus();
          options.onButton?.(item.id ?? '', button.id);
        });
        row.appendChild(btn);
      }
      row.addEventListener('click', () => {
        closeMenus();
        if (item.id) options.onPick(item.id);
      });
      list.appendChild(row);
      pickables.push(row);
      lastWasContent = true;
    }
  };

  if (options.filter) {
    const filterWrap = document.createElement('div');
    filterWrap.className = 'tc-filter';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Type to filter…';
    input.addEventListener('input', () => {
      render(input.value);
      keyNav = { items: pickables.slice(), focused: pickables.length > 0 ? 0 : -1 };
      pickables[0]?.classList.add('focused');
    });
    filterWrap.appendChild(input);
    menu.appendChild(filterWrap);
    setTimeout(() => input.focus(), 0);
  }

  menu.appendChild(list);
  render('');

  if (options.footer) {
    const footer = document.createElement('div');
    footer.className = 'tc-footer';
    footer.textContent = options.footer;
    menu.appendChild(footer);
  }

  document.body.appendChild(menu);
  openMenu = menu;
  keyNav = { items: pickables.slice(), focused: -1 };

  // position: below the anchor, flipped above when it would overflow
  const rect =
    anchor instanceof HTMLElement
      ? anchor.getBoundingClientRect()
      : ({ left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y } as DOMRect);
  const menuRect = menu.getBoundingClientRect();
  let x = Math.min(rect.left, window.innerWidth - menuRect.width - 8);
  let y = rect.bottom + 4;
  if (y + menuRect.height > window.innerHeight - 8) {
    y = Math.max(8, rect.top - menuRect.height - 4);
  }
  x = Math.max(8, x);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  closeListener = (e: Event) => {
    if (!menu.contains(e.target as Node)) closeMenus();
  };
  document.addEventListener('mousedown', closeListener, true);
  document.addEventListener('keydown', keyListener, true);
}
