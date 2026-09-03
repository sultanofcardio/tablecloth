// The Services-window chrome of the Tablecloth panel: the Database > data
// source > console tree, the result tabs with the data source action row, the
// Information view, and the Output log.
import { showMenu, type MenuItem } from '../menu';
import { vendorIconSvg } from '../vendorIcons';
import { ICONS } from './icons';
import { el, h } from './widgets';

export interface ServicesMessage {
  type: 'services';
  tree: {
    dsId: string;
    dsName: string;
    vendor: string;
    envColor: string | null;
    selected: boolean;
    consoles: { key: string; label: string; status: string; active: boolean; running?: boolean }[];
  }[];
  tabs: { id: string; title: string; active: boolean; closable: boolean }[];
  dsActions: string | null;
  error: boolean;
}

export interface OutputEntryDto {
  kind: 'cmd' | 'meta' | 'error';
  prompt?: string;
  text: string;
}

export interface ChromeHandlers {
  post(message: unknown): void;
  /**
   * A switch to another tab, console, or data source is requested. Returns
   * true to proceed now; false when pending edits need a decision first, in
   * which case `proceed` runs if the user discards them.
   */
  beforeSwitch(proceed: () => void): boolean;
  setView(view: 'grid' | 'output' | 'info'): void;
}

let menuAnchor: HTMLElement | undefined;

export function pendingMenuAnchor(): HTMLElement | undefined {
  const anchor = menuAnchor;
  menuAnchor = undefined;
  return anchor;
}

export function renderChrome(msg: ServicesMessage, handlers: ChromeHandlers): void {
  const tabsEl = el('tabs');
  tabsEl.textContent = '';
  tabsEl.hidden = msg.tabs.length === 0;
  for (const tab of msg.tabs) {
    const btn = h('button', { class: 'tab' + (tab.active ? ' on' : ''), title: tab.title }, tab.title);
    btn.addEventListener('click', () => {
      if (tab.active) return;
      const go = () => handlers.post({ type: 'selectTab', id: tab.id });
      if (handlers.beforeSwitch(go)) go();
    });
    if (tab.closable) {
      const x = h('span', { class: 'x' }, '×');
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        const go = () => handlers.post({ type: 'closeTab', id: tab.id });
        if (!tab.active || handlers.beforeSwitch(go)) go();
      });
      btn.appendChild(x);
    }
    tabsEl.appendChild(btn);
  }
  if (msg.dsActions) {
    const actions: { action: string; icon: string; title: string; cls?: string }[] = [
      { action: 'console', icon: ICONS.console, title: 'Query console…' },
      { action: 'properties', icon: ICONS.gear, title: 'Data source properties' },
      { action: 'disconnect', icon: ICONS.power, title: 'Deactivate (disconnect)', cls: 'danger' },
    ];
    for (const a of actions) {
      const btn = h('button', { class: 'tab-action' + (a.cls ? ' ' + a.cls : ''), title: a.title, html: a.icon });
      btn.addEventListener('click', () => {
        if (a.action === 'console') {
          menuAnchor = btn;
          handlers.post({ type: 'dsConsoleMenu', dsId: msg.dsActions });
        } else {
          handlers.post({ type: 'dsAction', action: a.action, dsId: msg.dsActions });
        }
      });
      tabsEl.appendChild(btn);
    }
  }

  const active = msg.tabs.find((t) => t.active);
  if (msg.dsActions) handlers.setView('info');
  else if (msg.error) handlers.setView('grid');
  else if (active) handlers.setView(active.id === '__output' ? 'output' : 'grid');

  const streeEl = el('stree');
  streeEl.textContent = '';
  streeEl.hidden = msg.tree.length === 0;
  if (msg.tree.length === 0) return;
  streeEl.appendChild(h('div', { class: 'srow root', html: ICONS.folder + '<span>Database</span>' }));
  for (const group of msg.tree) {
    const dsRow = h('div', { class: 'srow ds' + (group.selected ? ' sel' : '') });
    if (group.envColor) {
      const dot = h('span', { class: 'envdot' });
      dot.style.background = group.envColor;
      dsRow.appendChild(dot);
    }
    dsRow.appendChild(h('span', { class: 'vendor', html: vendorIconSvg(group.vendor) || ICONS.database }));
    dsRow.appendChild(h('span', {}, group.dsName));
    dsRow.addEventListener('click', () => {
      const go = () => handlers.post({ type: 'selectDataSource', dsId: group.dsId });
      if (handlers.beforeSwitch(go)) go();
    });
    streeEl.appendChild(dsRow);
    for (const con of group.consoles) {
      const row = h('div', { class: 'srow con' + (con.active ? ' sel' : ''), title: 'Double-click to open the console' });
      row.innerHTML = ICONS.console;
      row.appendChild(h('span', { class: 'clabel' }, con.label));
      const meta = h('span', { class: 'smeta' }, con.status);
      row.appendChild(meta);
      if (con.running) {
        const stop = h('button', { class: 'sstop', title: 'Cancel running statement', html: ICONS.stop });
        stop.addEventListener('click', (e) => {
          e.stopPropagation();
          handlers.post({ type: 'cancelConsole', key: con.key });
        });
        row.appendChild(stop);
      }
      row.addEventListener('click', () => {
        if (con.active) return;
        const go = () => handlers.post({ type: 'selectConsole', key: con.key });
        if (handlers.beforeSwitch(go)) go();
      });
      row.addEventListener('dblclick', () => handlers.post({ type: 'openConsole', key: con.key }));
      streeEl.appendChild(row);
    }
  }
}

export function renderInfo(lines: { label: string; value: string; gap?: boolean }[]): void {
  const info = el('infopane');
  info.textContent = '';
  for (const line of lines) {
    if (line.gap) info.appendChild(document.createElement('br'));
    info.appendChild(h('div', {}, h('b', {}, line.label + ': '), line.value));
  }
  if (lines.length === 0) info.textContent = 'No information available.';
}

export function appendOutputLine(entry: OutputEntryDto): void {
  const output = el('output');
  const line = document.createElement('div');
  if (entry.kind === 'cmd') {
    line.appendChild(h('span', { class: 'prompt' }, entry.prompt + '> '));
    line.appendChild(document.createTextNode(entry.text));
  } else {
    line.className = entry.kind === 'error' ? 'err' : 'meta';
    line.textContent = entry.text;
  }
  output.appendChild(line);
  while (output.childElementCount > 1000) output.removeChild(output.firstChild!);
  output.scrollTop = output.scrollHeight;
}

export function resetOutput(entries: OutputEntryDto[]): void {
  el('output').textContent = '';
  for (const entry of entries) appendOutputLine(entry);
}

/** A host-provided anchored menu (the console dropdown on the data source row). */
export function showHostMenu(msg: { dsId: string; items: MenuItem[] }, post: (m: unknown) => void): void {
  const anchor = pendingMenuAnchor() ?? document.body;
  showMenu(anchor, {
    items: msg.items ?? [],
    minWidth: 260,
    onPick: (id) => post({ type: 'menuPick', dsId: msg.dsId, itemId: id }),
    onButton: (id, buttonId) => post({ type: 'menuButton', dsId: msg.dsId, itemId: id, buttonId }),
  });
}
