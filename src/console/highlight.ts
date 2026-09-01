import * as vscode from 'vscode';
import type { DataSourceStore } from '../data/store';
import { splitStatements, statementAt } from '../sql/splitter';
import type { ConsoleManager } from './consoles';

const BORDER = 'rgba(87, 150, 92, 0.85)';

function decoration(borderWidth: string, borderRadius?: string): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: 'solid',
    borderColor: BORDER,
    borderWidth,
    ...(borderRadius ? { borderRadius } : {}),
  });
}

/**
 * The IntelliJ green frame around whatever ⌘⏎ would run: the selection when
 * there is one, else the statement under the caret. Drawn with whole-line
 * border decorations (top edge, sides, bottom edge).
 */
export class StatementHighlighter implements vscode.Disposable {
  private readonly single = decoration('1px', '3px');
  private readonly top = decoration('1px 1px 0 1px', '3px 3px 0 0');
  private readonly middle = decoration('0 1px 0 1px');
  private readonly bottom = decoration('0 1px 1px 1px', '0 0 3px 3px');
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly consoles: ConsoleManager,
    private readonly store: DataSourceStore,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.refresh(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((editor) => editor && this.refresh(editor)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === e.document) this.refresh(editor);
      }),
    );
    if (vscode.window.activeTextEditor) this.refresh(vscode.window.activeTextEditor);
  }

  dispose(): void {
    for (const d of [...this.disposables, this.single, this.top, this.middle, this.bottom]) d.dispose();
  }

  private clear(editor: vscode.TextEditor): void {
    for (const type of [this.single, this.top, this.middle, this.bottom]) {
      editor.setDecorations(type, []);
    }
  }

  refresh(editor: vscode.TextEditor): void {
    if (editor.document.languageId !== 'sql') return;
    const binding = this.consoles.getBinding(editor.document.uri);
    const ds = binding ? this.store.get(binding.dataSourceId) : undefined;
    if (!ds) {
      this.clear(editor);
      return;
    }

    let startLine: number;
    let endLine: number;
    if (!editor.selection.isEmpty) {
      startLine = editor.selection.start.line;
      endLine = editor.selection.end.line;
      // a selection ending at column 0 does not include that line
      if (endLine > startLine && editor.selection.end.character === 0) endLine--;
    } else {
      const text = editor.document.getText();
      const statements = splitStatements(text, ds.config.driver);
      const stmt = statementAt(statements, editor.document.offsetAt(editor.selection.active), text);
      if (!stmt) {
        this.clear(editor);
        return;
      }
      startLine = editor.document.positionAt(stmt.start).line;
      endLine = editor.document.positionAt(stmt.end).line;
    }

    const lineRange = (line: number) => editor.document.lineAt(line).range;
    if (startLine === endLine) {
      editor.setDecorations(this.single, [lineRange(startLine)]);
      editor.setDecorations(this.top, []);
      editor.setDecorations(this.middle, []);
      editor.setDecorations(this.bottom, []);
      return;
    }
    editor.setDecorations(this.single, []);
    editor.setDecorations(this.top, [lineRange(startLine)]);
    editor.setDecorations(
      this.middle,
      endLine - startLine > 1 ? [new vscode.Range(startLine + 1, 0, endLine - 1, 0)] : [],
    );
    editor.setDecorations(this.bottom, [lineRange(endLine)]);
  }
}
