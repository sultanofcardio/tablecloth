// The Database explorer webview: IntelliJ-styled tree with the toolbar row
// under the view header, custom context menus, and lazy introspection.
import type { ExplorerNode, ExplorerRef } from '../ui/explorerModel';
import { closeMenus, showMenu, type MenuItem } from './menu';
import { vendorIconSvg } from './vendorIcons';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): any;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const el = (id: string) => document.getElementById(id)!;

interface PersistedState {
  expanded: string[];
  everSeen: string[];
  selected?: string;
}

const persisted: PersistedState = vscode.getState() ?? { expanded: [], everSeen: [] };
const expanded = new Set<string>(persisted.expanded);
const everSeen = new Set<string>(persisted.everSeen);
let selectedId: string | undefined = persisted.selected;
let tree: ExplorerNode[] = [];
let showSystem = false;
const introspecting = new Set<string>();
/** Anchor for the menu reply currently in flight. */
let menuAnchor: HTMLElement | { x: number; y: number } | undefined;

function saveState(): void {
  vscode.setState({ expanded: [...expanded], everSeen: [...everSeen], selected: selectedId } satisfies PersistedState);
}

// ------------------------------------------------------------ icons
const stroke = (color: string, paths: string, width = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const KEY_PATHS =
  '<path d="M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0z"/><path d="M15 9h.01"/>';

const NODE_ICONS: Record<string, string> = {
  database: stroke('#56a8f5', '<path d="M12 6m-8 0a8 3 0 1 0 16 0a8 3 0 1 0 -16 0"/><path d="M4 6v6a8 3 0 0 0 16 0v-6"/><path d="M4 12v6a8 3 0 0 0 16 0v-6"/>'),
  schema: stroke('#9da0a8', '<path d="M3 15m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M15 15m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M6 15v-1a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v1"/><path d="M12 9l0 3"/>'),
  group: stroke('#548af7', '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/>'),
  table: stroke('#6a9fe0', '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z"/><path d="M3 10h18"/><path d="M10 3v18"/>'),
  view: stroke('#6a9fe0', '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>'),
  column: stroke('#82858c', '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z"/><path d="M10 10h11"/><path d="M10 3v18"/><path d="M9 3l-6 6"/><path d="M10 7l-7 7"/><path d="M10 12l-7 7"/><path d="M10 17l-4 4"/>'),
  pk: stroke('#d5b778', KEY_PATHS),
  fk: stroke('#56a8f5', KEY_PATHS),
  index: stroke('#b189f5', '<path d="M3 9l4 -4l4 4m-4 -4v14"/><path d="M21 15l-4 4l-4 -4m4 4v-14"/>'),
  routine: stroke('#2aacb8', '<path d="M3 19a2 2 0 0 0 2 2c2 0 2 -4 3 -9s1 -9 3 -9a2 2 0 0 1 2 2"/><path d="M5 12h6"/><path d="M15 12l6 6"/><path d="M15 18l6 -6"/>'),
  enum: stroke('#b189f5', '<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M14 8h-4v8h4"/><path d="M10 12h2.5"/>'),
  enumValue: '',
  sequence: stroke('#9da0a8', '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 7v5l3 3"/>'),
  error: stroke('#f75464', '<path d="M12 9v4"/><path d="M12 16v.01"/><path d="M12 3l9 16h-18z"/>'),
};

const CHEVRON = stroke('currentColor', '<path d="M9 6l6 6l-6 6"/>');

// ------------------------------------------------------------ tree rendering
const treeEl = el('tree');

interface FlatRow {
  node: ExplorerNode & { pk?: boolean; fk?: boolean };
  depth: number;
}

function visibleRows(): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (nodes: ExplorerNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.children && expanded.has(node.id)) walk(node.children, depth + 1);
      if (node.lazy && expanded.has(node.id) && introspecting.has(node.ref?.dsId ?? '')) {
        rows.push({ node: { id: `${node.id}:loading`, kind: 'empty', label: 'loading…' }, depth: depth + 1 });
      }
    }
  };
  walk(tree, 0);
  return rows;
}

function isExpandable(node: ExplorerNode): boolean {
  return !!node.lazy || (node.children?.length ?? 0) > 0;
}

