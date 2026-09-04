// The console editor webview: IntelliJ-style toolbar over a Monaco editor.
// Shares the statement splitter, formatter, and inspections with the extension
// host, so the green frame, ⌘⏎ resolution, completion, squiggles, and
// formatting all agree with the host.
import * as monaco from 'monaco-editor/editor/editor.main.js';
import type { CompletionEntry, CompletionKind } from '../complete/core';
import { completionReplacement } from '../complete/match';
import type { DriverId, TxMode } from '../core/types';
import type { Inspection } from '../inspect/core';
import { formatSql } from '../sql/format';
import { splitStatements, statementAt } from '../sql/splitter';
import { showMenu } from './menu';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface ConsoleState {
  dialect: DriverId;
  bindingLabel: string;
  envColor: string | null;
  txMode: TxMode;
  inTx: boolean;
  readOnly: boolean;
  running: boolean;
  canCancel: boolean;
}

const vscode = acquireVsCodeApi();
const el = (id: string) => document.getElementById(id)!;

let state: ConsoleState = {
  dialect: 'postgres',
  bindingLabel: '…',
  envColor: null,
  txMode: 'auto',
  inTx: false,
  readOnly: false,
  running: false,
  canCancel: false,
};
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let suppressEdits = false;

// ------------------------------------------------------------ theme
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function defineThemes(): void {
  const dark = !document.body.classList.contains('vscode-light');
  // IntelliJ New UI syntax colors, per the plan's mock-ups
  const rules: monaco.editor.ITokenThemeRule[] = dark
    ? [
        { token: 'keyword.sql', foreground: 'cf8e6d' },
        { token: 'operator.sql', foreground: 'bcbec4' },
        { token: 'string.sql', foreground: '6aab73' },
        { token: 'string', foreground: '6aab73' },
        { token: 'number', foreground: '2aacb8' },
        { token: 'comment', foreground: '7a7e85' },
        { token: 'predefined.sql', foreground: '56a8f5' },
        { token: 'identifier', foreground: 'bcbec4' },
        { token: 'delimiter', foreground: 'bcbec4' },
      ]
    : [
        { token: 'keyword.sql', foreground: 'b3591c' },
        { token: 'string.sql', foreground: '067d17' },
        { token: 'string', foreground: '067d17' },
        { token: 'number', foreground: '1750eb' },
        { token: 'comment', foreground: '8c8c8c' },
        { token: 'predefined.sql', foreground: '0033b3' },
      ];
  // committed IntelliJ New UI colors, matching the plan mock-ups
  monaco.editor.defineTheme('tablecloth', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules,
    colors: dark
      ? {
          'editor.background': '#1e1f22',
          'editor.foreground': '#bcbec4',
          'editorLineNumber.foreground': '#4b5059',
          'editorLineNumber.activeForeground': '#9da0a8',
          'editor.lineHighlightBackground': '#26282e',
          'editor.selectionBackground': '#214283',
          'editorCursor.foreground': '#ced0d6',
          'editorWidget.background': '#2b2d30',
          'editorWidget.border': '#43454a',
          'editorSuggestWidget.background': '#2b2d30',
          'editorSuggestWidget.border': '#43454a',
          'editorSuggestWidget.selectedBackground': '#2e436e',
          'editorWarning.foreground': '#d6ae58',
          'editorError.foreground': '#f75464',
        }
      : {
          'editor.background': '#ffffff',
          'editor.foreground': '#080808',
          'editorLineNumber.foreground': '#a8adbd',
          'editor.lineHighlightBackground': '#fcfaed',
          'editor.selectionBackground': '#d4e2ff',
        },
  });
}

// ------------------------------------------------------------ worker
async function prepareWorker(): Promise<void> {
  const workerUri = document.body.dataset.worker!;
  const source = await (await fetch(workerUri)).text();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  (globalThis as any).MonacoEnvironment = {
    getWorker: () => new Worker(blobUrl),
  };
}

// ------------------------------------------------------------ statement frame
let frameDecorations: monaco.editor.IEditorDecorationsCollection | undefined;

