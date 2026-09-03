// The Import Data dialog webview: format settings, the column mapping table,
// a preview of the first rows, and progress while the host runs the inserts.
import { duplicateTarget } from '../import/infer';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface ColumnInfo {
  header: string;
  sample: string;
  inferred: string;
  suggestedName: string;
  suggestedType: string;
  target: string | null;
}

interface Analysis {
  fileName: string;
  dialect: string;
  mode: 'existing' | 'create';
  targetLabel: string;
  defaultTableName: string;
  settings: { delimiter: string; quote: string; hasHeader: boolean; trim: boolean; nullText: string };
  delimiters: { id: string; label: string; char: string }[];
  tableColumns: { name: string; dataType: string }[];
  columns: ColumnInfo[];
  rows: string[][];
  totalRows: number;
  types: { id: string; sql: string }[];
}

let analysis: Analysis | undefined;
let importing = false;

function settings() {
  return {
    delimiter: el<HTMLSelectElement>('f-delimiter').value,
    quote: el<HTMLSelectElement>('f-quote').value,
    hasHeader: el<HTMLInputElement>('f-header').checked,
    trim: el<HTMLInputElement>('f-trim').checked,
    nullText: el<HTMLInputElement>('f-null').value,
  };
}

function renderSettings(a: Analysis): void {
  const delimiter = el<HTMLSelectElement>('f-delimiter');
  if (delimiter.options.length === 0) {
    for (const d of a.delimiters) {
      const option = document.createElement('option');
      option.value = d.char;
      option.textContent = d.label;
      delimiter.appendChild(option);
    }
  }
  delimiter.value = a.settings.delimiter;
  el<HTMLSelectElement>('f-quote').value = a.settings.quote;
  el<HTMLInputElement>('f-header').checked = a.settings.hasHeader;
  el<HTMLInputElement>('f-trim').checked = a.settings.trim;
  el<HTMLInputElement>('f-null').value = a.settings.nullText;
}

function renderMapping(a: Analysis): void {
  el('title').textContent =
    a.mode === 'existing' ? `Import "${a.fileName}" into ${a.targetLabel}` : `Import "${a.fileName}" as a new table in ${a.targetLabel}`;
  el('h-target').textContent = a.mode === 'existing' ? 'Table column' : 'Column name';
  el('l-table').hidden = a.mode !== 'create';
  const tableName = el<HTMLInputElement>('f-table');
  tableName.hidden = a.mode !== 'create';
  if (!tableName.value) tableName.value = a.defaultTableName;

  const body = el('map-body');
  body.textContent = '';
  a.columns.forEach((column, i) => {
    const tr = document.createElement('tr');
    tr.dataset.source = String(i);
    const source = document.createElement('td');
    source.textContent = column.header;
    tr.appendChild(source);
    const arrow = document.createElement('td');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    tr.appendChild(arrow);

    const targetCell = document.createElement('td');
    const typeCell = document.createElement('td');
    typeCell.className = 'dim';
    if (a.mode === 'existing') {
      const select = document.createElement('select');
      select.className = 'target';
      const skip = document.createElement('option');
      skip.value = '';
      skip.textContent = 'skip';
      select.appendChild(skip);
      for (const tc of a.tableColumns) {
        const option = document.createElement('option');
        option.value = tc.name;
        option.textContent = tc.name;
        select.appendChild(option);
      }
      select.value = column.target ?? '';
      const syncType = () => {
        const tc = a.tableColumns.find((c) => c.name === select.value);
        typeCell.textContent = tc ? tc.dataType : '-';
        tr.classList.toggle('skipped', !select.value);
        updateSummary();
      };
      select.addEventListener('change', syncType);
      targetCell.appendChild(select);
      syncType();
    } else {
      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'target';
      name.value = column.suggestedName;
      name.spellcheck = false;
      name.addEventListener('input', () => {
        tr.classList.toggle('skipped', !name.value.trim());
        updateSummary();
      });
      targetCell.appendChild(name);
      const type = document.createElement('select');
      type.className = 'ctype';
      for (const t of a.types) {
        const option = document.createElement('option');
        option.value = t.id;
        option.textContent = t.sql;
        type.appendChild(option);
      }
      type.value = column.inferred;
      typeCell.className = '';
      typeCell.appendChild(type);
    }
    tr.appendChild(targetCell);
    tr.appendChild(typeCell);
    const sample = document.createElement('td');
    sample.className = 'dim sample';
    sample.textContent = column.sample;
    sample.title = column.sample;
    tr.appendChild(sample);
    body.appendChild(tr);
  });
  updateSummary();
  if (!el('preview').hidden) renderPreview(a);
}

