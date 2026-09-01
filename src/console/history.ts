import * as vscode from 'vscode';
import { truncate } from '../core/util';
import type { MenuItem } from '../webview/menu';

export interface HistoryEntry {
  sql: string;
  dsName: string;
  at: number;
  /** Outcome line: "5 rows in 42 ms", "error: …". */
  note: string;
}

const KEY = 'tablecloth.queryHistory';
const CAP = 200;

function timeAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Executed-statement history, newest first, shared across data sources. */
export class QueryHistory {
  constructor(private readonly memento: vscode.Memento) {}

  list(): HistoryEntry[] {
    return this.memento.get<HistoryEntry[]>(KEY, []);
  }

  /** Entries as anchored-menu DTOs; ids index into list(). */
  menuItems(): MenuItem[] {
    return this.list().map((entry, i) => ({
      id: String(i),
      label: truncate(entry.sql, 60),
      description: `${entry.dsName} · ${timeAgo(entry.at)}`,
    }));
  }

  entryAt(index: number): HistoryEntry | undefined {
    return this.list()[index];
  }

  async record(entry: HistoryEntry): Promise<void> {
    const entries = this.list().filter((e) => !(e.sql === entry.sql && e.dsName === entry.dsName));
    entries.unshift(entry);
    if (entries.length > CAP) entries.length = CAP;
    await this.memento.update(KEY, entries);
  }

  /**
   * Browse history; picking an entry inserts it via `insert` when given, else
   * into the active SQL editor, else onto the clipboard.
   */
  async pick(insert?: (sql: string) => void): Promise<void> {
    const entries = this.list();
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('No queries in the history yet.');
      return;
    }
    const chosen = await vscode.window.showQuickPick(
      entries.map((e) => ({
        label: truncate(e.sql, 90),
        description: `${e.dsName} · ${timeAgo(e.at)}`,
        detail: e.note,
        entry: e,
      })),
      { placeHolder: 'Query history — pick a statement to insert it', matchOnDetail: true },
    );
    if (!chosen) return;

    if (insert) {
      insert(chosen.entry.sql);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'sql') {
      await editor.edit((edit) => edit.insert(editor.selection.active, chosen.entry.sql));
      return;
    }
    await vscode.env.clipboard.writeText(chosen.entry.sql);
    vscode.window.setStatusBarMessage('Tablecloth: statement copied to the clipboard', 4000);
  }
}