function updateFrame(): void {
  if (!editor) return;
  const model = editor.getModel();
  if (!model) return;
  const selection = editor.getSelection();
  let startLine: number | undefined;
  let endLine: number | undefined;

  if (selection && !selection.isEmpty()) {
    startLine = selection.startLineNumber;
    endLine = selection.endLineNumber;
    if (endLine > startLine && selection.endColumn === 1) endLine--;
  } else if (selection) {
    const text = model.getValue();
    const offset = model.getOffsetAt(selection.getPosition());
    const stmt = statementAt(splitStatements(text, state.dialect), offset, text);
    if (stmt) {
      startLine = model.getPositionAt(stmt.start).lineNumber;
      endLine = model.getPositionAt(stmt.end).lineNumber;
    }
  }

  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  const whole = (line: number, className: string) => ({
    range: new monaco.Range(line, 1, line, 1),
    options: { isWholeLine: true, className },
  });
  if (startLine !== undefined && endLine !== undefined) {
    if (startLine === endLine) {
      decorations.push(whole(startLine, 'tc-stmt-single'));
    } else {
      decorations.push(whole(startLine, 'tc-stmt-top'));
      for (let line = startLine + 1; line < endLine; line++) decorations.push(whole(line, 'tc-stmt-middle'));
      decorations.push(whole(endLine, 'tc-stmt-bottom'));
    }
  }
  if (!frameDecorations) frameDecorations = editor.createDecorationsCollection(decorations);
  else frameDecorations.set(decorations);
}

// ------------------------------------------------------------ run
function currentSql(): string | null {
  if (!editor) return null;
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return null;
  if (!selection.isEmpty()) {
    const text = model.getValueInRange(selection).trim();
    return text || null;
  }
  const text = model.getValue();
  const offset = model.getOffsetAt(selection.getPosition());
  const stmt = statementAt(splitStatements(text, state.dialect), offset, text);
  return stmt?.sql ?? null;
}

// ------------------------------------------------------------ completion bridge
let completionSeq = 0;
const pendingCompletions = new Map<number, (entries: CompletionEntry[]) => void>();

const COMPLETION_KINDS: Record<CompletionKind, monaco.languages.CompletionItemKind> = {
  column: monaco.languages.CompletionItemKind.Field,
  table: monaco.languages.CompletionItemKind.Struct,
  view: monaco.languages.CompletionItemKind.Interface,
  schema: monaco.languages.CompletionItemKind.Module,
  routine: monaco.languages.CompletionItemKind.Function,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  function: monaco.languages.CompletionItemKind.Function,
  template: monaco.languages.CompletionItemKind.Snippet,
  join: monaco.languages.CompletionItemKind.Reference,
  alias: monaco.languages.CompletionItemKind.Variable,
};

monaco.languages.registerCompletionItemProvider('sql', {
  triggerCharacters: ['.', '"', '`', ' '],
  provideCompletionItems: async (model, position) => {
    const id = ++completionSeq;
    const entries = await new Promise<CompletionEntry[]>((resolve) => {
      pendingCompletions.set(id, resolve);
      vscode.postMessage({
        type: 'completions',
        id,
        text: model.getValue(),
        offset: model.getOffsetAt(position),
      });
      setTimeout(() => {
        if (pendingCompletions.delete(id)) resolve([]);
      }, 2000);
    });
    const word = model.getWordUntilPosition(position);
    const line = model.getLineContent(position.lineNumber);
    const before = line.slice(0, word.startColumn - 1);
    const after = line.slice(position.column - 1);
    return {
      suggestions: entries.map((entry) => {
        // a quote the user already typed (and its auto-closed partner) is part of the replaced range
        const landing = completionReplacement(entry, before, after, state.dialect);
        return {
          label: entry.label,
          kind: COMPLETION_KINDS[entry.kind],
          detail: entry.detail,
          documentation: entry.documentation,
          insertText: landing.insertText,
          insertTextRules: entry.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          sortText: entry.sortText,
          filterText: landing.filterText,
          range: new monaco.Range(
            position.lineNumber,
            word.startColumn - landing.extendStart,
            position.lineNumber,
            word.endColumn + landing.extendEnd,
          ),
        };
      }),
    };
  },
});

// ------------------------------------------------------------ inspections
const MARKER_OWNER = 'tablecloth';
/** Quick fixes by "start:end" offset, for the code action provider. */
let fixes = new Map<string, { title: string; replacement: string }>();

function applyMarkers(markers: Inspection[]): void {
  const model = editor?.getModel();
  if (!model) return;
  fixes = new Map();
  const data: monaco.editor.IMarkerData[] = markers.map((m) => {
    const start = model.getPositionAt(m.start);
    const end = model.getPositionAt(m.end);
    if (m.fix) fixes.set(`${m.start}:${m.end}`, m.fix);
    return {
      severity: m.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      message: m.message,
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
      source: 'Tablecloth',
    };
  });
  monaco.editor.setModelMarkers(model, MARKER_OWNER, data);
}

