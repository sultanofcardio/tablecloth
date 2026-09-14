// The Plan tab of the Tablecloth panel: a query plan as a collapsible tree
// with costs and row estimates, or as a flat table, with the runtime figures
// and a heat bar per node after Explain Analyse.
import type { PanelPlan, PlanNode } from '../../plan/model';
import { ICONS } from './icons';
import { el, h } from './widgets';
import { labelledTip } from '../tooltip';

export interface PlanMessage {
  type: 'plan';
  plan: PanelPlan;
  /** The statement the plan is for: shown above the plan like a result's, and identifies the tab's plan. */
  statement: string | null;
  /** The dialect can produce runtime figures, so the Explain Analyse button is offered. */
  canAnalyse: boolean;
}

type PlanView = 'tree' | 'table';

let current: PlanMessage | undefined;
let view: PlanView = 'tree';
const collapsed = new WeakSet<PlanNode>();
let poster: ((message: unknown) => void) | undefined;

export function initPlanView(post: (message: unknown) => void): void {
  poster = post;
}

function fmtNumber(n: number | undefined, digits = 1): string {
  if (n === undefined) return '';
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Costs span dialects: MariaDB's are fractions of a unit, PostgreSQL's and
 * MySQL's are tens or thousands. Below 1 keep three significant digits, up to
 * 1000 one decimal, above that whole units.
 */
export function fmtCost(n: number | undefined): string {
  if (n === undefined) return '';
  const abs = Math.abs(n);
  if (abs > 0 && abs < 1) return n.toLocaleString('en-US', { maximumSignificantDigits: 3 });
  if (abs < 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtMs(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 0.01) return `${(n * 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })} µs`;
  return `${n.toLocaleString('en-US', { minimumFractionDigits: n < 10 ? 2 : 1, maximumFractionDigits: n < 10 ? 2 : 1 })} ms`;
}

/** Inclusive time of the slowest root, the 100% mark of the heat bars. */
function rootTime(plan: PanelPlan): number {
  return Math.max(0, ...plan.roots.map((r) => r.timeMs ?? 0));
}

export function renderPlan(msg: PlanMessage): void {
  // Explain Analyse replaces the same statement's plan in the same tab, so the
  // Tree/Table choice only resets for a plan of a different statement.
  if (!current || current.statement !== msg.statement) view = 'tree';
  current = msg;
  el('statement').textContent = msg.statement ?? '';
  el('planview').textContent = '';
  draw();
}

function draw(): void {
  const msg = current;
  const root = el('planview');
  const scrollTop = root.querySelector('.plan')?.scrollTop ?? 0;
  root.textContent = '';
  if (!msg) return;
  const plan = msg.plan;

  // toolbar: Tree | Table, and on the right the figures or the analyse button
  const seg = h('span', { class: 'seg' });
  for (const [id, label] of [
    ['tree', 'Tree'],
    ['table', 'Table'],
  ] as const) {
    const btn = h('button', { class: view === id ? 'on' : '' }, label);
    btn.addEventListener('click', () => {
      view = id;
      draw();
    });
    seg.appendChild(btn);
  }
  const tool = h('div', { class: 'ptool' }, seg);
  const right = h('span', { class: 'ptool-r' });
  if (plan.analysed) {
    const parts: string[] = [];
    if (plan.executionMs !== undefined) parts.push(`Total time ${fmtMs(plan.executionMs)}`);
    if (plan.planningMs !== undefined) parts.push(`planning ${fmtMs(plan.planningMs)}`);
    right.textContent = parts.join(' · ');
  } else if (msg.canAnalyse) {
    const btn = h('button', { class: 'ebtn', html: ICONS.play, ...labelledTip('Run the statement and add actual rows and time per node') });
    btn.appendChild(document.createTextNode('Explain Analyse'));
    btn.addEventListener('click', () => poster?.({ type: 'explainAnalyse' }));
    right.appendChild(btn);
  }
  tool.appendChild(right);
  root.appendChild(tool);

  const body = h('div', { class: 'plan' + (plan.analysed ? ' analysed' : '') + (view === 'table' ? ' flat' : '') });
  if (plan.roots.length === 0) {
    body.appendChild(h('div', { class: 'plempty' }, 'The server returned no plan.'));
  } else if (view === 'tree') {
    body.appendChild(treeHeader(plan));
    for (const node of plan.roots) treeRows(body, node, 0, rootTime(plan));
  } else {
    body.appendChild(tableView(plan));
  }
  root.appendChild(body);
  body.scrollTop = scrollTop;
}

// ------------------------------------------------------------ tree

function treeHeader(plan: PanelPlan): HTMLElement {
  const cells = [h('span', {}, 'Operation'), h('span', {}, 'Cost'), h('span', {}, plan.analysed ? 'Actual rows' : 'Rows')];
  if (plan.analysed) cells.push(h('span', {}, 'Time'));
  else cells.push(h('span', {}));
  return h('div', { class: 'plh' }, ...cells);
}

function treeRows(container: HTMLElement, node: PlanNode, depth: number, total: number): void {
  const row = h('div', { class: 'plr' });
  row.style.setProperty('--d', String(depth));
  const op = h('span', { class: 'plop' });
  if (node.children.length > 0) {
    const chev = h('span', { class: 'plchev' + (collapsed.has(node) ? ' closed' : ''), html: ICONS.chevron });
    chev.addEventListener('click', (e) => {
      e.stopPropagation();
      if (collapsed.has(node)) collapsed.delete(node);
      else collapsed.add(node);
      draw();
    });
    op.appendChild(chev);
  } else {
    op.appendChild(h('span', { class: 'plchev none' }));
  }
  op.appendChild(document.createTextNode(node.op));
  if (node.detail) op.appendChild(h('em', { 'data-tip': node.detail }, node.detail));
  const isAnalysed = current?.plan.analysed ?? false;
  row.append(
    op,
    h('span', { class: 'plc' }, fmtCost(node.cost)),
    h('span', { class: 'plc' }, isAnalysed ? fmtNumber(node.actualRows, 0) : fmtNumber(node.rows, 0)),
  );
  if (isAnalysed) {
    const time = h('span', { class: 'pltime' });
    if (node.timeMs !== undefined) {
      const heat = h('span', { class: 'heat', ...labelledTip(fmtMs(node.timeMs)) });
      const share = total > 0 ? Math.max(0.02, Math.min(1, node.timeMs / total)) : 0;
      heat.style.setProperty('--w', `${Math.round(share * 100)}%`);
      time.append(heat, h('span', { class: 'plms' }, fmtMs(node.timeMs)));
    }
    row.appendChild(time);
  } else {
    row.appendChild(h('span', {}));
  }
  row.dataset.tip = node.props.map(([k, v]) => `${k}: ${v}`).join('\n');
  container.appendChild(row);
  if (!collapsed.has(node)) for (const child of node.children) treeRows(container, child, depth + 1, total);
}

// ------------------------------------------------------------ table

function tableView(plan: PanelPlan): HTMLElement {
  const columns: { label: string; cell: (n: PlanNode, depth: number) => string; numeric?: boolean }[] = [
    { label: 'Operation', cell: (n, depth) => `${'  '.repeat(depth)}${n.op}` },
    { label: 'Detail', cell: (n) => n.detail },
    { label: 'Startup cost', cell: (n) => fmtCost(n.startupCost), numeric: true },
    { label: 'Cost', cell: (n) => fmtCost(n.cost), numeric: true },
    { label: 'Rows', cell: (n) => fmtNumber(n.rows, 0), numeric: true },
  ];
  if (plan.analysed) {
    columns.push(
      { label: 'Actual rows', cell: (n) => fmtNumber(n.actualRows, 0), numeric: true },
      { label: 'Time', cell: (n) => fmtMs(n.timeMs), numeric: true },
      { label: 'Loops', cell: (n) => fmtNumber(n.loops, 0), numeric: true },
    );
  }
  const hasStartup = [...walk(plan.roots)].some(({ node }) => node.startupCost !== undefined);
  const shown = columns.filter((c) => c.label !== 'Startup cost' || hasStartup);
  const table = h('table', { class: 'pltable' });
  const head = h('tr', {});
  for (const c of shown) head.appendChild(h('th', { class: c.numeric ? 'num' : '' }, c.label));
  table.appendChild(h('thead', {}, head));
  const tbody = h('tbody', {});
  for (const { node, depth } of walk(plan.roots)) {
    const tr = h('tr', {});
    tr.dataset.tip = node.props.map(([k, v]) => `${k}: ${v}`).join('\n');
    for (const c of shown) tr.appendChild(h('td', { class: c.numeric ? 'num' : '' }, c.cell(node, depth)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function* walk(nodes: PlanNode[], depth = 0): Generator<{ node: PlanNode; depth: number }> {
  for (const node of nodes) {
    yield { node, depth };
    yield* walk(node.children, depth + 1);
  }
}