function mappedColumns() {
  const a = analysis!;
  const out: { source: number; target: string; sqlType?: string; inferred?: string }[] = [];
  for (const tr of el('map-body').querySelectorAll<HTMLTableRowElement>('tr')) {
    const source = Number(tr.dataset.source);
    const targetEl = tr.querySelector<HTMLInputElement | HTMLSelectElement>('.target')!;
    const target = targetEl.value.trim();
    if (!target) continue;
    if (a.mode === 'create') {
      const type = tr.querySelector<HTMLSelectElement>('.ctype')!.value;
      out.push({ source, target, sqlType: a.types.find((t) => t.id === type)?.sql ?? 'text', inferred: type });
    } else {
      out.push({ source, target });
    }
  }
  return out;
}

function updateSummary(): void {
  const a = analysis;
  if (!a) return;
  const mapped = mappedColumns();
  const duplicate = duplicateTarget(mapped);
  const rows = a.totalRows.toLocaleString();
  el('summary').textContent = duplicate
    ? `Column "${duplicate}" is mapped more than once`
    : `${a.settings.hasHeader ? 'First row is header' : 'No header row'} · ${rows} data rows · ${mapped.length} of ${a.columns.length} columns mapped`;
  el('summary').classList.toggle('err', !!duplicate);
  el('b-import').textContent = `Import ${rows} rows`;
  (el('b-import') as HTMLButtonElement).disabled = importing || mapped.length === 0 || !!duplicate;
}

function renderPreview(a: Analysis): void {
  const head = el('preview-head');
  const body = el('preview-body');
  head.textContent = '';
  body.textContent = '';
  const mapped = mappedColumns();
  const gutter = document.createElement('th');
  gutter.className = 'gut';
  head.appendChild(gutter);
  for (const m of mapped) {
    const th = document.createElement('th');
    th.textContent = m.target;
    head.appendChild(th);
  }
  a.rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    const gut = document.createElement('td');
    gut.className = 'gut';
    gut.textContent = String(i + 1);
    tr.appendChild(gut);
    for (const m of mapped) {
      const td = document.createElement('td');
      const value = row[m.source] ?? '';
      td.textContent = value;
      if (value === '') td.className = 'null';
      tr.appendChild(td);
    }
    body.appendChild(tr);
  });
}

for (const id of ['f-delimiter', 'f-quote', 'f-header', 'f-trim', 'f-null']) {
  el(id).addEventListener('change', () => vscode.postMessage({ type: 'reparse', settings: settings() }));
}
el('b-preview').addEventListener('click', () => {
  const preview = el('preview');
  preview.hidden = !preview.hidden;
  el('b-preview').textContent = preview.hidden ? 'Preview 10 rows' : 'Hide preview';
  if (!preview.hidden && analysis) renderPreview(analysis);
});
el('b-cancel').addEventListener('click', () => vscode.postMessage({ type: importing ? 'cancelImport' : 'close' }));
el('b-import').addEventListener('click', () => {
  const a = analysis;
  if (!a || importing) return;
  const request = {
    settings: settings(),
    nullText: el<HTMLInputElement>('f-null').value,
    emptyAsNull: el<HTMLInputElement>('f-empty').checked,
    onError: el<HTMLSelectElement>('f-onerror').value,
    mode: a.mode,
    tableName: el<HTMLInputElement>('f-table').value,
    columns: mappedColumns(),
  };
  importing = true;
  el('result').hidden = true;
  el('progress').hidden = false;
  el('progress-text').textContent = 'Starting…';
  el('b-cancel').textContent = 'Stop';
  updateSummary();
  vscode.postMessage({ type: 'import', request });
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg?.type) {
    case 'init':
    case 'parsed': {
      analysis = msg as Analysis;
      renderSettings(analysis);
      renderMapping(analysis);
      break;
    }
    case 'progress': {
      const pct = msg.total > 0 ? Math.round((msg.done / msg.total) * 100) : 100;
      el('bar-fill').style.width = `${pct}%`;
      el('progress-text').textContent = `${Number(msg.done).toLocaleString()} of ${Number(msg.total).toLocaleString()} rows`;
      break;
    }
    case 'done': {
      importing = false;
      el('progress').hidden = true;
      const result = el('result');
      result.hidden = false;
      result.className = 'result ' + (msg.ok ? 'ok' : 'fail');
      result.textContent = (msg.ok ? '✓ ' : '✗ ') + msg.message;
      el('b-cancel').textContent = msg.ok ? 'Close' : 'Cancel';
      el('b-import').textContent = msg.ok ? 'Import again' : 'Retry';
      updateSummary();
      break;
    }
  }
});

vscode.postMessage({ type: 'ready' });