monaco.languages.registerCodeActionProvider('sql', {
  provideCodeActions: (model, _range, context) => {
    const actions: monaco.languages.CodeAction[] = [];
    for (const marker of context.markers) {
      const start = model.getOffsetAt({ lineNumber: marker.startLineNumber, column: marker.startColumn });
      const end = model.getOffsetAt({ lineNumber: marker.endLineNumber, column: marker.endColumn });
      const fix = fixes.get(`${start}:${end}`);
      if (!fix) continue;
      actions.push({
        title: fix.title,
        kind: 'quickfix',
        diagnostics: [marker],
        isPreferred: true,
        edit: {
          edits: [
            {
              resource: model.uri,
              versionId: model.getVersionId(),
              textEdit: {
                range: new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
                text: fix.replacement,
              },
            },
          ],
        },
      });
    }
    return { actions, dispose: () => undefined };
  },
});

// ------------------------------------------------------------ formatting
monaco.languages.registerDocumentFormattingEditProvider('sql', {
  provideDocumentFormattingEdits: (model) => {
    const text = model.getValue();
    const formatted = formatSql(text, state.dialect);
    if (formatted === text) return [];
    return [{ range: model.getFullModelRange(), text: formatted }];
  },
});

// ------------------------------------------------------------ parameters dialog
function askParameters(msg: { id: number; names: string[]; previous: Record<string, string> }): void {
  const overlay = document.createElement('div');
  overlay.className = 'tc-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'tc-dialog';
  dialog.innerHTML = '<div class="tc-dialog-title">Parameters</div>';
  const body = document.createElement('div');
  body.className = 'tc-dialog-body';
  const table = document.createElement('table');
  table.className = 'params';
  table.innerHTML = '<thead><tr><th>Name</th><th>Value</th><th class="nullcol">NULL</th></tr></thead>';
  const tbody = document.createElement('tbody');
  const inputs = new Map<string, { value: HTMLInputElement; isNull: HTMLInputElement }>();
  for (const name of msg.names) {
    const tr = document.createElement('tr');
    const nameCell = document.createElement('td');
    nameCell.className = 'pname';
    nameCell.textContent = name;
    const valueCell = document.createElement('td');
    const value = document.createElement('input');
    value.type = 'text';
    value.spellcheck = false;
    value.value = msg.previous[name] ?? '';
    valueCell.appendChild(value);
    const nullCell = document.createElement('td');
    nullCell.className = 'nullcol';
    const isNull = document.createElement('input');
    isNull.type = 'checkbox';
    isNull.checked = !(name in msg.previous) && false;
    isNull.addEventListener('change', () => (value.disabled = isNull.checked));
    nullCell.appendChild(isNull);
    tr.append(nameCell, valueCell, nullCell);
    tbody.appendChild(tr);
    inputs.set(name, { value, isNull });
  }
  table.appendChild(tbody);
  body.appendChild(table);
  dialog.appendChild(body);
  const actions = document.createElement('div');
  actions.className = 'tc-dialog-actions';
  const cancel = document.createElement('button');
  cancel.className = 'tc-button';
  cancel.textContent = 'Cancel';
  const ok = document.createElement('button');
  ok.className = 'tc-button primary';
  ok.textContent = 'OK';
  actions.append(cancel, ok);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const finish = (values: Record<string, string | null> | null) => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    vscode.postMessage({ type: 'parameters', id: msg.id, values });
    editor?.focus();
  };
  const submit = () => {
    const values: Record<string, string | null> = {};
    for (const [name, { value, isNull }] of inputs) values[name] = isNull.checked ? null : value.value;
    finish(values);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  };
  document.addEventListener('keydown', onKey, true);
  cancel.addEventListener('click', () => finish(null));
  ok.addEventListener('click', submit);
  const first = inputs.values().next().value;
  setTimeout(() => {
    first?.value.focus();
    first?.value.select();
  }, 0);
}

// ------------------------------------------------------------ toolbar
function renderToolbar(): void {
  el('tx-label').textContent = `Tx: ${state.txMode === 'manual' ? 'Manual' : 'Auto'}${state.inTx ? ' ●' : ''}`;
  el('tb-tx').classList.toggle('warn', state.txMode === 'manual');
  el('tb-commit').hidden = state.txMode !== 'manual';
  el('tb-rollback').hidden = state.txMode !== 'manual';
  el('schema-label').textContent = state.bindingLabel;
  const env = el('schema-env');
  if (state.envColor) {
    env.style.background = state.envColor;
    env.hidden = false;
  } else {
    env.hidden = true;
  }
  el('tb-readonly').hidden = !state.readOnly;
  const stop = el('tb-stop') as HTMLButtonElement;
  stop.disabled = !(state.running && state.canCancel);
  stop.classList.toggle('live', state.running && state.canCancel);
  stop.title = state.canCancel ? 'Cancel running statement (⌘F2)' : 'This database cannot cancel a running statement';
  (el('tb-run') as HTMLButtonElement).classList.toggle('busy', state.running);
}