function nodeIcon(node: ExplorerNode & { pk?: boolean; fk?: boolean }): string {
  if (node.kind === 'column') return node.pk ? NODE_ICONS.pk! : node.fk ? NODE_ICONS.fk! : NODE_ICONS.column!;
  return NODE_ICONS[node.kind] ?? '';
}

function render(): void {
  treeEl.textContent = '';
  const frag = document.createDocumentFragment();
  for (const { node, depth } of visibleRows()) {
    const row = document.createElement('div');
    row.className = 'trow' + (node.id === selectedId ? ' sel' : '') + (node.kind === 'empty' ? ' dim' : '');
    row.dataset.id = node.id;
    row.style.paddingLeft = `${8 + depth * 16}px`;

    const chevron = document.createElement('span');
    chevron.className = 'chev' + (isExpandable(node) ? (expanded.has(node.id) ? ' open' : '') : ' none');
    if (isExpandable(node)) chevron.innerHTML = CHEVRON;
    row.appendChild(chevron);

    if (node.kind === 'dataSource') {
      const dot = document.createElement('span');
      dot.className = 'envdot' + (node.envColor ? '' : ' none');
      if (node.envColor) dot.style.background = node.envColor;
      row.appendChild(dot);
      const vendor = document.createElement('span');
      vendor.className = 'vendor';
      vendor.innerHTML = vendorIconSvg(node.vendor) || NODE_ICONS.database!;
      row.appendChild(vendor);
    } else {
      const iconHtml = nodeIcon(node);
      if (iconHtml) {
        const icon = document.createElement('span');
        icon.className = 'nicon';
        icon.innerHTML = iconHtml;
        row.appendChild(icon);
      }
    }

    const label = document.createElement('span');
    label.className = 'nlabel';
    label.textContent = node.label;
    row.appendChild(label);

    if (node.chip) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = node.chip;
      row.appendChild(chip);
    }
    if (node.count !== undefined) {
      const count = document.createElement('span');
      count.className = 'ncount';
      count.textContent = String(node.count);
      row.appendChild(count);
    }
    if (node.meta) {
      const meta = document.createElement('span');
      meta.className = 'nmeta';
      meta.textContent = node.meta;
      meta.title = node.meta;
      row.appendChild(meta);
    }
    frag.appendChild(row);
  }
  treeEl.appendChild(frag);
}

// ------------------------------------------------------------ node lookup
function findNode(id: string, nodes: ExplorerNode[] = tree): ExplorerNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inChildren = node.children && findNode(id, node.children);
    if (inChildren) return inChildren;
  }
  return undefined;
}

function findParentId(id: string, nodes: ExplorerNode[] = tree, parent?: string): string | undefined {
  for (const node of nodes) {
    if (node.id === id) return parent;
    const found = node.children && findParentId(id, node.children, node.id);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ------------------------------------------------------------ interactions
function toggle(node: ExplorerNode): void {
  if (!isExpandable(node)) return;
  if (expanded.has(node.id)) {
    expanded.delete(node.id);
  } else {
    expanded.add(node.id);
    if (node.lazy && node.ref) {
      introspecting.add(node.ref.dsId);
      vscode.postMessage({ type: 'introspect', dsId: node.ref.dsId });
    }
  }
  saveState();
  render();
}

function select(id: string | undefined): void {
  selectedId = id;
  saveState();
  render();
  updateToolbar();
}

treeEl.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest('.trow') as HTMLElement | null;
  if (!row) return;
  const node = findNode(row.dataset.id!);
  if (!node || node.kind === 'empty') return;
  select(node.id);
  if ((e.target as HTMLElement).closest('.chev')) {
    toggle(node);
    return;
  }
  if (node.kind === 'table' || node.kind === 'view') {
    vscode.postMessage({ type: 'openTable', ref: node.ref });
    return;
  }
  toggle(node);
});

treeEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const row = (e.target as HTMLElement).closest('.trow') as HTMLElement | null;
  if (!row) return;
  const node = findNode(row.dataset.id!);
  if (!node || node.kind === 'empty') return;
  select(node.id);
  openContextMenu(node, { x: e.clientX, y: e.clientY });
});

