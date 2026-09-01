// The console editor webview: IntelliJ-style toolbar over a Monaco editor.
// Shares the statement splitter with the extension host, so the green frame,
// ⌘⏎ resolution, and completion all agree on statement boundaries.
import * as monaco from 'monaco-editor/editor/editor.main.js';
import type { CompletionEntry, CompletionKind } from '../complete/core';
import type { DriverId, TxMode } from '../core/types';
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
};

monaco.languages.registerCompletionItemProvider('sql', {
  triggerCharacters: ['.', '"', '`'],
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
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    return {
      suggestions: entries.map((entry) => ({
        label: entry.label,
        kind: COMPLETION_KINDS[entry.kind],
        detail: entry.detail,
        insertText: entry.insertText ?? entry.label,
        sortText: entry.sortText,
        range,
      })),
    };
  },
});

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
}

function wireToolbar(): void {
  el('tb-run').addEventListener('click', () => vscode.postMessage({ type: 'run', sql: currentSql() }));
  el('tb-runscript').addEventListener('click', () => vscode.postMessage({ type: 'runScript' }));
  for (const name of ['settings', 'commit', 'rollback'] as const) {
    el(`tb-${name}`).addEventListener('click', () => vscode.postMessage({ type: 'action', name }));
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
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg?.type) {
    case 'init': {
      state = msg.state;
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
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    vscode.postMessage({ type: 'run', sql: currentSql() });
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
  editor.focus();
  vscode.postMessage({ type: 'booted' });
}

wireToolbar();
vscode.postMessage({ type: 'ready' });