function wireToolbar(): void {
  el('tb-run').addEventListener('click', () => vscode.postMessage({ type: 'run', sql: currentSql() }));
  el('tb-runscript').addEventListener('click', () => vscode.postMessage({ type: 'runScript' }));
  for (const name of ['settings', 'commit', 'rollback', 'cancel'] as const) {
    const id = name === 'cancel' ? 'tb-stop' : `tb-${name}`;
    el(id).addEventListener('click', () => vscode.postMessage({ type: 'action', name }));
  }
  // dropdowns: the host answers with showMenu, anchored back to the button
  for (const name of ['tx', 'schema', 'history'] as const) {
    el(`tb-${name}`).addEventListener('click', () => vscode.postMessage({ type: 'menu', name }));
  }
}

const MENU_ANCHORS: Record<string, string> = {
  tx: 'tb-tx',
  schema: 'tb-schema',
  schemaDs: 'tb-schema',
  history: 'tb-history',
};

// ------------------------------------------------------------ host messages
let pendingMarkers: Inspection[] | undefined;

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg?.type) {
    case 'init': {
      state = { ...state, ...msg.state };
      renderToolbar();
      const text = String(msg.text ?? '');
      // the editor still opens (degraded) if the worker cannot be prepared
      void prepareWorker()
        .catch(() => undefined)
        .then(() => createEditor(text));
      break;
    }
    case 'setText': {
      const model = editor?.getModel();
      if (!editor || !model) break;
      const text = String(msg.text ?? '');
      if (model.getValue() === text) break;
      suppressEdits = true;
      // full-range push keeps monaco's undo stack alive, unlike setValue
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      suppressEdits = false;
      break;
    }
    case 'state':
      state = { ...state, ...msg.state };
      renderToolbar();
      updateFrame();
      break;
    case 'completions': {
      const resolve = pendingCompletions.get(msg.id);
      if (resolve) {
        pendingCompletions.delete(msg.id);
        resolve(msg.entries ?? []);
      }
      break;
    }
    case 'markers':
      if (editor) applyMarkers(msg.markers ?? []);
      else pendingMarkers = msg.markers ?? [];
      break;
    case 'askParameters':
      askParameters(msg);
      break;
    case 'showMenu': {
      const anchor = el(MENU_ANCHORS[msg.name as string] ?? 'tb-schema');
      showMenu(anchor, {
        items: msg.items ?? [],
        footer: msg.footer,
        filter: !!msg.filter,
        minWidth: msg.name === 'history' ? 340 : 240,
        onPick: (id) => vscode.postMessage({ type: 'menuPick', name: msg.name, id }),
      });
      break;
    }
    case 'insertText': {
      if (!editor) break;
      const selection = editor.getSelection();
      if (!selection) break;
      editor.executeEdits('tablecloth-history', [{ range: selection, text: String(msg.sql ?? '') }]);
      editor.focus();
      break;
    }
  }
});

// ------------------------------------------------------------ editor
function createEditor(initialText: string): void {
  if (editor) return;
  defineThemes();
  editor = monaco.editor.create(el('editor'), {
    value: initialText,
    language: 'sql',
    theme: 'tablecloth',
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: cssVar('--vscode-editor-font-family', 'Menlo, Monaco, monospace'),
    fontSize: Number.parseFloat(cssVar('--vscode-editor-font-size', '12')) || 12,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    wordBasedSuggestions: 'off',
    padding: { top: 6 },
    stickyScroll: { enabled: false },
    fixedOverflowWidgets: true,
    lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode },
    formatOnType: false,
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    vscode.postMessage({ type: 'run', sql: currentSql() });
  });
  // IntelliJ's Reformat Code shortcut, on top of VS Code's Format Document
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL, () => {
    void editor?.getAction('editor.action.formatDocument')?.run();
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F2, () => {
    if (state.running) vscode.postMessage({ type: 'action', name: 'cancel' });
  });

  // Webviews cannot read the OS clipboard directly, so ⌘V round-trips through
  // the host, which answers with insertText.
  const requestPaste = () => vscode.postMessage({ type: 'paste' });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, requestPaste);
  editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Insert, requestPaste);

  const model = editor.getModel()!;
  model.onDidChangeContent(() => {
    if (suppressEdits) return;
    vscode.postMessage({ type: 'edit', text: model.getValue() });
    updateFrame();
  });
  editor.onDidChangeCursorSelection(() => updateFrame());
  updateFrame();
  if (pendingMarkers) {
    applyMarkers(pendingMarkers);
    pendingMarkers = undefined;
  }
  editor.focus();
  vscode.postMessage({ type: 'booted' });
}

wireToolbar();
vscode.postMessage({ type: 'ready' });