function openContextMenu(node: ExplorerNode, at: { x: number; y: number }): void {
  const items: MenuItem[] = [];
  const pick = (action: string) => vscode.postMessage({ type: 'action', name: action, ref: node.ref });
  const handlers = new Map<string, () => void>();
  const add = (id: string, item: Omit<MenuItem, 'id'>, run: () => void) => {
    items.push({ id, ...item });
    handlers.set(id, run);
  };

  if (node.kind === 'dataSource' || node.kind === 'database' || node.kind === 'schema' || node.kind === 'group') {
    add('console', { label: 'Query Console…', icon: 'terminal' }, () => {
      menuAnchor = at;
      vscode.postMessage({ type: 'consoleMenu', ref: node.ref });
    });
    items.push({ kind: 'separator' });
    add('refresh', { label: 'Refresh' }, () => pick('refresh'));
  }
  if (node.kind === 'dataSource') {
    items.push({ kind: 'separator' });
    add('properties', { label: 'Data Source Properties…', icon: 'gear' }, () => pick('properties'));
    add('duplicate', { label: 'Duplicate Data Source' }, () => pick('duplicate'));
    add('remove', { label: 'Remove Data Source…', danger: true }, () => pick('remove'));
    items.push({ kind: 'separator' });
    add('disconnect', { label: 'Disconnect', icon: 'plug' }, () => pick('disconnect'));
  }
  if (node.kind === 'table' || node.kind === 'view') {
    add('open', { label: 'Open Table Data', icon: 'database' }, () =>
      vscode.postMessage({ type: 'openTable', ref: node.ref }),
    );
  }
  if (ddlKind(node)) {
    add('ddl', { label: 'Go to DDL' }, () => vscode.postMessage({ type: 'openDdl', ref: node.ref, kind: ddlKind(node) }));
  }
  if (node.kind === 'table' || (node.kind === 'group' && node.label === 'tables') || node.kind === 'schema' || (node.kind === 'database' && node.ref?.schema === undefined)) {
    items.push({ kind: 'separator' });
    add('import', { label: node.kind === 'table' ? 'Import Data from File…' : 'Import File as New Table…' }, () =>
      vscode.postMessage({ type: 'importData', ref: node.ref }),
    );
  }
  if (node.ref?.name || node.kind === 'table' || node.kind === 'view' || node.kind === 'dataSource') {
    items.push({ kind: 'separator' });
    add('copy', { label: 'Copy Name' }, () => pick('copyName'));
  }

  showMenu(at, { items, onPick: (id) => handlers.get(id)?.() });
}

/** Which DDL a node has, if any. */
function ddlKind(node: ExplorerNode): string | undefined {
  switch (node.kind) {
    case 'table':
    case 'view':
    case 'routine':
    case 'sequence':
    case 'enum':
      return node.kind;
    default:
      return undefined;
  }
}

/** Expand every ancestor of a node so it becomes visible. */
function expandTo(id: string, nodes: ExplorerNode[] = tree, path: string[] = []): boolean {
  for (const node of nodes) {
    if (node.id === id) {
      for (const ancestor of path) expanded.add(ancestor);
      return true;
    }
    if (node.children && expandTo(id, node.children, [...path, node.id])) return true;
  }
  return false;
}

// keyboard navigation over visible rows
treeEl.tabIndex = 0;
treeEl.addEventListener('keydown', (e) => {
  const rows = visibleRows().filter((r) => r.node.kind !== 'empty');
  const index = rows.findIndex((r) => r.node.id === selectedId);
  const selectAt = (i: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, i));
    select(rows[clamped]?.node.id);
    treeEl.querySelector('.trow.sel')?.scrollIntoView({ block: 'nearest' });
  };
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      selectAt(index + 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      selectAt(index - 1);
      break;
    case 'ArrowRight': {
      e.preventDefault();
      const node = selectedId ? findNode(selectedId) : undefined;
      if (node && isExpandable(node) && !expanded.has(node.id)) toggle(node);
      else selectAt(index + 1);
      break;
    }
    case 'ArrowLeft': {
      e.preventDefault();
      const node = selectedId ? findNode(selectedId) : undefined;
      if (node && expanded.has(node.id)) toggle(node);
      else if (selectedId) {
        const parent = findParentId(selectedId);
        if (parent) select(parent);
      }
      break;
    }
    case 'Enter': {
      e.preventDefault();
      const node = selectedId ? findNode(selectedId) : undefined;
      if (!node) break;
      if (node.kind === 'table' || node.kind === 'view') vscode.postMessage({ type: 'openTable', ref: node.ref });
      else toggle(node);
      break;
    }
  }
});

