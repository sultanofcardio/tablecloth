import * as vscode from 'vscode';
import type { DriverId } from '../core/types';
import type { DataSourceStore } from '../data/store';
import { formatSql } from '../sql/format';
import type { ConsoleManager } from './consoles';

/**
 * Format SQL in ordinary editors: VS Code's Format Document plus IntelliJ's
 * ⌘⌥L. The console webview formats through the same function inside Monaco.
 */
export function registerFormatting(store: DataSourceStore, consoles: ConsoleManager): vscode.Disposable {
  const dialectFor = (uri: vscode.Uri): DriverId => {
    const binding = consoles.getBinding(uri);
    return (binding && store.get(binding.dataSourceId)?.config.driver) ?? 'postgres';
  };
  const provider: vscode.DocumentFormattingEditProvider = {
    provideDocumentFormattingEdits(document) {
      const text = document.getText();
      const formatted = formatSql(text, dialectFor(document.uri));
      if (formatted === text) return [];
      const full = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
      return [vscode.TextEdit.replace(full, formatted)];
    },
  };
  return vscode.Disposable.from(
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'sql' }, provider),
    vscode.commands.registerCommand('tablecloth.formatSql', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'sql') {
        void vscode.window.showInformationMessage('Open a SQL file or console to format it.');
        return;
      }
      await vscode.commands.executeCommand('editor.action.formatDocument');
    }),
  );
}