// ------------------------------------------------------------ toolbar
function selectedRef(): ExplorerRef | undefined {
  return selectedId ? findNode(selectedId)?.ref : undefined;
}

function updateToolbar(): void {
  const node = selectedId ? findNode(selectedId) : undefined;
  (el('tb-table') as HTMLButtonElement).disabled = !(node && (node.kind === 'table' || node.kind === 'view'));
  (el('tb-ddl') as HTMLButtonElement).disabled = !(node && ddlKind(node));
  el('tb-eye').classList.toggle('active', showSystem);
}

el('tb-add').addEventListener('click', () => vscode.postMessage({ type: 'action', name: 'addDataSource' }));
el('tb-props').addEventListener('click', () =>
  vscode.postMessage({ type: 'action', name: 'properties', ref: selectedRef() }),
);
el('tb-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh', dsId: selectedRef()?.dsId }));
el('tb-console').addEventListener('click', () => {
  menuAnchor = el('tb-console');
  vscode.postMessage({ type: 'consoleMenu', ref: selectedRef() });
});
el('tb-table').addEventListener('click', () => {
  const node = selectedId ? findNode(selectedId) : undefined;
  if (node && (node.kind === 'table' || node.kind === 'view')) {
    vscode.postMessage({ type: 'openTable', ref: node.ref });
  }
});
el('tb-eye').addEventListener('click', () => vscode.postMessage({ type: 'action', name: 'toggleSystem' }));
el('tb-ddl').addEventListener('click', () => {
  const node = selectedId ? findNode(selectedId) : undefined;
  if (node && ddlKind(node)) vscode.postMessage({ type: 'openDdl', ref: node.ref, kind: ddlKind(node) });
});

// ------------------------------------------------------------ host messages
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg?.type) {
    case 'tree': {
      tree = msg.nodes ?? [];
      showSystem = !!msg.showSystem;
      introspecting.clear();
      // first sight of a container auto-expands it, then the user's choices stick
      const autoExpand = (nodes: ExplorerNode[]) => {
        for (const node of nodes) {
          const container = node.kind === 'dataSource' || node.kind === 'database' || node.kind === 'schema';
          if (container && !everSeen.has(node.id)) {
            everSeen.add(node.id);
            if (node.children?.length) expanded.add(node.id);
          }
          if (node.children) autoExpand(node.children);
        }
      };
      autoExpand(tree);
      if (msg.expandAll) {
        // screenshot rig: open containers and groups; '1' opens every relation
        // too, any other value opens only the relation with that label
        const only = String(msg.expandAll);
        const expandDeep = (nodes: ExplorerNode[]) => {
          for (const node of nodes) {
            if (!node.children?.length) continue;
            const relation = node.kind === 'table' || node.kind === 'view' || node.kind === 'enum';
            if (!relation || only === '1' || node.label === only) expanded.add(node.id);
            expandDeep(node.children);
          }
        };
        expandDeep(tree);
      }
      saveState();
      render();
      updateToolbar();
      break;
    }
    case 'menu': {
      const anchor = menuAnchor ?? el('tb-console');
      menuAnchor = undefined;
      showMenu(anchor, {
        items: msg.items ?? [],
        footer: msg.footer,
        filter: !!msg.filter,
        minWidth: 260,
        onPick: (id) => vscode.postMessage({ type: 'menuPick', menuId: msg.menuId, itemId: id }),
        onButton: (id, buttonId) =>
          vscode.postMessage({ type: 'menuButton', menuId: msg.menuId, itemId: id, buttonId }),
      });
      break;
    }
    case 'closeMenus':
      closeMenus();
      break;
    case 'reveal': {
      const id = String(msg.id ?? '');
      if (expandTo(id)) {
        select(id);
        treeEl.querySelector('.trow.sel')?.scrollIntoView({ block: 'center' });
      }
      break;
    }
  }
});

vscode.postMessage({ type: 'ready' });
